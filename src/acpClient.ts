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

export class AgentRQACPClient implements acp.Client {
  private replyBuffers = new Map<string, string>();
  // chatId → text sent by the agent via the reply MCP tool (for dedup in flushReply)
  private agentReplies = new Map<string, string>();

  constructor(
    private mcpBridge: MCPBridge,
    private getTaskIdForSession: (sessionId: string) => string | undefined = () => undefined,
  ) {}

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

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = params.toolCall.toolCallId;
    const toolTitle = params.toolCall.title ?? "Unknown Tool";

    // Auto-allow tool calls that contain the pattern: agentrq-<11 chars a-zA-Z0-9>
    const agentrqToolPattern = /agentrq-[a-zA-Z0-9]{11}/;
    if (agentrqToolPattern.test(toolTitle)) {
      console.error(`\n🔓 ACP Auto-allowing tool call: ${toolTitle} (ID: ${requestId})`);
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

    console.error(`\n🔐 ACP Permission requested: ${toolTitle} (ID: ${requestId})`);

    const taskId = params.sessionId ? this.getTaskIdForSession(params.sessionId) : undefined;
    const payload = {
      request_id: requestId,
      task_id: taskId,
      tool_name: toolTitle,
      description: toolTitle,
      input_preview: JSON.stringify(params.toolCall.rawInput ?? {}),
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

    // 2. Wait for the verdict from the MCP server
    console.error(`⌛ Waiting for human approval in the agentrq dashboard...`);
    
    return new Promise((resolve) => {
      const handler = (data: { requestId: string; behavior: string }) => {
        if (data.requestId === requestId) {
          // Cleanup this listener
          this.mcpBridge.off("verdict", handler);
          
          console.error(`✅ Permission verdict received: ${data.behavior}`);

          // A verdict from agentrq covers exactly one tool call. Never select
          // a "persistent" option (ACP's "allow_always"/"reject_always" kinds,
          // or an equivalent "remember"/"don't ask again" option by name) —
          // picking one would make the *spawned agent* remember the decision
          // and stop sending requestPermission for matching future tool
          // calls, so those calls would never reach agentrq again. Every
          // subsequent call must still be forwarded and re-approved there.
          const isPersistent = (o: acp.PermissionOption) =>
            /always|remember|don'?t ask/i.test(o.kind) || /always|remember|don'?t ask/i.test(o.name);
          const onceOptions = params.options.filter(o => !isPersistent(o));

          // Map "allow"/"deny" to the correct ACP option. Per the ACP spec,
          // PermissionOptionKind is one of "allow_once" | "allow_always" |
          // "reject_once" | "reject_always" — there is no "deny_*" kind, so a
          // deny verdict must match on "reject" to find a spec-compliant option.
          const isAllow = data.behavior === "allow";
          const option = onceOptions.find(o => {
            const name = o.name.toLowerCase();
            return isAllow
              ? o.kind.startsWith("allow") || name.includes("allow") || name.includes("yes") || name.includes("approve")
              : o.kind.startsWith("reject") || name.includes("deny") || name.includes("reject") || name.includes("no");
          });

          // Falling back to onceOptions[0] unconditionally is unsafe for a
          // deny verdict: ACP conventionally lists allow options first, so an
          // unmatched deny could silently resolve to an allow option and
          // approve a tool call the human explicitly denied. Only ever fall
          // back to a non-persistent option that is not itself an allow-kind;
          // if no safe option exists at all (e.g. only "always" options were
          // offered), cancel instead of guessing.
          let outcome: acp.RequestPermissionOutcome;
          if (option) {
            outcome = { outcome: "selected", optionId: option.optionId };
          } else if (isAllow) {
            outcome = onceOptions[0]
              ? { outcome: "selected", optionId: onceOptions[0].optionId }
              : { outcome: "cancelled" };
          } else {
            const safeFallback = onceOptions.find(o => !o.kind.startsWith("allow"));
            outcome = safeFallback
              ? { outcome: "selected", optionId: safeFallback.optionId }
              : { outcome: "cancelled" };
          }

          console.error(
            `[acp] Selected permission option: ${"optionId" in outcome ? outcome.optionId : "cancelled"} (${option?.name ?? "default"})`
          );

          resolve({ outcome });
        }
      };

      this.mcpBridge.on("verdict", handler);
    });
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
      case "tool_call": {
        const agentrqToolPattern = /agentrq-[a-zA-Z0-9]{11}/;
        if (update.title && agentrqToolPattern.test(update.title)) {
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
