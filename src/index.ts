#!/usr/bin/env node
/**
 * index.ts
 *
 * The main entry point for acp-gateway.
 * Orchestrates the bridge between the ACP Agent and the agentrq MCP Server.
 */

import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { readFileSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

import { loadMcpConfig, pickAgentrqServer, type McpServerConfig } from "./config.js";
import { MCPBridge } from "./mcpClient.js";

export function mapMcpServers(configs: McpServerConfig[]): acp.McpServer[] {
  return configs.map((cfg): acp.McpServer => {
    if (cfg.type === "http") {
      return {
        type: "http",
        name: cfg.name,
        url: cfg.url!,
        headers: Object.entries(cfg.headers || {}).map(([name, value]) => ({ name, value })) as any,
      };
    } else {
      return {
        name: cfg.name,
        command: cfg.command!,
        args: cfg.args ?? [],
        env: Object.entries(cfg.env || {}).map(([name, value]) => ({ name, value })) as any,
      };
    }
  });
}
import { AgentRQACPClient } from "./acpClient.js";
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
  describeAgents,
  fetchRegistry,
  hostPlatformTarget,
} from "./registry.js";
import {
  extractTaskIdFromMeta,
  extractTaskIdFromText,
} from "./taskIdentity.js";

const lastTaskContent = new Map<string, string>();

export interface AgentSession {
  process: any;
  connection: acp.ClientSideConnection;
  acpClient: AgentRQACPClient;
  sessionId: string;
  initResult: acp.InitializeResponse;
}

export const activeSessions = new Map<string, AgentSession>();

/** Login preferences taken from the CLI, consulted whenever an agent demands auth. */
export const authConfig: { methodId?: string } = {};

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

  // Guard against unhandled child-process failures. Without these listeners a
  // crashed agent (e.g. on network loss) leaves a broken stdin pipe; the next
  // write raises EPIPE as an uncaught error and takes the gateway down with it.
  agentProcess.on("error", (err: Error) => {
    console.error(`[acp] Agent process error for ${label}:`, err.message);
    onExit?.();
  });
  agentProcess.on("exit", (code: number | null, signal: string | null) => {
    console.error(
      `[acp] Agent process for ${label} exited (code=${code}, signal=${signal})`,
    );
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

  const acpClient = new AgentRQACPClient(mcpBridge, () => taskId);
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(
    (_agent) => acpClient,
    stream,
  );

  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      elicitation: {
        form: {},
        url: {},
      },
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
    mcpServers: mapMcpServers(configs),
  };

  const sessionResult = await createSessionWithAuth(connection, newSessionParams, {
    methods: initResult.authMethods,
    launch: { command: cmd, args: cmdArgs, env: agentrqConfig.env },
    preferredId: authConfig.methodId,
    interactive: isInteractiveTerminal(),
  });
  console.error(`[acp] Created session ${sessionResult.sessionId} for task ${key}`);

  await enforceHumanApprovalMode(connection, sessionResult);

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
  | "help";

export interface GatewayOptions {
  maxConcurrency: number;
  authMethodId?: string;
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
    maxConcurrency: 2,
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
      case "--auth-method":
        if (value) {
          options.authMethodId = value;
          i++;
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
 * Runs a one-shot auth command against the agent and shuts it down again.
 *
 * These commands exist so a login can be done deliberately — before any task
 * arrives — rather than only when a session is refused.
 */
export async function runAuthCommand(
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

    if (command === "list-auth-methods") {
      console.log(
        `Authentication methods for "${acpCmdArgs.join(" ")}":\n${describeAuthMethods(authMethods)}`,
      );
      if (supportsLogout(agentCapabilities)) {
        console.log("\nThe agent also supports --logout.");
      }
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
                              Defaults to 2.

OTHER
  --help, -h                  Show this help. Exits.

EXAMPLES
  acp-gateway --agent gemini                     Run Gemini from the registry
  acp-gateway -- gemini --acp                    Run an agent you installed
  acp-gateway --list-agents                      See what the registry offers
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
  const resolved = await resolveAgentCommand(options, explicitCommand);
  const acpCmdArgs = resolved.command;
  if (resolved.env) {
    // The registry entry's env is part of how that agent must be launched, so
    // it travels with the command into every session spawned from it.
    agentrqConfig.env = { ...agentrqConfig.env, ...resolved.env };
  }

  authConfig.methodId = authMethodId;

  const taskQueue = new TaskQueue(maxConcurrency);

  // 3. Initialize MCP Bridge
  const mcpBridge = new MCPBridge(agentrqConfig);

  // Auth commands talk to the agent and exit; they never start bridging tasks.
  // They run before the bridge connects, so a first-time login still works when
  // the workspace is unreachable — `callTool` connects on demand if the login
  // actually needs to reach agentrq.
  if (command !== "run") {
    try {
      await runAuthCommand(command, acpCmdArgs, agentrqConfig, mcpBridge, authMethodId);
    } finally {
      await mcpBridge.close();
    }
    process.exit(0);
  }

  await mcpBridge.connect();

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
      taskQueue.run(async () => {
        try {
          const sessionInfo = await getOrCreateSession(
            taskId,
            acpCmdArgs,
            configs,
            agentrqConfig,
            mcpBridge,
          );
          const result = await sessionInfo.connection.prompt({
            sessionId: sessionInfo.sessionId,
            prompt: [{ type: "text", text: content }],
          });

          await sessionInfo.acpClient.flushReply(sessionInfo.sessionId);
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
    for (const session of activeSessions.values()) {
      session.process.kill();
    }
    await mcpBridge.close();
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
  configsOrSessionSwitcher: McpServerConfig[] | ReturnType<typeof createAcpSessionSwitcher>,
  agentrqConfigOrAcpClient: McpServerConfig | AgentRQACPClient,
  taskQueue?: TaskQueue,
  acpCmdArgs?: string[],
  configs?: McpServerConfig[],
  agentrqConfig?: McpServerConfig,
) {
  console.error("[bridge] Checking for next task via MCP server...");
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

        const promptResult = await connectionToUse.prompt({
          sessionId: sessionIdToUse!,
          prompt: [{ type: "text", text }],
        });

        await acpClientToUse!.flushReply(sessionIdToUse!);
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

