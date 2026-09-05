#!/usr/bin/env node
/**
 * index.ts
 *
 * The main entry point for acp-gateway.
 * Orchestrates the bridge between the ACP Agent and the agentrq MCP Server.
 */

import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

import {
  loadMcpConfig,
  pickAgentrqServer,
  type McpServerConfig,
  type McpTransport,
} from "./config.js";
import { MCPBridge } from "./mcpClient.js";

/**
 * What the agent said about a transport, if anything.
 *
 * stdio is the one transport every agent must support. For the others the
 * answer is only trustworthy when the agent actually stated it: an agent that
 * advertises no MCP capabilities at all is far more likely to be terse than to
 * be unable to reach an HTTP server, and dropping its servers on that reading
 * would take the workspace's own MCP server away from it.
 */
function transportSupport(
  transport: McpTransport,
  agentCapabilities: acp.AgentCapabilities | null | undefined,
): "required" | "declared" | "refused" | "unstated" {
  if (transport === "stdio") return "required";
  const declared = (agentCapabilities?.mcpCapabilities as Record<string, unknown> | undefined)?.[
    transport
  ];
  if (declared === true) return "declared";
  if (declared === false) return "refused";
  return "unstated";
}

export function mapMcpServers(
  configs: McpServerConfig[],
  agentCapabilities?: acp.AgentCapabilities | null,
): acp.McpServer[] {
  return configs
    .filter((cfg) => {
      const support = transportSupport(cfg.type, agentCapabilities);
      if (support === "refused") {
        console.error(
          `[acp] ⚠️  Not passing MCP server "${cfg.name}" to the agent: it is ${cfg.type}, ` +
            `and the agent says it does not support that transport. Passing it anyway ` +
            `risks the agent refusing the whole session.`,
        );
        return false;
      }
      if (support === "unstated") {
        console.error(
          `[acp] MCP server "${cfg.name}" is ${cfg.type}, which the agent does not ` +
            `advertise either way — passing it and letting the agent decide.`,
        );
      }
      return true;
    })
    .map((cfg): acp.McpServer => {
      if (cfg.type === "stdio") {
        return {
          name: cfg.name,
          command: cfg.command!,
          args: cfg.args ?? [],
          env: Object.entries(cfg.env || {}).map(([name, value]) => ({ name, value })) as any,
        };
      }
      return {
        type: cfg.type,
        name: cfg.name,
        url: cfg.url!,
        headers: Object.entries(cfg.headers || {}).map(([name, value]) => ({ name, value })) as any,
      };
    });
}
import { AgentRQACPClient, DEFAULT_PERMISSION_TIMEOUT_MS } from "./acpClient.js";
import {
  describeAuthMethods,
  isAuthRequiredError,
  login,
  logout,
  supportsLogout,
  type AuthConnection,
  type LoginOptions,
} from "./auth.js";
import { resolveAgentLaunch } from "./agentInstall.js";
import { describeAgentInfo } from "./agentInfo.js";
import {
  describeAgents,
  fetchRegistry,
  hostPlatformTarget,
} from "./registry.js";
import {
  extractTaskIdFromMeta,
  extractTaskIdFromText,
} from "./taskIdentity.js";
import {
  extractModels,
  formatModelsText,
  setSessionModel,
  type AgentModelsResult,
} from "./models.js";

const lastTaskContent = new Map<string, string>();

// Cancellations are remembered by *where they fall in the stream of events*
// rather than as a one-shot flag. agentrq reuses a chat's id as the task id, so
// a flag that outlived the cancellation it describes would swallow the user's
// next message on that chat; ordered this way, a task is skipped only when the
// cancel arrived after it was queued. Wall-clock time is too coarse to order
// two events in the same millisecond, so this is a plain counter.
let taskSeq = 0;
export const nextTaskSeq = (): number => ++taskSeq;
export const cancelledTaskSeq = new Map<string, number>();
// A cancel for a task that never runs (a stale id, a task that already
// finished) leaves an entry behind, so keep the map from growing without bound.
const MAX_REMEMBERED_CANCELLATIONS = 200;

/** Records that `taskId` has just been cancelled. */
export function markTaskCancelled(taskId: string): void {
  // Re-inserting moves the id to the end, so eviction stays oldest-first.
  cancelledTaskSeq.delete(taskId);
  cancelledTaskSeq.set(taskId, nextTaskSeq());
  while (cancelledTaskSeq.size > MAX_REMEMBERED_CANCELLATIONS) {
    const oldest = cancelledTaskSeq.keys().next().value as string;
    cancelledTaskSeq.delete(oldest);
  }
}

/**
 * Whether a task queued at `queuedSeq` has since been cancelled.
 *
 * Two notifications for the same task id can be queued at once, so the check is
 * against the point each was queued: cancelling the older one must not stop the
 * newer one from running.
 */
export function isTaskCancelled(
  taskId: string | undefined,
  queuedSeq: number,
): boolean {
  if (!taskId) return false;
  const seq = cancelledTaskSeq.get(taskId);
  return seq !== undefined && seq > queuedSeq;
}

export interface AgentSession {
  process: any;
  connection: acp.ClientSideConnection;
  acpClient: AgentRQACPClient;
  sessionId: string;
  initResult: acp.InitializeResponse;
}

export const activeSessions = new Map<string, AgentSession>();

/** How long to wait for `session/close` RPC before terminating the session process regardless. */
export const CLOSE_SESSION_TIMEOUT_MS = 2000;

/** Whether the agent advertised `session.close` capability during initialize. */
export function supportsCloseSession(
  agentCapabilities: acp.InitializeResponse["agentCapabilities"] | null | undefined,
): boolean {
  const sessions = (
    agentCapabilities as
      | { sessionCapabilities?: { close?: unknown } }
      | null
      | undefined
  )?.sessionCapabilities;
  return sessions?.close !== undefined && sessions?.close !== null && sessions?.close !== false;
}

/**
 * Cleanly closes an active agent session:
 * 1. Cancels any in-flight prompt turn and pending permissions for the session.
 * 2. Calls `session/close` RPC on the connection if the agent supports it (with timeout).
 * 3. Kills the agent child process.
 */
