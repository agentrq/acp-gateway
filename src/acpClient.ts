/**
 * acpClient.ts
 *
 * Implements the ACP Client interface for the agentrq workspace.
 * Routes permission requests to the MCP server.
 */

import * as acp from "@agentclientprotocol/sdk";
import type { MCPBridge } from "./mcpClient.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Identifies a tool call routed through an agentrq MCP server. */
const AGENTRQ_TOOL_PATTERN = /agentrq-[a-zA-Z0-9]{11}/;

/**
 * What a turn ending in anything but `end_turn` means, in the human's terms.
 *
 * Without this the workspace sees the agent's partial answer and nothing else,
 * so a refused or truncated turn is indistinguishable from a finished one.
 */
/**
 * How long a tool call waits for a human before the turn is given up on.
 *
 * Humans are slow — this is not a network timeout — but it must exist: a wait
 * with no end holds a task-queue slot for the life of the process, and at low
 * concurrency one unanswered approval is enough to stop the workspace.
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;

/** A permission request that has been sent to agentrq and has no verdict yet. */
interface PendingPermission {
  /** Exactly what was sent, kept so it can be re-sent if the session changes. */
  payload: Record<string, unknown>;
  sessionId?: string;
  options: acp.PermissionOption[];
  /** Answers the agent once, and forgets the request. */
  settle: (outcome: acp.RequestPermissionOutcome) => void;
}

const STOP_REASON_NOTES: Record<string, string> = {
  refusal: "⚠️ The agent refused to continue this turn.",
  max_tokens: "⚠️ The agent stopped mid-turn: it ran out of output tokens.",
  max_turn_requests:
    "⚠️ The agent stopped mid-turn: it reached its limit on model requests for a single turn.",
  cancelled: "⚠️ The turn was cancelled before the agent finished.",
};

export class AgentRQACPClient implements acp.Client {
  private replyBuffers = new Map<string, string>();
  // chatId → text sent by the agent via the reply MCP tool (for dedup in flushReply)
  private agentReplies = new Map<string, string>();
  // toolCallId → details seen on session updates. A `tool_call` update always
  // carries a title, but the permission request for that same call may omit it
  // (ACP marks it optional there, and codex-acp sends it bare), which would
  // otherwise leave us unable to tell an agentrq MCP call from anything else.
  private toolCallDetails = new Map<string, { title?: string; rawInput?: unknown }>();

  // request_id → the tool call waiting on a human. One shared verdict listener
  // serves them all: a listener per request was only ever removed on a matching
  // verdict, so every unanswered request leaked one for the life of the process.
  private pendingPermissions = new Map<string, PendingPermission>();
  private permissionTimeoutMs: number;
  private cancelSession?: (sessionId: string) => unknown;
  private onModeChanged?: (sessionId: string, modeId: string) => unknown;

  constructor(
    private mcpBridge: MCPBridge,
    private getTaskIdForSession: (sessionId: string) => string | undefined = () => undefined,
    options: { permissionTimeoutMs?: number } = {},
  ) {
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.mcpBridge.on("verdict", this.onVerdict);
    this.mcpBridge.on("reconnected", this.onWorkspaceReconnected);
  }

  /**
   * Supplies what to do when the agent changes its own session mode.
   *
   * The gateway pins a mode that routes approvals to the human at session
   * creation, but agents may switch modes on their own — and back into one
   * that approves on the user's behalf.
   */
  setModeChangeHandler(handler: (sessionId: string, modeId: string) => unknown): void {
    this.onModeChanged = handler;
  }

  /** How many tool calls are waiting on a human right now. */
  get pendingPermissionCount(): number {
    return this.pendingPermissions.size;
  }

  /**
   * Supplies the way to stop a turn, which only exists once the agent
   * connection has been built around this client.
   */
  setSessionCanceller(cancel: (sessionId: string) => unknown): void {
    this.cancelSession = cancel;
  }

  /**
   * Answers every waiting tool call with `cancelled`.
   *
   * Used when the agent is gone: nothing will ever act on those answers, but
   * the promises must settle or their task-queue slots are held forever.
   */
  cancelPendingPermissions(reason: string): void {
    if (this.pendingPermissions.size === 0) return;
    console.error(
      `[acp] Cancelling ${this.pendingPermissions.size} waiting permission request(s): ${reason}`,
    );
    for (const pending of [...this.pendingPermissions.values()]) {
      pending.settle({ outcome: "cancelled" });
    }
  }

