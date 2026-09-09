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
import {
  agentIdentity,
  describeAgentInfo,
  sendAgentIdentity,
  type AgentIdentity,
} from "./agentInfo.js";
import {
  describeAgents,
  fetchRegistry,
  findAgent,
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
  /** Hands this session to a task, re-keying it and re-attributing its reports. */
  adopt(taskId: string): void;
}

/**
 * Where the session opened before any task is filed.
 *
 * It exists so a connected gateway can say what its agent offers — models and
 * slash commands only exist inside a session, and ACP has no way to ask
 * outside one — and it is handed to the first task rather than duplicated.
 */
export const IDLE_SESSION_KEY = "default";

export const activeSessions = new Map<string, AgentSession>();

/**
 * The startup session while it is still being opened.
 *
 * Opening one can take a long time — an agent that wants authentication stops
 * and waits for a human — and a task arriving in that window would find nothing
 * in `activeSessions` and start a second agent beside the one already coming
 * up. Waiting for the answer costs nothing and is the difference between one
 * agent and two.
 */
let idleSessionInFlight: Promise<AgentSession> | null = null;

/** Forgets any in-flight startup session. For tests. */
export function resetIdleSession(): void {
  idleSessionInFlight = null;
}

/**
 * What closing a session actually needs.
 *
 * Narrower than AgentSession on purpose: `--list-models` opens a session that
 * belongs to no task and closes it again, and it should not have to invent the
 * task bookkeeping it will never use.
 */
export type ClosableSession = Omit<AgentSession, "adopt">;

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
  session: ClosableSession,
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
    terminateAgentProcess(session.process);
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
  /** Attributes everything this connection reports to a task. */
  assignTask?: (taskId: string) => void;
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
 * Ends an agent process, and on Windows everything it started.
 *
 * `kill()` on Windows terminates only the process it is handed. A batch-file
 * agent runs under a cmd.exe wrapper, and npm runners start the real agent as
 * a child of their own, so killing what we spawned would leave the agent
 * itself running with nobody left to talk to it.
 */
export function terminateAgentProcess(
  child: { pid?: number; kill: () => unknown } | undefined,
  platform: string = process.platform,
  spawnImpl: typeof spawn = spawn,
): void {
  if (!child) return;
  if (platform !== "win32" || child.pid === undefined) {
    child.kill();
    return;
  }
  const killer = spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
  });
  // taskkill is part of Windows, but if it cannot be run the agent should
  // still go away — even if its own children outlive it.
  killer.on("error", () => child.kill());
  killer.unref();
}

/**
 * The suffixes a bare Windows command may be found under.
 *
 * PATHEXT lists what the shell will append to a name that has no suffix. A
 * name that already carries one of those suffixes — `npx.cmd`, say — is on
 * disk under that exact name, so appending to it would only ever miss.
 */
function windowsCandidateSuffixes(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const lower = command.toLowerCase();
  if (pathext.some((ext) => lower.endsWith(ext.toLowerCase()))) return [""];
  return pathext;
}

/**
 * The file a bare command name resolves to along PATH, if any.
 *
 * PATHEXT is honoured on Windows, where an executable is rarely named without
 * a suffix — unless the name already carries one, in which case it is looked
 * for as written.
 */
export function resolveOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | undefined {
  const extensions = platform === "win32" ? windowsCandidateSuffixes(command, env) : [""];
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH ?? "").split(separator).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Whether a command is written as a path rather than a name to look up. */
function isPathLike(command: string, platform: string): boolean {
  return command.includes("/") || (platform === "win32" && command.includes("\\"));
}

/**
 * The file to actually spawn for a command.
 *
 * On Windows the suffix decides whether a shell is needed at all, so a bare
 * name is resolved along PATH first rather than assumed: a stock npm install
 * ships `npx` as a batch file, while a version manager such as Volta shims it
 * as an .exe that can be spawned directly. Elsewhere the name is left alone —
 * spawn resolves it, and no suffix changes how it starts.
 */
export function spawnTarget(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  if (platform !== "win32" || isPathLike(command, platform)) return command;
  return resolveOnPath(command, env, platform) ?? command;
}

/**
 * Whether a command can only be started through a shell.
 *
 * A Windows batch file is not an executable, and since the fix for
 * CVE-2024-27980 (Node 18.20.2 / 20.12.2) `spawn` refuses one outright unless
 * a shell is asked for. A stock npm install ships its runners as `.cmd`, so
 * this is where most npm-distributed agents end up.
 */