export async function closeSession(
  session: AgentSession,
  timeoutMs: number = CLOSE_SESSION_TIMEOUT_MS,
): Promise<void> {
  if (session.acpClient && typeof session.acpClient.cancelTurn === "function") {
    try {
      await session.acpClient.cancelTurn(session.sessionId);
    } catch (err) {
      console.error(
        `[acp] Error cancelling turn while closing session ${session.sessionId}:`,
        err,
      );
    }
  }

  if (
    supportsCloseSession(session.initResult?.agentCapabilities) &&
    typeof session.connection?.closeSession === "function"
  ) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.resolve(
          session.connection.closeSession({ sessionId: session.sessionId }),
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.error(
              `[acp] session/close for ${session.sessionId} did not complete in ${timeoutMs}ms`,
            );
            resolve();
          }, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    } catch (err) {
      console.error(
        `[acp] Failed to cleanly close session ${session.sessionId}:`,
        err,
      );
    }
  }

  try {
    session.process?.kill?.();
  } catch (err) {
    // Process might already be dead or exited
  }
}

/**
 * Cleanly closes all active sessions in parallel and clears the activeSessions map.
 */
export async function closeAllSessions(
  timeoutMs: number = CLOSE_SESSION_TIMEOUT_MS,
): Promise<void> {
  const sessions = Array.from(new Set(activeSessions.values()));
  activeSessions.clear();
  if (sessions.length === 0) return;
  console.error(`[acp] Cleanly closing ${sessions.length} active session(s)...`);
  await Promise.all(sessions.map((session) => closeSession(session, timeoutMs)));
}

/**
 * Registers signal handlers (SIGINT, SIGTERM) to trigger graceful shutdown.
 * Returns a teardown function to unregister the handlers.
 */
export function setupSignalHandlers(
  onSignal: (signal: string) => Promise<void> | void,
): () => void {
  const sigintHandler = () => {
    void onSignal("SIGINT");
  };
  const sigtermHandler = () => {
    void onSignal("SIGTERM");
  };

  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  return () => {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
  };
}

/** Login preferences taken from the CLI, consulted whenever an agent demands auth. */
export const authConfig: { methodId?: string } = {};

/** Model preference taken from the CLI, applied when a session starts. */
export const modelConfig: { modelId?: string } = {};

/** How long tool calls wait for a human, taken from the CLI at startup. */
export const permissionConfig: { timeoutMs?: number } = {};

/**
 * Whether a human is sitting in front of this process.
 *
 * Terminal logins hand the agent our own stdio, and the "which login method?"
 * prompt needs someone to answer it — neither works when the gateway runs
 * unattended under a supervisor.
 */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export interface AgentConnection {
  process: any;
  connection: acp.ClientSideConnection;
  acpClient: AgentRQACPClient;
  initResult: acp.InitializeResponse;
}

export interface OpenAgentConnectionOptions {
  acpCmdArgs: string[];
  mcpBridge: MCPBridge;
  env?: Record<string, string>;
  /** Used in log lines to say which agent process is being talked about. */
  label: string;
  taskId?: string;
  /** Runs when the agent process dies or fails to start. */
  onExit?: () => void;
}

/**
 * Spawns an ACP agent, wires the JSON-RPC streams to it and completes the
 * `initialize` handshake, returning the connection plus what the agent said
 * about itself — including the login methods it advertises.
 */
export async function openAgentConnection({
  acpCmdArgs,
  mcpBridge,
  env,
  label,
  taskId,
  onExit,
}: OpenAgentConnectionOptions): Promise<AgentConnection> {
  const [cmd, ...cmdArgs] = acpCmdArgs;
  console.error(`[acp] Spawning agent for ${label}: ${cmd} ${cmdArgs.join(" ")}`);

  const agentProcess = spawn(cmd, cmdArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });

  const acpClient = new AgentRQACPClient(mcpBridge, () => taskId, {
    permissionTimeoutMs: permissionConfig.timeoutMs,
  });

  // Guard against unhandled child-process failures. Without these listeners a
  // crashed agent (e.g. on network loss) leaves a broken stdin pipe; the next
  // write raises EPIPE as an uncaught error and takes the gateway down with it.
  agentProcess.on("error", (err: Error) => {
    console.error(`[acp] Agent process error for ${label}:`, err.message);
    acpClient.cancelPendingPermissions(`agent process for ${label} failed`);
    onExit?.();
  });
  agentProcess.on("exit", (code: number | null, signal: string | null) => {
    console.error(
      `[acp] Agent process for ${label} exited (code=${code}, signal=${signal})`,
    );
    // Nothing will act on these answers now, but the tool calls waiting on them
    // are holding task-queue slots that would never be given back.
    acpClient.cancelPendingPermissions(`agent process for ${label} exited`);
    onExit?.();
  });
  // stdin can emit EPIPE when the child dies mid-write; swallow it so it
  // doesn't surface as an uncaught exception.
  agentProcess.stdin?.on("error", (err: Error) => {
    console.error(`[acp] Agent stdin error for ${label}:`, err.message);
  });

  const input = Writable.toWeb(agentProcess.stdin!);
  const output = Readable.toWeb(
    agentProcess.stdout!,
  ) as ReadableStream<Uint8Array>;

  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(
    (_agent) => acpClient,
    stream,
  );
  // Stopping a turn is only possible once the connection exists, and the
  // connection is built around the client — so it is handed over afterwards.
  acpClient.setSessionCanceller((sessionId) => connection.cancel({ sessionId }));

  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: {
      name: pkg.name,
      version: pkg.version,
    },
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      elicitation: {
        form: {},
        url: {},
      },
      plan: {},
      // Only claim terminal logins when we can actually hand the agent a
      // terminal; otherwise the agent may offer a method we cannot run.
      auth: {
        terminal: isInteractiveTerminal(),
      },
    },
  });

  console.error(
    `[acp] Connected to agent for ${label} (protocol v${initResult.protocolVersion})`,
  );
  if (initResult.authMethods?.length) {
    console.error(
      `[auth] Agent offers these login methods:\n${describeAuthMethods(initResult.authMethods)}`,
    );
  }

  return { process: agentProcess, connection, acpClient, initResult };
}

/**
 * Starts a session, logging in first if the agent refuses without one.
 *
 * Agents only report `auth_required` when the session is requested, so this is
 * where a first-run login belongs: authenticate once, then retry.
 */