  /**
   * Re-sends everything still waiting, after the workspace connection was
   * re-established on a new session.
   *
   * A verdict is routed back to the session its request arrived on, so a
   * request that was in flight across a reconnect can never be answered. The
   * request id stays the same, which is what lets the workspace recognise this
   * as the same pending decision rather than a new one to ask about again.
   */
  private onWorkspaceReconnected = (): void => {
    if (this.pendingPermissions.size === 0) return;
    console.error(
      `[acp] Workspace reconnected — re-sending ${this.pendingPermissions.size} ` +
        `permission request(s) that would otherwise never be answered`,
    );
    for (const pending of this.pendingPermissions.values()) {
      void this.mcpBridge
        .sendNotification("notifications/claude/channel/permission_request", pending.payload)
        .catch((err) => {
          console.error(
            `[acp] Failed to re-send permission request ${pending.payload.request_id}:`,
            err,
          );
        });
    }
  };

  /** Delivers a verdict to whichever tool call is waiting on it, if any. */
  private onVerdict = (data: { requestId: string; behavior: string }): void => {
    const pending = this.pendingPermissions.get(data.requestId);
    if (!pending) {
      console.error(`[acp] Verdict for ${data.requestId} arrived with nothing waiting on it`);
      return;
    }
    console.error(`✅ Permission verdict received: ${data.behavior}`);
    pending.settle(this.outcomeForVerdict(pending.options, data.behavior));
  };

  /** Stops the agent's current turn, where there is a connection to stop it on. */
  private async cancelTurn(sessionId: string | undefined): Promise<void> {
    if (!sessionId || !this.cancelSession) return;
    try {
      await this.cancelSession(sessionId);
    } catch (err) {
      console.error(`[acp] Failed to cancel turn for session ${sessionId}:`, err);
    }
  }

  async flushReply(sessionId: string): Promise<void> {
    const text = this.replyBuffers.get(sessionId) ?? "";
    this.replyBuffers.delete(sessionId);
    if (!text.trim()) return;

    const taskId = this.getTaskIdForSession(sessionId);
    if (!taskId) {
      console.error(`[acp] No task ID for session ${sessionId}, skipping reply`);
      return;
    }

    const agentReplyText = this.agentReplies.get(taskId);
    this.agentReplies.delete(taskId);
    if (agentReplyText !== undefined && agentReplyText === text) {
      console.error(`[acp] Skipping reply to task ${taskId} — agent already sent identical reply`);
      return;
    }

    try {
      await this.mcpBridge.callTool("reply", { chatId: taskId, text });
      console.error(`[acp] Forwarded agent reply to task ${taskId}`);
    } catch (err) {
      console.error(`[acp] Failed to forward reply to task ${taskId}:`, err);
    }
  }

  /**
   * Tells the workspace when a turn ended for any reason other than the agent
   * finishing what it was asked. Call after flushReply, so the note follows
   * whatever the agent did manage to say.
   */
  async reportStopReason(sessionId: string, stopReason: string): Promise<void> {
    if (stopReason === "end_turn") return;

    const taskId = this.getTaskIdForSession(sessionId);
    if (!taskId) {
      console.error(`[acp] No task ID for session ${sessionId}, not reporting "${stopReason}"`);
      return;
    }

    const text =
      STOP_REASON_NOTES[stopReason] ??
      `⚠️ The agent stopped for a reason this gateway does not recognise: ${stopReason}.`;

    try {
      await this.mcpBridge.callTool("reply", { chatId: taskId, text });
      console.error(`[acp] Reported stop reason "${stopReason}" to task ${taskId}`);
    } catch (err) {
      console.error(`[acp] Failed to report stop reason to task ${taskId}:`, err);
    }
  }

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const toolCallId = params.toolCall.toolCallId;
    // Fall back to what the earlier session update reported for this same tool
    // call: the permission request itself may carry no title or input.
    const remembered = this.toolCallDetails.get(toolCallId);
    this.toolCallDetails.delete(toolCallId);
    const toolTitle = params.toolCall.title ?? remembered?.title ?? "Unknown Tool";
    const rawInput = params.toolCall.rawInput ?? remembered?.rawInput;