export function needsShell(command: string, platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  const lower = command.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

/**
 * Characters cmd.exe acts on rather than passes along.
 *
 * A caret in front of one makes cmd.exe treat it as text — including a space,
 * which is how a program name with a space in it survives without quotes.
 */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escapes the program name for cmd.exe.
 */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/**
 * The npm-generated wrappers that re-enter cmd.exe with the arguments they
 * were given, so that anything escaped for cmd.exe is read a second time.
 */
const CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/**
 * Escapes one argument for a command line cmd.exe hands to a batch file.
 *
 * The line is parsed twice: cmd.exe reads it, then the program's own argument
 * parser reads what cmd.exe passed on. So each argument is quoted for the
 * program (backslash runs before a quote are doubled, per the Windows
 * command-line rules at https://qntm.org/cmd) and the result is then escaped
 * for cmd.exe — twice over for a shim that will hand the line to cmd.exe
 * again. This is the algorithm `cross-spawn` uses, reproduced here rather
 * than taken as a dependency.
 */
export function quoteForCmd(arg: string, doubleEscape = false): string {
  const quoted = `"${escapeBackslashesAndQuotes(arg)}"`;
  const escaped = quoted.replace(CMD_META_CHARS, "^$1");
  return doubleEscape ? escaped.replace(CMD_META_CHARS, "^$1") : escaped;
}

/**
 * Applies the Windows argument rule: a run of backslashes is doubled when a
 * quote (or the closing quote) follows it, and left alone otherwise, and a
 * literal quote is escaped.
 *
 * Written as a single pass rather than the two regexes this used to use.
 * `/(\\*)"/g` asks the engine to match a run of backslashes and then a quote,
 * so a long run with no quote after it is re-tried from every position in the
 * run — quadratic in the length of the run, which is the sort of thing an
 * argument can carry. Counting the run once cannot do that, and says the rule
 * more plainly than the regex did.
 */
function escapeBackslashesAndQuotes(arg: string): string {
  let out = "";
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') {
      // The run escapes the quote we are about to add rather than the one in
      // the argument, so it has to survive as literal backslashes: double it.
      out += "\\".repeat(slashes * 2) + '\\"';
    } else {
      out += "\\".repeat(slashes) + ch;
    }
    slashes = 0;
  }
  // Whatever is left runs into the closing quote, so it is doubled too.
  return out + "\\".repeat(slashes * 2);
}

/**
 * The command and arguments to hand `spawn`.
 *
 * Everywhere but a Windows shell spawn these are passed through untouched:
 * `spawn` gives each argument to the child as its own, with no shell in
 * between to re-split them.
 */