export async function createSessionWithAuth(
  connection: acp.ClientSideConnection,
  params: AcpNewSessionParams,
  auth: Omit<LoginOptions, "connection">,
): Promise<acp.NewSessionResponse> {
  try {
    return await connection.newSession(params);
  } catch (err) {
    if (!isAuthRequiredError(err)) throw err;
    console.error("[auth] Agent requires authentication before a session can start.");
    await login({ ...auth, connection: connection as unknown as AuthConnection });
    return await connection.newSession(params);
  }
}

export async function getOrCreateSession(
  taskId: string | undefined,
  acpCmdArgs: string[],
  configs: McpServerConfig[],
  agentrqConfig: McpServerConfig,
  mcpBridge: MCPBridge,
): Promise<AgentSession> {
  const key = taskId || "default";
  const existing = activeSessions.get(key);
  if (existing) {
    return existing;
  }

  const [cmd, ...cmdArgs] = acpCmdArgs;
  const { process: agentProcess, connection, acpClient, initResult } =
    await openAgentConnection({
      acpCmdArgs,
      mcpBridge,
      env: agentrqConfig.env,
      label: `task ${key}`,
      taskId,
      onExit: () => activeSessions.delete(key),
    });

  const newSessionParams: AcpNewSessionParams = {
    cwd: process.cwd(),
    mcpServers: mapMcpServers(configs, initResult.agentCapabilities),
  };

  const sessionResult = await createSessionWithAuth(connection, newSessionParams, {
    methods: initResult.authMethods,
    launch: { command: cmd, args: cmdArgs, env: agentrqConfig.env },
    preferredId: authConfig.methodId,
    interactive: isInteractiveTerminal(),
  });
  console.error(`[acp] Created session ${sessionResult.sessionId} for task ${key}`);

  try {
    const modelsResult = extractModels(sessionResult.configOptions);
    if (modelsResult) {
      if (modelConfig.modelId && modelConfig.modelId !== modelsResult.currentModelId) {
        const targetModel = modelsResult.models.find(
          (m) => m.id === modelConfig.modelId || m.name === modelConfig.modelId,
        );
        if (targetModel) {
          try {
            const updateRes = await setSessionModel(
              connection,
              sessionResult.sessionId,
              modelsResult.configId,
              targetModel.id,
            );
            const updatedModels = extractModels(updateRes.configOptions) ?? {
              ...modelsResult,
              currentModelId: targetModel.id,
              models: modelsResult.models.map((m) => ({
                ...m,
                current: m.id === targetModel.id,
              })),
            };
            void acpClient.sendModelsToWorkspace(sessionResult.sessionId, updatedModels);
          } catch (err) {
            console.error(`[acp] Failed to set requested model "${modelConfig.modelId}":`, err);
            void acpClient.sendModelsToWorkspace(sessionResult.sessionId, modelsResult);
          }
        } else {
          console.error(
            `[acp] Requested model "${modelConfig.modelId}" not found in available models: ${modelsResult.models.map((m) => m.id).join(", ")}`,
          );
          void acpClient.sendModelsToWorkspace(sessionResult.sessionId, modelsResult);
        }
      } else {
        void acpClient.sendModelsToWorkspace(sessionResult.sessionId, modelsResult);
      }
    }
  } catch (err) {
    console.error(`[acp] Failed to extract or configure models for session ${sessionResult.sessionId}:`, err);
  }

  await enforceHumanApprovalMode(connection, sessionResult);
  // The mode is pinned once here, but agents may move themselves back out of
  // it, so keep watching for the rest of the session's life.
  acpClient.setModeChangeHandler((changedSessionId, modeId) =>
    handleAgentModeChange(connection, changedSessionId, modeId, sessionResult.modes),
  );

  const sessionInfo: AgentSession = {
    process: agentProcess,
    connection,
    acpClient,
    sessionId: sessionResult.sessionId,
    initResult,
  };
  activeSessions.set(key, sessionInfo);
  return sessionInfo;
}

/**
 * Finds the active agent session for a given task ID (or returns the single active session if none specified).
 */
export function findActiveSession(taskId?: string): AgentSession | undefined {
  if (taskId) {
    const direct = activeSessions.get(taskId);
    if (direct) return direct;
    for (const session of activeSessions.values()) {
      if (session.sessionId === taskId) return session;
    }
    // A session opened from a notification that carried no task id is keyed
    // "default"; when it is the only one running, an id-carrying cancel can
    // only have meant it. Never fall back to a session keyed under a
    // *different* task id — that would abort an unrelated task.
    const untracked = activeSessions.get("default");
    if (untracked && activeSessions.size === 1) {
      return untracked;
    }
  } else if (activeSessions.size === 1) {
    return activeSessions.values().next().value;
  }
  return undefined;
}

/**
 * Handles task cancellation events from the MCP server.
 * Cancels the ACP session/turn and immediately cancels any pending permissions.
 */
export async function handleTaskCancellation(
  taskId?: string,
  reason?: string,
): Promise<void> {
  if (taskId) {
    markTaskCancelled(taskId);
    const session = findActiveSession(taskId);
    if (!session) {
      console.error(
        `[bridge] Received cancellation for task ${taskId}, but no active session found (queued tasks will be skipped)`,
      );
      return;
    }
    console.error(
      `[bridge] Cancelling session ${session.sessionId} for task ${taskId}${reason ? ` (${reason})` : ""}`,
    );
    await session.acpClient.cancelTurn(session.sessionId);
  } else {
    const session = findActiveSession(undefined);
    if (session) {
      console.error(
        `[bridge] Received cancellation with no taskId${reason ? ` (${reason})` : ""}. Cancelling active session ${session.sessionId}...`,
      );
      await session.acpClient.cancelTurn(session.sessionId);
    } else {
      console.error(
        `[bridge] Received cancellation with no taskId${reason ? ` (${reason})` : ""}` +
          (activeSessions.size === 0
            ? ", and no sessions are active"
            : `, but ${activeSessions.size} sessions are active (skipping to avoid aborting unrelated tasks)`),
      );
    }
  }
}

type AcpNewSessionParams = Parameters<
  acp.ClientSideConnection["newSession"]