    // Auto-allow tool calls that contain the pattern: agentrq-<11 chars a-zA-Z0-9>
    if (AGENTRQ_TOOL_PATTERN.test(toolTitle)) {
      console.error(`\n🔓 ACP Auto-allowing tool call: ${toolTitle} (ID: ${toolCallId})`);
      const option = params.options.find(o =>
        o.kind.startsWith("allow") ||
        o.name.toLowerCase().includes("allow") ||
        o.name.toLowerCase().includes("yes") ||
        o.name.toLowerCase().includes("approve")
      );
      const optionId = option?.optionId ?? params.options[0].optionId;
      return {
        outcome: {
          outcome: "selected",
          optionId: optionId,
        },
      };
    }

    console.error(`\n🔐 ACP Permission requested: ${toolTitle} (ID: ${toolCallId})`);

    const sessionId = params.sessionId as string | undefined;
    // agentrq keys its own bookkeeping on the request id alone, across the whole
    // workspace. Tool call ids are only unique within a session, and agents
    // commonly number them from one, so two tasks running at once could
    // otherwise have a verdict land on the wrong tool call.
    const requestId = sessionId ? `${sessionId}:${toolCallId}` : toolCallId;
    const taskId = sessionId ? this.getTaskIdForSession(sessionId) : undefined;
    const payload = {
      request_id: requestId,
      task_id: taskId,
      tool_name: toolTitle,
      description: toolTitle,
      input_preview: JSON.stringify(rawInput ?? {}),
    };
    console.error(`[acp] Bridge Session ID: ${this.mcpBridge.getSessionId() ?? "unknown"}`);
    console.error(`[acp] Sending permission request notification:`, JSON.stringify(payload, null, 2));

    // 1. Forward the permission request to the MCP server as a notification.
    //    If the MCP transport is down (e.g. network outage), sendNotification
    //    rejects. Swallow it here so the rejection doesn't bubble up as an
    //    unhandled promise rejection and crash the process — instead cancel
    //    this permission request and let the transport reconnect in the
    //    background. The agent receives a clean "cancelled" outcome.
    try {
      await this.mcpBridge.sendNotification(
        "notifications/claude/channel/permission_request",
        payload
      );
    } catch (err) {
      console.error(
        `[acp] Failed to forward permission request ${requestId} (cancelling):`,
        err
      );
      return { outcome: { outcome: "cancelled" } };
    }

    // 2. Wait for the verdict from the MCP server — but not forever.
    console.error(`⌛ Waiting for human approval in the agentrq dashboard...`);

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const timer =
        this.permissionTimeoutMs > 0
          ? setTimeout(() => {
              console.error(
                `[acp] ⌛ No verdict for ${requestId} after ` +
                  `${Math.round(this.permissionTimeoutMs / 60000)} min — cancelling the turn.`,
              );
              // Cancel as well as answering: the spec treats `cancelled` as the
              // answer a client gives *because* it cancelled the turn. Answering
              // alone would leave the agent free to carry on and ask again.
              void this.cancelTurn(sessionId);
              settle({ outcome: "cancelled" });
            }, this.permissionTimeoutMs)
          : undefined;

      const settle = (outcome: acp.RequestPermissionOutcome): void => {
        if (timer) clearTimeout(timer);
        this.pendingPermissions.delete(requestId);
        console.error(
          `[acp] Selected permission option: ${"optionId" in outcome ? outcome.optionId : "cancelled"}`,
        );
        resolve({ outcome });
      };