export function spawnArgsFor(
  command: string,
  args: string[],
  platform: string = process.platform,
): [string, string[]] {
  if (!needsShell(command, platform)) return [command, args];
  const doubleEscape = CMD_SHIM.test(command);
  return [escapeCmdCommand(command), args.map((arg) => quoteForCmd(arg, doubleEscape))];
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

  const target = spawnTarget(cmd);
  if (target !== cmd) console.error(`[acp] Resolved "${cmd}" to ${target}`);
  const agentProcess = spawn(...spawnArgsFor(target, cmdArgs), {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
    shell: needsShell(target),
  });

  // Read through a holder rather than captured directly: a session created
  // before any task exists is later handed to the first one, and everything it
  // reports afterwards has to be attributed to that task.
  let currentTaskId = taskId;
  const acpClient = new AgentRQACPClient(mcpBridge, () => currentTaskId, {
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

  return {
    process: agentProcess,
    connection,
    acpClient,
    initResult,
    assignTask: (id: string) => {
      currentTaskId = id;
    },
  };
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
    // Everything from here is the login, so everything that goes wrong in it is
    // an authentication failure — whether that is a refusal to pick a method, a
    // terminal login the human abandoned, or the agent still saying no
    // afterwards. Typing it here beats reading messages downstream and missing
    // whichever one nobody thought of.
    try {
      await login({ ...auth, connection: connection as unknown as AuthConnection });
      return await connection.newSession(params);
    } catch (authErr) {
      throw new AuthenticationFailed(authErr, Boolean(auth.methods?.length));
    }
  }
}

/**
 * An agent that could not be authenticated, however the login went wrong.
 *
 * `hasLogin` says whether the agent offered a way in at all. An agent that
 * advertises none is not asking to be logged in — it wants a credential it
 * reads for itself, an API key in the environment or a file on disk — and
 * telling its owner to log in would send them looking for a prompt that does
 * not exist.
 */
export class AuthenticationFailed extends Error {
  constructor(
    readonly cause: unknown,
    readonly hasLogin: boolean = true,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AuthenticationFailed";
  }
}

export async function getOrCreateSession(
  taskId: string | undefined,
  acpCmdArgs: string[],
  configs: McpServerConfig[],
  agentrqConfig: McpServerConfig,
  mcpBridge: MCPBridge,
): Promise<AgentSession> {
  let sessionKey = taskId || IDLE_SESSION_KEY;
  const existing = activeSessions.get(sessionKey);
  if (existing) {
    return existing;
  }

  // The session made at startup, before any task, is handed to the first task
  // that arrives rather than left beside a second agent doing the same job. Its
  // conversation is empty, so there is nothing for the task to inherit but the
  // process itself.
  if (taskId) {
    // Still coming up — wait for it rather than racing it into a second agent.
    if (idleSessionInFlight) {
      try {
        await idleSessionInFlight;
      } catch {
        // It failed; this task opens its own below, and reports the failure
        // itself rather than inheriting a stale one.
      }
    }
    const idle = activeSessions.get(IDLE_SESSION_KEY);
    if (idle) {
      idle.adopt(taskId);
      console.error(`[acp] Task ${taskId} took over the session opened at startup`);
      return idle;
    }
  }

  const [cmd, ...cmdArgs] = acpCmdArgs;
  const { process: agentProcess, connection, acpClient, initResult, assignTask } =
    await openAgentConnection({
      acpCmdArgs,
      mcpBridge,
      env: agentrqConfig.env,
      label: taskId ? `task ${taskId}` : "the idle session",
      taskId,
      onExit: () => activeSessions.delete(sessionKey),
    });

  const newSessionParams: AcpNewSessionParams = {
    cwd: process.cwd(),
    mcpServers: mapMcpServers(configs, initResult.agentCapabilities),
  };

  // From here on the agent is running but nothing is tracking it yet: it only
  // reaches activeSessions once a session exists, and closeAllSessions can only
  // close what is in there. So anything that goes wrong in between has to take
  // the process with it, or it is left running with nothing attached — an agent
  // that quits when its stdin closes gets away with it, and one with its own
  // event loop, which is the sort that wants a login, does not.
  try {

  // An agent that demands authentication stops here and waits, including at
  // startup — that is the point of starting a session then. A terminal is where
  // someone can actually answer, and finding out on the first task instead
  // means a gateway that looked connected all along.
  //
  // Headless, `login` refuses rather than blocking on a prompt nobody can see:
  // it only offers a terminal method to an interactive terminal, and throws a
  // message naming --auth-method otherwise. openIdleSession logs that and
  // leaves the gateway up.
  const sessionResult = await createSessionWithAuth(connection, newSessionParams, {
    methods: initResult.authMethods,
    launch: { command: cmd, args: cmdArgs, env: agentrqConfig.env },
    preferredId: authConfig.methodId,
    interactive: isInteractiveTerminal(),
  });
  console.error(
    `[acp] Created session ${sessionResult.sessionId} for ${taskId ? `task ${taskId}` : "the idle session"}`,
  );

  // Tell the workspace which agent this actually is. Its MCP client is this
  // gateway, so without this the workspace can only ever name the bridge.
  void acpClient.sendAgentToWorkspace(
    sessionResult.sessionId,
    agentIdentity(initResult, acpCmdArgs.join(" ")),
  );

  try {
    const modelsResult = extractModels(sessionResult.configOptions);
    if (modelsResult) {
      await applyModelSelection({
        connection,
        acpClient,
        sessionId: sessionResult.sessionId,
        known: modelsResult,
        requested: modelConfig.modelId,
      });
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
    adopt(nextTaskId: string) {
      activeSessions.delete(sessionKey);
      sessionKey = nextTaskId;
      activeSessions.set(sessionKey, sessionInfo);
      assignTask?.(nextTaskId);
    },
  };
    activeSessions.set(sessionKey, sessionInfo);
    return sessionInfo;
  } catch (err) {
    terminateAgentProcess(agentProcess);
    throw err;
  }
}

/**
 * Finds the active agent session for a given task ID (or returns the single active session if none specified).
 */
/**
 * Opens a session before any task, so the workspace can say what this agent
 * offers rather than only that something is attached.
 *
 * Models arrive as config options on `session/new` and slash commands as a
 * session notification, so there is no way to learn either without a session —
 * ACP has no question to ask outside one.
 *
 * An agent that demands authentication stops and waits here, which is much of
 * the value of starting a session at all: the terminal someone just typed into
 * is where they can answer.
 *
 * If that login does not happen — refused, or headless where there is nobody to
 * ask — the gateway shuts down rather than carrying on. It would otherwise sit
 * there looking connected, take every task the workspace gave it and fail all
 * of them, which is worse than not running: the workspace would show a live
 * agent while the work quietly went nowhere.
 *
 * Every other failure is survivable and is survived. An agent that could not be
 * spawned may simply have lost a race; it used to fail when the first task
 * arrived and it still does, and turning that into a gateway that refuses to
 * run would be a worse trade than the one this is making.
 *
 * The session is handed to the first task rather than left running beside it —
 * see getOrCreateSession.
 */
export async function openIdleSession(
  acpCmdArgs: string[],
  configs: McpServerConfig[],
  agentrqConfig: McpServerConfig,
  mcpBridge: MCPBridge,
  loginCommand: string = loginCommandFor(),
  timeoutMs: number = IDLE_SESSION_TIMEOUT_MS,
): Promise<IdleSessionOutcome> {
  try {
    // Cleared when the session itself settles rather than when this returns:
    // after a timeout the session is still coming, and a task that arrives
    // meanwhile should still wait for it instead of starting a second agent.
    idleSessionInFlight = getOrCreateSession(
      undefined,
      acpCmdArgs,
      configs,
      agentrqConfig,
      mcpBridge,
    );
    const settled = idleSessionInFlight;
    void settled.catch(() => {}).finally(() => {
      if (idleSessionInFlight === settled) idleSessionInFlight = null;
    });
    // Bounded: nothing reaches the workspace until this settles, so an agent
    // that spawns and then never answers its handshake would otherwise take the
    // whole gateway down with it — a worse failure than the one being fixed,
    // and a new one. On a timeout the gateway carries on; the session may still
    // arrive, and the first task will adopt it if it does.
    const timedOut = Symbol("timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      idleSessionInFlight,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (result === timedOut) {
      console.error(
        `[acp] The agent has not opened a session after ${Math.round(timeoutMs / 1000)}s; ` +
          "carrying on without knowing what it offers.",
      );
      return "unknown";
    }
    return "ready";
  } catch (err) {
    if (err instanceof AuthenticationFailed || isAuthRequiredError(err)) {
      const remedy =
        err instanceof AuthenticationFailed && !err.hasLogin
          ? `It offers no way to log in through acp-gateway, so it is expecting a credential ` +
            `of its own — an API key in the environment, or whatever its own documentation ` +
            `asks for. Set that and start acp-gateway again.`
          : `Log in with:\n\n    ${loginCommand}\n\nthen start acp-gateway again.`;
      console.error(
        `\n[acp-gateway] The agent will not start a session until it is authenticated: ` +
          `${err instanceof Error ? err.message : String(err)}\n` +
          `Nothing was started. ${remedy}\n` +
          `Carrying on would leave the workspace showing a live agent that fails every task ` +
          `it is given.`,
      );
      return "unauthenticated";
    }
    console.error(
      "[acp] Could not open a session to learn what the agent offers; " +
        "the first task will start one:",
      err instanceof Error ? err.message : String(err),
    );
    return "unknown";
  }
}

/**
 * The command that logs this agent in, so the message can name it rather than
 * leave someone to work it out.
 *
 * Built from how the gateway itself was started: the registry id when there was
 * one, and otherwise the command after `--`, since that is the only handle on
 * an agent nobody named.
 */
export function loginCommandFor(
  agentId?: string,
  agentCommand: string[] = [],
): string {
  const base = "npx @agentrq/acp-gateway@latest --login";
  if (agentId) return `${base} --agent ${agentId}`;
  if (agentCommand.length) return `${base} -- ${agentCommand.join(" ")}`;
  return base;
}

/**
 * What came of trying to open a session before any task.
 *
 * `ready` means the agent is up and has said what it is — including its own
 * name, so nothing else should name it. `unknown` means the gateway is running
 * but cannot describe its agent. `unauthenticated` means it never will.
 */
export type IdleSessionOutcome = "ready" | "unknown" | "unauthenticated";

/**
 * How long to wait for an agent to open its first session.
 *
 * Generous because the wait includes starting the agent, and an `npx`
 * distribution downloads its package the first time it is spawned — a cold
 * install of a large one on a slow line is minutes, not seconds. (A registry
 * *binary* is already on disk by now: that download happens while the launch
 * command is being resolved, before any of this.)
 *
 * Erring long costs little. A session that arrives after the deadline is still
 * recorded, still reports what the agent offers, and is still adopted by the
 * first task — the timeout only decides how long the gateway waits before
 * connecting to the workspace without knowing those things yet.
 */
export const IDLE_SESSION_TIMEOUT_MS = 5 * 60_000;



export function findActiveSession(taskId?: string): AgentSession | undefined {
  if (taskId) {
    const direct = activeSessions.get(taskId);
    if (direct) return direct;
    for (const session of activeSessions.values()) {
      if (session.sessionId === taskId) return session;
    }
    // A session opened from a notification that carried no task id is keyed
    // under IDLE_SESSION_KEY; when it is the only one running, an id-carrying
    // cancel can only have meant it. Never fall back to a session keyed under a
    // *different* task id — that would abort an unrelated task.
    //
    // The session opened at startup shares that key until a task adopts it, so
    // this can now match one that has never run anything. That stays correct
    // either way: if it was reused for a task-less prompt it is the session the
    // cancel meant, and if it is untouched it has no turn to cancel.
    const untracked = activeSessions.get(IDLE_SESSION_KEY);
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
/**
 * Switches a session's model and tells the workspace what it ended up as.
 *
 * The one place a model is ever set, reached from two directions: the --model
 * flag as a session opens, and a selection made in the interface while it is
 * running. They were one block until the second existed; keeping two copies of
 * resolve-set-echo would have let the startup path and the runtime path drift
 * into disagreeing about what a failed switch looks like.
 *
 * Whatever happens, the workspace is told something. That is the contract the
 * interface is built on: it marks a chosen model pending and waits for a models
 * notification to settle it, so a switch that quietly failed would leave the
 * picker claiming a model the agent never adopted. Every path below ends in a
 * report — the new list on success, the old one on any failure.
 */
export async function applyModelSelection({
  connection,
  acpClient,
  sessionId,
  known,
  requested,
  configId,
}: {
  connection: acp.ClientSideConnection;
  acpClient: AgentRQACPClient;
  sessionId: string;
  /** What the session last advertised, when that is known. */
  known?: AgentModelsResult;
  /** The model asked for, by id or by display name. */
  requested?: string;
  /** The config option to write through, when the caller knows it. */
  configId?: string;
}): Promise<void> {
  const echo = (result?: AgentModelsResult) => {
    const fallback = result ?? known ?? acpClient.lastModelsFor(sessionId);
    if (fallback) void acpClient.sendModelsToWorkspace(sessionId, fallback);
  };

  // Nothing asked for, or already the current model: report and stop. Setting a
  // model the session is already on would be a needless round trip to the agent
  // for an answer nobody is waiting on.
  if (!requested || (known && requested === known.currentModelId)) {
    echo();
    return;
  }

  // Resolved by display name as well as by id, because --model is typed by a
  // human who may well have copied what the picker showed them. A selection
  // from the interface always carries an id and matches on the first branch.
  const target = known?.models.find((m) => m.id === requested || m.name === requested);
  if (known && !target) {
    console.error(
      `[acp] Requested model "${requested}" not found in available models: ${known.models.map((m) => m.id).join(", ")}`,
    );
    echo();
    return;
  }

  const option = configId ?? known?.configId;
  if (!option) {
    console.error(
      `[acp] Cannot set model "${requested}" for session ${sessionId}: no config option to write it to`,
    );
    echo();
    return;
  }

  const modelId = target?.id ?? requested;
  try {
    const updateRes = await setSessionModel(connection, sessionId, option, modelId);
    // The agent's own answer is preferred over anything assumed here — it is
    // what actually took effect. The constructed fallback is for agents that
    // answer without repeating their config, and marks the chosen model current
    // rather than leaving the interface with nothing selected.
    const updated =
      extractModels(updateRes.configOptions) ??
      (known
        ? {
            ...known,
            currentModelId: modelId,
            models: known.models.map((m) => ({ ...m, current: m.id === modelId })),
          }
        : undefined);
    echo(updated);
  } catch (err) {
    console.error(`[acp] Failed to set requested model "${requested}":`, err);
    echo();
  }
}

/**
 * Switches model on a session the workspace names, at the workspace's request.
 *
 * The session id on the wire is the agent's own, which is what activeSessions
 * is searched by — findActiveSession already matches on it, and on the task id
 * a session is filed under, so either identifies the same session.
 *
 * A set for a session that has gone still answers. The interface is holding a
 * pending model and only a models notification releases it, so staying silent
 * about a vanished session would leave it pending forever; echoing what was
 * last known lets it revert to the truth.
 */
export async function handleSetModel({
  sessionId,
  configId,
  modelId,
}: {
  sessionId?: string;
  configId?: string;
  modelId?: string;
}): Promise<void> {
  if (!modelId) {
    console.error("[bridge] Received a set_model notification naming no model");
    return;
  }

  const session = findActiveSession(sessionId);
  if (!session) {
    console.error(
      `[bridge] Received set_model for session ${sessionId ?? "(unnamed)"}, but no active session matches it`,
    );
    return;
  }

  console.error(
    `[bridge] Switching session ${session.sessionId} to model "${modelId}"`,
  );
  await applyModelSelection({
    connection: session.connection,
    acpClient: session.acpClient,
    sessionId: session.sessionId,
    known: session.acpClient.lastModelsFor(session.sessionId),
    requested: modelId,
    configId,
  });
}

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
): Promise<{ command: string[]; env?: Record<string, string>; identity?: AgentIdentity }> {
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

  // What the registry says this agent is. Known now, before it has been
  // started, which is the only reason a workspace can name it while the
  // gateway is idle — the agent itself does not speak until a task arrives.
  const entry = findAgent(registry, options.agentId);
  const identity: AgentIdentity | undefined = entry
    ? { name: entry.name || entry.id, version: entry.version }
    : undefined;

  return { command: [spec.command, ...spec.args], env: spec.env, identity };
}

/**
 * Whether a command can actually be run.
 *
 * A path is checked directly; a bare name is looked for along PATH.
 */
export function isRunnable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (isPathLike(command, platform)) return existsSync(command);
  return resolveOnPath(command, env, platform) !== undefined;
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
    terminateAgentProcess(agent.process);
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

    mcpBridge.on(
      "setModel",
      (params: { sessionId?: string; configId?: string; modelId?: string }) => {
        handleSetModel(params).catch((err) => {
          console.error("[bridge] Error handling model selection:", err);
        });
      },
    );

    // Everything above is listening; nothing below can be missed.
    //
    // The agent comes up before the workspace is told anything, so a task can
    // never be handed to a gateway whose agent is not ready — or, if it needs a
    // login nobody can give it, to one that will never be ready. Awaited for
    // that reason: whatever the workspace learns next, it learns about an agent
    // that already exists.
    //
    // The handlers above are registered first because opening that session
    // sends notifications, and sending one opens the connection. A task pushed
    // between the connection opening and something listening for it is a task
    // dropped on the floor.
    const idle = await openIdleSession(
      acpCmdArgs,
      configs,
      agentrqConfig,
      mcpBridge,
      loginCommandFor(options.agentId, explicitCommand),
    );
    if (idle === "unauthenticated") {
      // Nothing to unwind: the agent was terminated where it was spawned, and
      // the workspace connection below has not been opened yet.
      removeSignalHandlers();
      process.exit(1);
    }

    await mcpBridge.connect();

    // Only when the agent has not spoken for itself. A session that came up
    // already reported the agent's own name, title and version from its
    // handshake, and the registry's entry is a coarser answer to the same
    // question — sending it after would replace what the agent said about
    // itself with what an index says about it, dropping the title and swapping
    // the running version for a published one.
    if (idle !== "ready" && resolved.identity) {
      void sendAgentIdentity(mcpBridge, resolved.identity);
    }

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