>[0];

// Modes that approve tool calls without asking the user. codex-acp, for
// example, defaults to an "agent" mode whose reviewer is "auto_review" — an
// automated Guardian Review that approves on the human's behalf — and also
// offers an "agent-full-access" mode that never asks at all.
const AUTO_APPROVING_MODE = /auto|full[\s_-]?access|danger|bypass|yolo|never|always/i;
// Modes that defer the decision to the human.
const HUMAN_APPROVAL_MODE = /ask|approval|approve|manual|prompt|review|read[\s_-]?only/i;

function describeMode(mode: acp.SessionMode): string {
  const kind = (mode._meta as { kind?: unknown } | null | undefined)?.kind;
  return `${mode.id} ${mode.name} ${typeof kind === "string" ? kind : ""}`;
}

/**
 * Picks the session mode that routes every tool-call approval to the human.
 *
 * Agents may offer modes that approve on the user's behalf and commonly
 * default to one. In such a mode the agent never sends a permission request,
 * so tool calls — including destructive ones — execute without ever reaching
 * agentrq. Returns the id of a mode that defers to the human, or undefined if
 * the agent offers none.
 */
export function pickHumanApprovalMode(
  modes: acp.SessionModeState | null | undefined,
): string | undefined {
  const available = modes?.availableModes;
  if (!available?.length) return undefined;

  const candidates = available.filter((m) => !AUTO_APPROVING_MODE.test(describeMode(m)));
  const chosen =
    candidates.find((m) => HUMAN_APPROVAL_MODE.test(describeMode(m))) ?? candidates[0];
  return chosen?.id;
}

/**
 * Switches a freshly created session into a mode that requires human approval,
 * so that every non-agentrq tool call reaches the agentrq dashboard rather than
 * being auto-approved inside the agent.
 */
export async function enforceHumanApprovalMode(
  connection: acp.ClientSideConnection,
  sessionResult: { sessionId: string; modes?: acp.SessionModeState | null },
): Promise<void> {
  const modes = sessionResult.modes;
  // Agents that expose no modes have nothing to switch; they either always ask
  // or their policy is out of the gateway's reach.
  if (!modes?.availableModes?.length) return;

  const modeId = pickHumanApprovalMode(modes);
  if (!modeId) {
    console.error(
      `[acp] ⚠️  Agent offers no mode that defers approvals to the human ` +
        `(available: ${modes.availableModes.map((m) => m.id).join(", ")}). ` +
        `Tool calls may execute without agentrq approval.`,
    );
    return;
  }
  if (modeId === modes.currentModeId) return;

  try {
    await connection.setSessionMode({ sessionId: sessionResult.sessionId, modeId });
    console.error(
      `[acp] Session mode set to "${modeId}" (was "${modes.currentModeId}") so tool calls require agentrq approval`,
    );
  } catch (err) {
    console.error(
      `[acp] ⚠️  Failed to set session mode to "${modeId}" — tool calls may execute without agentrq approval:`,
      err,
    );
  }
}

/**
 * How many times the gateway will drag one session back into a mode that asks
 * the human. An agent that keeps switching back is not going to stop, and an
 * unbounded fight with it would be an endless stream of setSessionMode calls.
 */
const MAX_MODE_REENFORCEMENTS = 3;

/** sessionId → how many times its mode has already been put back. */
const modeReenforcements = new Map<string, number>();

/**
 * Puts a session back into a mode that asks the human, after the agent moved
 * itself out of one.
 *
 * Agents may change modes on their own. If one moves into a mode that approves
 * tool calls on the user's behalf, every later tool call — including
 * destructive ones — executes without ever reaching agentrq, and nothing
 * anywhere says so.
 */
export async function handleAgentModeChange(
  connection: acp.ClientSideConnection,
  sessionId: string,
  currentModeId: string,
  modes: acp.SessionModeState | null | undefined,
): Promise<void> {
  const available = modes?.availableModes;
  if (!available?.length) return;

  const mode = available.find((m) => m.id === currentModeId);
  // A mode the agent never advertised cannot be vouched for either, so it is
  // treated the same as one that approves on our behalf.
  if (mode && !AUTO_APPROVING_MODE.test(describeMode(mode))) {
    modeReenforcements.delete(sessionId);
    return;
  }

  const attempts = modeReenforcements.get(sessionId) ?? 0;
  if (attempts >= MAX_MODE_REENFORCEMENTS) {
    console.error(
      `[acp] ⚠️  Agent keeps returning session ${sessionId} to mode "${currentModeId}", ` +
        `which approves tool calls without asking. Giving up after ` +
        `${MAX_MODE_REENFORCEMENTS} attempts — tool calls may now execute without ` +
        `agentrq approval.`,
    );
    return;
  }
  modeReenforcements.set(sessionId, attempts + 1);

  console.error(
    `[acp] ⚠️  Agent moved session ${sessionId} into "${currentModeId}", which approves ` +
      `tool calls without asking. Putting it back.`,
  );
  await enforceHumanApprovalMode(connection, {
    sessionId,
    modes: { availableModes: available, currentModeId },
  });
}

export function createAcpSessionSwitcher(
  connection: acp.ClientSideConnection,
  params: AcpNewSessionParams,
  initialSessionId: string,
) {
  let currentSessionId = initialSessionId;
  const taskSessionMap = new Map<string, string>();
  const sessionTaskMap = new Map<string, string>();

  return {
    getSessionId(): string {
      return currentSessionId;
    },
    getTaskIdForSession(sessionId: string): string | undefined {
      return sessionTaskMap.get(sessionId);
    },
    async ensureForTask(taskId: string | undefined): Promise<string> {
      if (taskId === undefined) {
        return currentSessionId;
      }

      const existing = taskSessionMap.get(taskId);
      if (existing) {
        currentSessionId = existing;
        return existing;
      }

      const next = await connection.newSession(params);
      currentSessionId = next.sessionId;
      taskSessionMap.set(taskId, currentSessionId);
      sessionTaskMap.set(currentSessionId, taskId);
      console.error(
        `[acp] New ACP session for task ${taskId} (MCP connection unchanged): ${currentSessionId}`,
      );
      return currentSessionId;
    },
  };
}