      this.pendingPermissions.set(requestId, {
        payload,
        sessionId,
        options: params.options,
        settle,
      });
    });
  }

  /**
   * Turns a workspace verdict into one of the options the agent offered.
   *
   * A verdict from agentrq covers exactly one tool call. Never select a
   * "persistent" option (ACP's "allow_always"/"reject_always" kinds, or an
   * equivalent "remember"/"don't ask again" option by name) — picking one would
   * make the *spawned agent* remember the decision and stop sending
   * requestPermission for matching future tool calls, so those calls would
   * never reach agentrq again. Every subsequent call must still be forwarded
   * and re-approved there.
   */
  private outcomeForVerdict(
    options: acp.PermissionOption[],
    behavior: string,
  ): acp.RequestPermissionOutcome {
    const isPersistent = (o: acp.PermissionOption) =>
      /always|remember|don'?t ask/i.test(o.kind) || /always|remember|don'?t ask/i.test(o.name);
    const onceOptions = options.filter(o => !isPersistent(o));

    // Map "allow"/"deny" to the correct ACP option. Per the ACP spec,
    // PermissionOptionKind is one of "allow_once" | "allow_always" |
    // "reject_once" | "reject_always" — there is no "deny_*" kind, so a
    // deny verdict must match on "reject" to find a spec-compliant option.
    const isAllow = behavior === "allow";
    const option = onceOptions.find(o => {
      const name = o.name.toLowerCase();
      return isAllow
        ? o.kind.startsWith("allow") || name.includes("allow") || name.includes("yes") || name.includes("approve")
        : o.kind.startsWith("reject") || name.includes("deny") || name.includes("reject") || name.includes("no");
    });
    if (option) return { outcome: "selected", optionId: option.optionId };

    // Falling back to onceOptions[0] unconditionally is unsafe for a deny
    // verdict: ACP conventionally lists allow options first, so an unmatched
    // deny could silently resolve to an allow option and approve a tool call
    // the human explicitly denied. Only ever fall back to a non-persistent
    // option that is not itself an allow-kind; if no safe option exists at all
    // (e.g. only "always" options were offered), cancel instead of guessing.
    if (isAllow) {
      return onceOptions[0]
        ? { outcome: "selected", optionId: onceOptions[0].optionId }
        : { outcome: "cancelled" };
    }
    const safeFallback = onceOptions.find(o => !o.kind.startsWith("allow"));
    return safeFallback
      ? { outcome: "selected", optionId: safeFallback.optionId }
      : { outcome: "cancelled" };
  }

  /**
   * Records what a tool call is, keyed by its id, so that a permission request
   * arriving without a title or input can still be identified. ACP requires a
   * title on the `tool_call` session update but leaves it optional on the
   * permission request for that same call — codex-acp sends the request bare,
   * which previously surfaced agentrq's own MCP calls to the human as
   * "Unknown Tool" instead of being auto-allowed.
   */
  private rememberToolCall(update: {
    toolCallId?: string;
    title?: string | null;
    rawInput?: unknown;
    status?: string | null;
  }): void {
    const id = update.toolCallId;
    if (!id) return;

    // A finished call will never ask for permission, so drop what we kept
    // rather than growing the map for the lifetime of the session.
    if (update.status === "completed" || update.status === "failed") {
      this.toolCallDetails.delete(id);
      return;
    }

    const previous = this.toolCallDetails.get(id);
    const title = update.title ?? previous?.title;
    const rawInput = update.rawInput ?? previous?.rawInput;
    if (title === undefined && rawInput === undefined) return;
    this.toolCallDetails.set(id, { title, rawInput });
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          process.stdout.write(update.content.text);
          const sid = params.sessionId;
          this.replyBuffers.set(sid, (this.replyBuffers.get(sid) ?? "") + update.content.text);
        }
        break;
      case "current_mode_update":
        console.error(`[acp] Agent switched session mode to "${update.currentModeId}"`);
        await this.onModeChanged?.(params.sessionId, update.currentModeId);
        break;
      case "tool_call_update":
        this.rememberToolCall(update);
        break;
      case "tool_call": {
        this.rememberToolCall(update);
        if (update.title && AGENTRQ_TOOL_PATTERN.test(update.title)) {
          // Track completed reply calls so flushReply can skip exact duplicates
          if (
            update.status === "completed" &&
            update.title.split(/[\s(]/)[0] === "reply" &&
            update.rawInput != null &&
            typeof (update.rawInput as any).chatId === "string"
          ) {
            const { chatId, text = "" } = update.rawInput as { chatId: string; text?: string };
            this.agentReplies.set(chatId, text);
          }
          break;
        }
        console.error(`\n🔧 [ACP Agent] Tool call: ${update.title} (${update.status})`);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Handles the agent's elicitation/create requests by delegating to
   * AgentRQ's `elicit` MCP tool, which blocks in the chat until the human
   * answers (or times out). AgentRQ's tool already waits for the human to
   * confirm in url mode too — collapsing ACP's "accept now, complete
   * later" url flow into a single round trip — so the response here already
   * reflects completion; see completeElicitation below.
   */
  async createElicitation(
    params: acp.CreateElicitationRequest
  ): Promise<acp.CreateElicitationResponse> {
    const sessionId = "sessionId" in params ? (params.sessionId as string) : undefined;
    let taskId = sessionId ? this.getTaskIdForSession(sessionId) : undefined;

    if (!taskId) {
      // Request-scoped elicitations (e.g. during an auth/config phase before
      // any session exists) have no task to attach to, but the elicit tool
      // requires one — create one for the human to answer instead of
      // cancelling outright.
      taskId = await this.createTaskForElicitation(params.message);
      if (!taskId) {
        console.error(`[acp] Elicitation request has no associated task and task creation failed, cancelling`);
        return { action: "cancel" };
      }
    }

    const toolArgs: Record<string, unknown> = {
      taskId,
      message: params.message,
      mode: params.mode,
    };
    if (params.mode === "form") {
      toolArgs.requestedSchema = (params as acp.ElicitationFormMode).requestedSchema;
    } else if (params.mode === "url") {
      toolArgs.url = (params as acp.ElicitationUrlMode).url;
    } else {
      console.error(`[acp] Unsupported elicitation mode "${params.mode}", cancelling`);
      return { action: "cancel" };
    }

    console.error(`[acp] Elicitation requested (mode=${params.mode}): ${params.message}`);

    try {
      const result = await this.mcpBridge.callTool("elicit", toolArgs);
      const contentBlock = result.content as Array<{ type: string; text?: string }> | undefined;
      const text = contentBlock?.[0]?.text;
      if (!text) {
        console.error(`[acp] Elicit tool returned no content, cancelling`);
        return { action: "cancel" };
      }
      if (result.isError) {
        console.error(`[acp] Elicit tool call failed: ${text}`);
        return { action: "cancel" };
      }

      const parsed = JSON.parse(text) as { action: string; content?: Record<string, unknown> };
      if (parsed.action === "accept") {
        return { action: "accept", content: parsed.content };
      }
      if (parsed.action === "decline") {
        return { action: "decline" };
      }
      return { action: "cancel" };
    } catch (err) {
      console.error(`[acp] Failed to process elicitation request:`, err);
      return { action: "cancel" };
    }
  }

  /**
   * Creates a new AgentRQ task for a session-less elicitation and marks it
   * ongoing, so the elicit tool call has somewhere to post the question and
   * the human sees it show up as an active task rather than a stray message.
   * Returns the new task's base62 ID, or undefined if creation failed.
   */
  private async createTaskForElicitation(message: string): Promise<string | undefined> {
    try {
      const created = await this.mcpBridge.callTool("createTask", {
        title: message.length > 80 ? `${message.slice(0, 77)}...` : message,
        body: message,
        assignee: "human",
      });
      const text = (created.content as Array<{ type: string; text?: string }> | undefined)?.[0]?.text;
      const taskId = text?.match(/id=(\S+)/)?.[1];
      if (!taskId) {
        console.error(`[acp] Could not parse task ID from createTask response: ${text ?? "<empty>"}`);
        return undefined;
      }

      await this.mcpBridge.callTool("updateTaskStatus", { taskId, status: "ongoing" });
      return taskId;
    } catch (err) {
      console.error(`[acp] Failed to create task for elicitation:`, err);
      return undefined;
    }
  }

  /**
   * Called when the agent reports a url-mode elicitation as complete.
   * AgentRQ's elicit tool already blocks until the human confirms, so our
   * createElicitation response has already reflected completion by the time
   * this notification (if any) arrives — matching the spec's requirement
   * that clients ignore completion notices for elicitations they don't
   * still consider pending.
   */
  async completeElicitation(_params: acp.CompleteElicitationNotification): Promise<void> {}

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    const filePath = path.resolve(process.cwd(), params.path);
    console.error(`[acp] Writing file: ${params.path}`);
    
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content, "utf8");
      console.error(`[acp] File written successfully: ${params.path}`);
      return {};
    } catch (err: any) {
      console.error(`[acp] Error writing file ${params.path}:`, err.message);
      throw err;
    }
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    const filePath = path.resolve(process.cwd(), params.path);
    console.error(`[acp] Reading file: ${params.path}`);
    
    try {
      const content = await fs.readFile(filePath, "utf8");
      return { content };
    } catch (err: any) {
      console.error(`[acp] Error reading file ${params.path}:`, err.message);
      throw err;
    }
  }
}