export class TaskQueue {
  private activeTasks = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor(private maxConcurrency: number) {}

  async run(taskFn: () => Promise<void>): Promise<void> {
    if (this.activeTasks < this.maxConcurrency) {
      await this.execute(taskFn);
    } else {
      await new Promise<void>((resolve, reject) => {
        this.queue.push(async () => {
          try {
            await taskFn();
            resolve();
          } catch (err) {
            reject(err);
            throw err;
          }
        });
      });
    }
  }

  private async execute(taskFn: () => Promise<void>): Promise<void> {
    this.activeTasks++;
    try {
      await taskFn();
    } finally {
      this.activeTasks--;
      this.next();
    }
  }

  private next() {
    if (this.queue.length > 0 && this.activeTasks < this.maxConcurrency) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        this.execute(nextTask).catch((err) => {
          console.log("[queue] Error executing queued task:", err);
        });
      }
    }
  }

  public getActiveCount(): number {
    return this.activeTasks;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}

/** What the gateway was asked to do, beyond bridging tasks. */
export type GatewayCommand =
  | "run"
  | "login"
  | "logout"
  | "list-auth-methods"
  | "list-agents"
  | "list-models"
  | "agent-info"
  | "help";

/** Default maximum number of concurrent tasks allowed to prompt the ACP agent at once. */
export const DEFAULT_MAX_CONCURRENCY = 1;

export interface GatewayOptions {
  maxConcurrency: number;
  /** How long a tool call waits for a human verdict. 0 waits indefinitely. */
  permissionTimeoutMs: number;
  authMethodId?: string;
  modelId?: string;
  command: GatewayCommand;
  /** Registry id of the agent to run, instead of a command given after `--`. */
  agentId?: string;
  /** Install a registry binary the registry publishes no checksum for. */
  allowUnverifiedAgent: boolean;
  /** A different registry index, for pinning or for testing. */
  registryUrl?: string;
  /** Tokens that are not gateway options — the agent command, when no `--` was used. */
  rest: string[];
}

/**
 * Parses the gateway's own flags — everything before the `--` that introduces
 * the agent command.
 */
export function parseGatewayArgs(args: string[]): GatewayOptions {
  const options: GatewayOptions = {
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    permissionTimeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
    command: "run",
    allowUnverifiedAgent: false,
    rest: [],
  };

  for (let i = 0; i < args.length; i++) {
    // A following token is this flag's value only when it isn't a flag itself,
    // so `--login` can stand alone or take a method id.
    const next = args[i + 1];
    const value = next !== undefined && !next.startsWith("-") ? next : undefined;

    switch (args[i]) {
      case "--max-concurrency":
      case "--maxConcurrency": {
        const parsed = parseInt(value ?? "", 10);
        if (!isNaN(parsed)) {
          options.maxConcurrency = parsed;
          i++;
        }
        break;
      }
      case "--permission-timeout": {
        const minutes = parseInt(value ?? "", 10);
        if (!isNaN(minutes) && minutes >= 0) {
          options.permissionTimeoutMs = minutes * 60_000;
          i++;
        }
        break;
      }
      case "--auth-method":
        if (value) {
          options.authMethodId = value;
          i++;
        }
        break;
      case "--model":
        if (value) {
          options.modelId = value;
          i++;
        } else {
          console.error("[acp] Warning: --model provided without a valid model identifier; ignoring.");
        }
        break;
      case "--login":
        options.command = "login";
        if (value) {
          options.authMethodId = value;
          i++;
        }
        break;
      case "--logout":
        options.command = "logout";
        break;
      case "--list-auth-methods":
        options.command = "list-auth-methods";
        break;
      case "--agent":
        if (value) {
          options.agentId = value;
          i++;
        }
        break;
      case "--list-agents":
        options.command = "list-agents";
        break;
      case "--list-models":
        options.command = "list-models";
        break;
      case "--agent-info":
        options.command = "agent-info";
        break;
      case "--allow-unverified-agent":
        options.allowUnverifiedAgent = true;
        break;
      case "--registry-url":
        if (value) {
          options.registryUrl = value;
          i++;
        }
        break;
      case "--help":
      case "-h":
        options.command = "help";
        break;
      default:
        // Anything unrecognised belongs to the agent command, which may be
        // given without a `--` separator.
        options.rest.push(args[i]);
    }
  }

  return options;
}

/**
 * Prints every agent the registry publishes, and how each one can be run here.
 */
export async function runListAgents(
  registryUrl?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const registry = await fetchRegistry(registryUrl, fetchImpl);
  const target = hostPlatformTarget();
  console.log(
    `ACP registry v${registry.version} — ${registry.agents.length} agents ` +
      `(this machine: ${target ?? `${process.platform}/${process.arch}, unsupported`})\n`,
  );
  console.log(describeAgents(registry, target));
  console.log(`\nRun one with: acp-gateway --agent <id>`);
}

/**
 * Works out which command actually starts the agent.
 *
 * `--agent <id>` resolves through the registry — installing the agent when the
 * only distribution is a binary — and otherwise the command given after `--`
 * is used as-is.
 */
export async function resolveAgentCommand(
  options: GatewayOptions,
  explicitCommand: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ command: string[]; env?: Record<string, string> }> {
  if (!options.agentId) return { command: explicitCommand };

  const registry = await fetchRegistry(options.registryUrl, fetchImpl);
  const spec = await resolveAgentLaunch({
    id: options.agentId,
    registry,
    platformTarget: hostPlatformTarget(),
    allowUnverified: options.allowUnverifiedAgent,
    fetchImpl,
  });
  console.error(
    `[registry] Running "${options.agentId}" via ${spec.kind}: ${spec.command} ${spec.args.join(" ")}`,
  );
  return { command: [spec.command, ...spec.args], env: spec.env };
}

/**
 * Whether a command can actually be run.
 *
 * A path is checked directly; a bare name is looked for along PATH, honouring
 * PATHEXT on Windows where an executable is rarely named without a suffix.
 */
export function isRunnable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (command.includes("/") || (platform === "win32" && command.includes("\\"))) {
    return existsSync(command);
  }
  const extensions =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const separator = platform === "win32" ? ";" : ":";
  return (env.PATH ?? "")
    .split(separator)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => existsSync(path.join(dir, command + ext))));
}

/**
 * Refuses to start with an agent that cannot be run.
 *
 * The agent is not spawned until the first task arrives, so without this a
 * mistyped command — or a registry id passed as if it were one — starts a
 * gateway that looks healthy and only fails much later, out of sight.
 */
export function assertAgentRunnable(command: string, usedRegistryId: boolean): void {
  if (isRunnable(command)) return;

  const hint = usedRegistryId
    ? `The registry says to run it as "${command}", which is not installed.`
    : `If "${command}" is an ACP registry agent id, run it with --agent ${command} ` +
      `(--list-agents shows what is published).`;
  throw new Error(`Agent command "${command}" was not found. ${hint}`);
}

/**
 * Runs a one-shot command against the agent and shuts it down again.
 *
 * These commands exist so a login — or a look at what the agent supports — can
 * be done deliberately, before any task arrives, rather than only when a
 * session is refused.
 */
export async function runAgentCommand(
  command: Exclude<GatewayCommand, "run">,
  acpCmdArgs: string[],
  agentrqConfig: McpServerConfig,
  mcpBridge: MCPBridge,
  authMethodId?: string,
): Promise<void> {
  const [cmd, ...cmdArgs] = acpCmdArgs;
  const agent = await openAgentConnection({
    acpCmdArgs,
    mcpBridge,
    env: agentrqConfig.env,
    label: command,
  });

  try {
    const connection = agent.connection as unknown as AuthConnection;
    const { authMethods, agentCapabilities } = agent.initResult;

    if (command === "agent-info") {
      console.log(describeAgentInfo(agent.initResult, acpCmdArgs.join(" ")));
      return;
    }

    if (command === "list-auth-methods") {
      console.log(
        `Authentication methods for "${acpCmdArgs.join(" ")}":\n${describeAuthMethods(authMethods)}`,
      );
      if (supportsLogout(agentCapabilities)) {
        console.log("\nThe agent also supports --logout.");
      }
      return;
    }

    if (command === "list-models") {
      const newSessionParams: AcpNewSessionParams = {
        cwd: process.cwd(),
        mcpServers: mapMcpServers([], agentCapabilities),
      };
      const sessionResult = await createSessionWithAuth(
        agent.connection,
        newSessionParams,
        {
          methods: authMethods,
          launch: { command: cmd, args: cmdArgs, env: agentrqConfig.env },
          preferredId: authMethodId,
          interactive: isInteractiveTerminal(),
        },
      );

      try {
        const modelsResult = extractModels(sessionResult.configOptions);
        if (modelsResult && modelsResult.models.length > 0) {
          console.log(formatModelsText(modelsResult, acpCmdArgs.join(" ")));
        } else if (
          agentCapabilities?.providers &&
          typeof (agent.connection as any).unstable_listProviders === "function"
        ) {
          try {
            const providersRes = await (agent.connection as any).unstable_listProviders({});
            const providers = providersRes?.providers ?? [];
            if (providers.length > 0) {
              console.log(`Configurable providers for "${acpCmdArgs.join(" ")}":\n`);
              for (const p of providers) {
                console.log(`  * ${p.providerId} (${p.supported.join(", ")})`);
              }
            } else {
              console.log(`No configurable models advertised by "${acpCmdArgs.join(" ")}".`);
            }
          } catch {
            console.log(`No configurable models advertised by "${acpCmdArgs.join(" ")}".`);
          }
        } else {
          console.log(`No configurable models advertised by "${acpCmdArgs.join(" ")}".`);
        }
      } catch (err) {
        console.error(`[acp] Failed to extract models:`, err);
        console.log(`No configurable models advertised by "${acpCmdArgs.join(" ")}".`);
      }

      await closeSession({
        connection: agent.connection,
        sessionId: sessionResult.sessionId,
        process: agent.process,
        acpClient: agent.acpClient,
        initResult: agent.initResult,
      });
      return;
    }

    if (command === "logout") {
      await logout(connection, agentCapabilities);
      return;
    }

    await login({
      connection,
      methods: authMethods,
      launch: { command: cmd, args: cmdArgs, env: agentrqConfig.env },
      preferredId: authMethodId,
      interactive: isInteractiveTerminal(),
    });
  } finally {
    agent.process.kill();
  }
}

/**
 * The full help text.
 *
 * Shown for `--help`, and when the gateway is run with nothing to do — at
 * which point the reason someone is looking at the terminal is that they do
 * not yet know what to type.
 */
export function helpText(version: string = pkg.version): string {
  return `acp-gateway ${version} — bridges an ACP agent to an agentrq workspace.

USAGE
  acp-gateway [options] -- <agent-command> [agent-args...]
  acp-gateway [options] --agent <registry-id>

  The agent is either a command you supply after \`--\`, or an id from the ACP
  registry. Everything after \`--\` is passed to the agent untouched.

AGENT
  --agent <registry-id>       Run an agent from the ACP registry, installing it
                              if needed, instead of a command you supply.
  --list-agents               List every agent in the registry, and how each one
                              can run on this machine. Exits.
  --list-models               List models supported by the agent. Exits.
  --model <model-id>          Select a specific model for the session.
  --agent-info                What the agent says it supports — session
                              lifecycle, prompt content, MCP transports and
                              logins. Only a live handshake can tell you. Exits.
  --allow-unverified-agent    Install a registry binary that publishes no
                              checksum. Off by default: without a checksum there
                              is no way to tell what was downloaded.
  --registry-url <url>        Read a different registry index, for pinning it or
                              for testing.

AUTHENTICATION
  --list-auth-methods         List the login methods the agent offers. Exits.
  --login [method-id]         Log in to the agent. With no id, and a terminal to
                              ask in, you are asked which method to use. Exits.
  --logout                    Log out of the agent, where it supports it. Exits.
  --auth-method <id>          The method to use when the agent demands a login
                              mid-run. Defaults to choosing one automatically.

BRIDGE
  --max-concurrency <number>  How many tasks may prompt the agent at once.
                              Defaults to ${DEFAULT_MAX_CONCURRENCY}.
  --permission-timeout <min>  How long a tool call waits for someone to approve
                              it before the turn is cancelled. Defaults to 30.
                              0 waits indefinitely, which is what a wedged
                              gateway looks like — use it knowingly.

OTHER
  --help, -h                  Show this help. Exits.

EXAMPLES
  acp-gateway --agent gemini                     Run Gemini from the registry
  acp-gateway -- gemini --acp                    Run an agent you installed
  acp-gateway --list-agents                      See what the registry offers
  acp-gateway --list-models --agent gemini       See models supported by Gemini
  acp-gateway --model gemini-2.5-pro -- gemini --acp
  acp-gateway --agent-info --agent gemini        See what that agent supports
  acp-gateway --login -- gemini --acp            Log in before running anything
  acp-gateway --max-concurrency 4 -- gemini --acp

The workspace comes from .mcp.json, searched for in the current directory and up
to three directories above it.`;
}

export function printHelp(): void {
  console.log(helpText());
}

async function main() {
  const args = process.argv.slice(2);

  // Everything after `--` is the agent command. Without a separator the
  // gateway's own options are still recognised and whatever is left over is
  // the command, so `acp-gateway --agent gemini` needs no trailing `--`.
  const cmdStartIndex = args.indexOf("--");
  const gatewayArgs = cmdStartIndex !== -1 ? args.slice(0, cmdStartIndex) : args;
  const options = parseGatewayArgs(gatewayArgs);
  const explicitCommand =
    cmdStartIndex !== -1 ? args.slice(cmdStartIndex + 1) : options.rest;

  const { maxConcurrency, command, authMethodId } = options;

  if (command === "help") {
    printHelp();
    process.exit(0);
  }

  // Listing the registry needs neither a workspace nor an agent.
  if (command === "list-agents") {
    await runListAgents(options.registryUrl);
    process.exit(0);
  }

  // Nothing to run: the reason someone is looking at the terminal now is that
  // they do not yet know what to type, so show the help rather than an error
  // about a workspace they have not got to yet.
  if (!options.agentId && explicitCommand.length === 0) {
    printHelp();
    process.exit(1);
  }

  console.log(`Starting [acp-gateway] ${pkg.name} v${pkg.version}`);

  // 1. Load MCP Config
  const configs = loadMcpConfig();
  const agentrqConfig = pickAgentrqServer(configs);

  // 2. Work out what actually starts the agent — a registry id, or the command
  // the user gave.
  // These failures are all things the user can act on — an unknown registry
  // id, no build for this platform, an unverifiable download, a mistyped
  // command — so they get a sentence rather than a stack trace.
  const fail = (err: unknown): never => {
    console.error(`[acp-gateway] ${err instanceof Error ? err.message : err}`);
    return process.exit(1);
  };

  const resolved = await resolveAgentCommand(options, explicitCommand).catch(fail);
  const acpCmdArgs = resolved.command;
  try {
    assertAgentRunnable(acpCmdArgs[0], Boolean(options.agentId));
  } catch (err) {
    fail(err);
  }
  if (resolved.env) {
    // The registry entry's env is part of how that agent must be launched, so
    // it travels with the command into every session spawned from it.
    agentrqConfig.env = { ...agentrqConfig.env, ...resolved.env };
  }

  authConfig.methodId = authMethodId;
  modelConfig.modelId = options.modelId;
  permissionConfig.timeoutMs = options.permissionTimeoutMs;

  const taskQueue = new TaskQueue(maxConcurrency);

  // 3. Initialize MCP Bridge
  const mcpBridge = new MCPBridge(agentrqConfig);

  // Auth commands talk to the agent and exit; they never start bridging tasks.
  // They run before the bridge connects, so a first-time login still works when
  // the workspace is unreachable — `callTool` connects on demand if the login
  // actually needs to reach agentrq.
  if (command !== "run") {
    try {
      await runAgentCommand(command, acpCmdArgs, agentrqConfig, mcpBridge, authMethodId);
    } finally {
      await mcpBridge.close();
    }
    process.exit(0);
  }

  await mcpBridge.connect();

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = async (signal?: string) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (signal) {
        console.error(
          `\n[acp-gateway] Received ${signal}, closing active sessions and shutting down...`,
        );
      }
      try {
        await closeAllSessions();
      } catch (err) {
        console.error("[acp-gateway] Error closing active sessions:", err);
      }
      try {
        await mcpBridge.close();
      } catch (err) {
        console.error("[acp-gateway] Error closing MCP bridge:", err);
      }
    })();
    return cleanupPromise;
  };

  const removeSignalHandlers = setupSignalHandlers(async (signal) => {
    await cleanup(signal);
    process.exit(0);
  });

  try {
    // Bridge: MCP -> ACP
    // When the MCP server sends a notification to 'notifications/claude/channel',
    // it contains a new task content.
    mcpBridge.on("task", ({ content, meta }) => {
      const taskId = extractTaskIdFromMeta(meta);
      if (taskId) {
        if (lastTaskContent.get(taskId) === content) {
          console.log(`[bridge] Dropping repetitive task notification for ${taskId}`);
          return;
        }
        lastTaskContent.set(taskId, content);
      }
      console.error(
        "\n[bridge] Incoming task from MCP server. Forwarding to ACP agent...",
      );
      const queuedSeq = nextTaskSeq();
      taskQueue.run(async () => {
        if (isTaskCancelled(taskId, queuedSeq)) {
          console.error(
            `[bridge] Task ${taskId} was cancelled before execution started, skipping`,
          );
          return;
        }
        try {
          const sessionInfo = await getOrCreateSession(
            taskId,
            acpCmdArgs,
            configs,
            agentrqConfig,
            mcpBridge,
          );
          if (isTaskCancelled(taskId, queuedSeq)) {
            console.error(
              `[bridge] Task ${taskId} was cancelled during session setup, cancelling session`,
            );
            await sessionInfo.acpClient.cancelTurn(sessionInfo.sessionId);
            return;
          }
          const result = await sessionInfo.connection.prompt({
            sessionId: sessionInfo.sessionId,
            prompt: [{ type: "text", text: content }],
          });

          await sessionInfo.acpClient.flushReply(sessionInfo.sessionId);
          await sessionInfo.acpClient.reportStopReason(
            sessionInfo.sessionId,
            result.stopReason,
          );
          console.error(
            `\n[acp] Agent completed task. Reason: ${result.stopReason}`,
          );
        } catch (err) {
          console.error("[acp] Error during prompt execution:", err);
        }
      }).catch((err) => {
        console.error("[bridge] Error queuing task:", err);
      });
    });

    // Listen for task cancellation events from the MCP bridge
    mcpBridge.on("cancel", ({ taskId, reason }: { taskId?: string; reason?: string }) => {
      handleTaskCancellation(taskId, reason).catch((err) => {
        console.error("[bridge] Error handling task cancellation:", err);
      });
    });

    // Initial check for a pending task
    await checkForNextTask(
      mcpBridge,
      acpCmdArgs,
      configs,
      agentrqConfig,
      taskQueue,
    );

    // Keep the process alive
    await new Promise(() => { });
  } catch (error) {
    console.error("[acp-gateway] Error:", error);
  } finally {
    removeSignalHandlers();
    await cleanup();
    process.exit(0);
  }
}

/**
 * Checks for the next pending task using the 'getTask' tool on the MCP server.
 * Called with no taskId, 'getTask' dequeues the next not-started task.
 * If found, sends it to the ACP agent.
 */
export async function checkForNextTask(
  mcpBridge: MCPBridge,
  acpCmdArgsOrConnection: string[] | acp.ClientSideConnection,
  configsOrSessionSwitcher: McpServerConfig[] | ReturnType<typeof createAcpSessionSwitcher> | unknown,
  agentrqConfigOrAcpClient: McpServerConfig | AgentRQACPClient,
  taskQueue?: TaskQueue,
  acpCmdArgs?: string[],
  configs?: McpServerConfig[],
  agentrqConfig?: McpServerConfig,
) {
  console.error("[bridge] Checking for next task via MCP server...");
  // Stamped before the fetch, so a cancel that arrives while `getTask` is in
  // flight (or while the session is being opened) still stops the task.
  const queuedSeq = nextTaskSeq();
  try {
    const result = await mcpBridge.callTool("getTask");

    if (result.isError) {
      console.error("[mcp] Error getting next task:", result.content);
      return;
    }

    const contentBlock = result.content as Array<{
      type: string;
      text?: string;
    }>;
    const content = contentBlock[0] as { type: string; text: string };
    if (
      content &&
      content.text &&
      !content.text.includes("no pending tasks exist")
    ) {
      const text = content.text;
      const taskId = extractTaskIdFromText(text);
      if (taskId) {
        if (lastTaskContent.get(taskId) === text) {
          console.log(`[bridge] Dropping repetitive checked task for ${taskId}`);
          return;
        }
        lastTaskContent.set(taskId, text);
      }
      console.error(
        `[bridge] Found task: "${text.slice(0, 50).replace(/\n/g, " ")}..."`,
      );

      const runFn = async () => {
        if (isTaskCancelled(taskId, queuedSeq)) {
          console.error(
            `[bridge] Task ${taskId} was cancelled before execution started, skipping`,
          );
          return;
        }
        let connectionToUse: acp.ClientSideConnection | undefined;
        let acpClientToUse: AgentRQACPClient | undefined;
        let sessionIdToUse: string | undefined;

        let actualAcpCmdArgs: string[] = [];
        let actualConfigs: McpServerConfig[] = [];
        let actualAgentrqConfig: McpServerConfig | undefined;

        if (Array.isArray(acpCmdArgsOrConnection)) {
          actualAcpCmdArgs = acpCmdArgsOrConnection;
          actualConfigs = configsOrSessionSwitcher as McpServerConfig[];
          actualAgentrqConfig = agentrqConfigOrAcpClient as McpServerConfig;
        } else {
          connectionToUse = acpCmdArgsOrConnection as acp.ClientSideConnection;
          acpClientToUse = agentrqConfigOrAcpClient as AgentRQACPClient;
          const switcher = configsOrSessionSwitcher as any;
          if (switcher && typeof switcher.ensureForTask === "function") {
            sessionIdToUse = await switcher.ensureForTask(taskId);
          }
          actualAcpCmdArgs = acpCmdArgs || [];
          actualConfigs = configs || [];
          actualAgentrqConfig = agentrqConfig;
        }

        if (!connectionToUse) {
          const sessionInfo = await getOrCreateSession(
            taskId,
            actualAcpCmdArgs,
            actualConfigs,
            actualAgentrqConfig!,
            mcpBridge,
          );
          connectionToUse = sessionInfo.connection;
          sessionIdToUse = sessionInfo.sessionId;
          acpClientToUse = sessionInfo.acpClient;
        }

        // Spawning the agent and opening the session takes seconds; a cancel
        // that lands in that window has no turn to stop yet, so check again
        // before handing the agent the work.
        if (isTaskCancelled(taskId, queuedSeq)) {
          console.error(
            `[bridge] Task ${taskId} was cancelled during session setup, cancelling session`,
          );
          await acpClientToUse?.cancelTurn(sessionIdToUse);
          return;
        }

        const promptResult = await connectionToUse.prompt({
          sessionId: sessionIdToUse!,
          prompt: [{ type: "text", text }],
        });

        await acpClientToUse!.flushReply(sessionIdToUse!);
        await acpClientToUse!.reportStopReason(sessionIdToUse!, promptResult.stopReason);
        console.error(`\n[acp] Agent completed with: ${promptResult.stopReason}`);
      };

      if (taskQueue) {
        await taskQueue.run(runFn);
      } else {
        await runFn();
      }
    } else {
      console.error("[bridge] No pending tasks available.");
    }
  } catch (err) {
    console.error("[bridge] Failed to check for next task:", err);
  }
}

if (process.env.NODE_ENV !== "test") {
  // Keep the gateway alive across transient failures. The MCP transport has its
  // own reconnect logic (mcpClient.ts), so a stray rejected promise or async
  // error from a dropped connection should be logged, not fatal. Without these
  // nets, Node terminates the process on the first unhandled rejection.
  process.on("unhandledRejection", (reason) => {
    console.error("[acp-gateway] Unhandled promise rejection (continuing):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[acp-gateway] Uncaught exception (continuing):", err);
  });

  // A rejection from main() itself means startup failed before the bridge was
  // established — that is genuinely fatal, so exit.
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}
