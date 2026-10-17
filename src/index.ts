#!/usr/bin/env node
/**
 * index.ts
 *
 * The main entry point for acp-gateway.
 *
 * `run` pipes an ACP agent's stdio to AgentRQ's ACP v1 endpoint (see
 * native.ts); AgentRQ is the ACP client and this process only moves bytes. The
 * one-shot commands — login, logout, listing models and the like — talk to the
 * agent here, with no workspace involved.
 */

import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as acp from "@agentclientprotocol/sdk";

import { loadMcpConfig, pickAgentrqServer, type McpServerConfig } from "./config.js";
import { runNative, type NativeOptions } from "./native.js";
import { nativeEndpoint, tokenFrom } from "./nativeFrames.js";
import { LocalACPClient } from "./localClient.js";
import {
  describeAuthMethods,
  isAuthRequiredError,
  login,
  logout,
  promptUrlElicitationOnTerminal,
  supportsLogout,
  type AuthConnection,
  type LoginOptions,
} from "./auth.js";
import { resolveAgentLaunch } from "./agentInstall.js";
import { describeAgentInfo } from "./agentInfo.js";
import {
  availableKinds,
  describeAgents,
  fetchRegistry,
  hostPlatformTarget,
  isAgentUnverified,
  type PlatformTarget,
} from "./registry.js";
import { extractModels, formatModelsText } from "./models.js";
import { MAX_MAX_CONCURRENCY, MIN_MAX_CONCURRENCY, normalizeConcurrency } from "./concurrency.js";
import { debug, followAgentStderr, isVerbose, setVerbose } from "./log.js";
import { pkg } from "./version.js";

/** How long a tool call waits for a human verdict by default: 30 minutes. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;

/** An agent spawned for a one-shot command, after its `initialize` handshake. */
export interface AgentConnection {
  process: any;
  connection: acp.ClientSideConnection;
  acpClient: LocalACPClient;
  initResult: acp.InitializeResponse;
}

/** What closing a session needs. */
export interface ClosableSession extends AgentConnection {
  sessionId: string;
}

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
 * Cleanly closes an agent session: `session/close` if the agent supports it
 * (bounded by a timeout), then the agent process itself.
 */
export async function closeSession(
  session: ClosableSession,
  timeoutMs: number = CLOSE_SESSION_TIMEOUT_MS,
): Promise<void> {
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
  } finally {
    session.acpClient?.dispose?.();
  }
}

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

export interface OpenAgentConnectionOptions {
  acpCmdArgs: string[];
  env?: Record<string, string>;
  /** Used in log lines to say which agent process is being talked about. */
  label: string;
  /** Where the agent process runs. Defaults to the gateway's own directory. */
  cwd?: string;
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
 * Whether an agent process ended badly. A clean exit, or one of the signals
 * the gateway itself ends agents with, is routine and not worth printing.
 */
export function agentExitFailed(code: number | null, signal: string | null): boolean {
  if (code !== null) return code !== 0;
  return signal !== null && !["SIGTERM", "SIGKILL", "SIGINT"].includes(signal);
}

/**
 * Shows the end of what a failed agent wrote to stderr. Under `--verbose` it
 * has already been printed as it arrived.
 */
export function showAgentStderr(tail: string): void {
  if (isVerbose() || !tail.trim()) return;
  console.error(`[acp] The agent's last output:\n${tail.trimEnd()}`);
}

/**
 * The "Starting" line is for a gateway that is going to keep running. A
 * command that prints an answer and exits should print just that answer.
 */
export function shouldPrintBanner(options: Pick<GatewayOptions, "command" | "json" | "verbose">): boolean {
  if (options.json) return false;
  return options.command === "run" || options.verbose;
}

/**
 * Spawns an ACP agent, wires the JSON-RPC streams to it and completes the
 * `initialize` handshake, returning the connection plus what the agent said
 * about itself — including the login methods it advertises.
 */
export async function openAgentConnection({
  acpCmdArgs,
  env,
  label,
  cwd,
}: OpenAgentConnectionOptions): Promise<AgentConnection> {
  const [cmd, ...cmdArgs] = acpCmdArgs;
  debug(`[acp] Spawning agent for ${label}: ${cmd} ${cmdArgs.join(" ")}`);

  const target = spawnTarget(cmd);
  if (target !== cmd) debug(`[acp] Resolved "${cmd}" to ${target}`);
  const agentProcess = spawn(...spawnArgsFor(target, cmdArgs), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    shell: needsShell(target),
    ...(cwd === undefined ? {} : { cwd }),
  });
  const agentStderr = followAgentStderr(agentProcess.stderr);

  const acpClient = new LocalACPClient({
    // A login URL belongs to whoever asked for the login, and at a terminal
    // that is the person reading it — so only offer the terminal prompt when
    // there is a terminal to read it at.
    promptUrlElicitation: isInteractiveTerminal() ? promptUrlElicitationOnTerminal : undefined,
  });

  // Guard against unhandled child-process failures. Without these listeners a
  // crashed agent leaves a broken stdin pipe; the next write raises EPIPE as an
  // uncaught error and takes the gateway down with it.
  agentProcess.on("error", (err: Error) => {
    console.error(`[acp] Agent process error for ${label}:`, err.message);
    showAgentStderr(agentStderr());
    acpClient.dispose();
  });
  agentProcess.on("exit", (code: number | null, signal: string | null) => {
    const message = `[acp] Agent process for ${label} exited (code=${code}, signal=${signal})`;
    if (agentExitFailed(code, signal)) {
      console.error(message);
      showAgentStderr(agentStderr());
    } else {
      debug(message);
    }
    acpClient.dispose();
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

  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: {
      name: pkg.name,
      version: pkg.version,
    },
    clientCapabilities: {
      elicitation: {
        url: {},
      },
      // Only claim terminal logins when we can actually hand the agent a
      // terminal; otherwise the agent may offer a method we cannot run.
      auth: {
        terminal: isInteractiveTerminal(),
      },
    },
  }).catch((err) => {
    // An agent that dies on startup takes the gateway with it before its exit
    // is ever reported, so its own explanation is shown here.
    showAgentStderr(agentStderr());
    throw err;
  });

  debug(
    `[acp] Connected to agent for ${label} (protocol v${initResult.protocolVersion})`,
  );
  if (initResult.authMethods?.length) {
    debug(
      `[auth] Agent offers these login methods:\n${describeAuthMethods(initResult.authMethods)}`,
    );
  }

  return {
    process: agentProcess,
    connection,
    acpClient,
    initResult,
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
  params: acp.NewSessionRequest,
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
export const DEFAULT_MAX_CONCURRENCY = MIN_MAX_CONCURRENCY;

export interface GatewayOptions {
  maxConcurrency: number;
  /** How long a tool call waits for a human verdict. 0 waits indefinitely. */
  permissionTimeoutMs: number;
  authMethodId?: string;
  modelId?: string;
  effort?: string;
  command: GatewayCommand;
  /** Registry id of the agent to run, instead of a command given after `--`. */
  agentId?: string;
  /** Install a registry binary the registry publishes no checksum for. */
  allowUnverifiedAgent: boolean;
  /**
   * Machine-readable output for `--list-agents` and `--list-models`, instead
   * of the tables meant for a terminal. Nothing else on the command line
   * checks it: a caller parsing this output wants the shape it was written
   * against to hold across releases, which a table meant for reading is never
   * promised to do.
   */
  json: boolean;
  /**
   * Print the gateway's working — connections, notifications, sessions, file
   * access, tool calls and the agent's streamed answer. Without it only what
   * the gateway is asked, what it waits on, how each turn ends, and errors.
   */
  verbose: boolean;
  /** A different registry index, for pinning or for testing. */
  registryUrl?: string;
  /**
   * A config file to read besides the one found near the working directory,
   * for a gateway run from somewhere other than the workspace it belongs to.
   */
  mcpJsonPath?: string;
  /** The ACP endpoint, when it cannot be worked out from .mcp.json. */
  acpUrl?: string;
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
    json: false,
    verbose: false,
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
        // A token that starts with a digit was meant as this flag's number, so
        // it is consumed whether or not it reads as one — left behind, it fell
        // into `rest`, which is the agent command when no `--` was used, and
        // `--max-concurrency 8x claude` went looking for an agent called "8x".
        //
        // A token that does not start with a digit was never the number. It is
        // the agent command with the number left out, and eating it would turn
        // `--max-concurrency claude` from a gateway running claude at the
        // default into a gateway with nothing to run at all.
        const looksNumeric = value !== undefined && /^[0-9]/.test(value);
        if (looksNumeric) i++;

        // Read by the same rule the workspace's set_concurrency goes through,
        // so the flag and the runtime control cannot disagree about what a
        // number means. It is also what stops `--max-concurrency 0`, which
        // used to be accepted and then held every task in the queue forever.
        const parsed = looksNumeric ? normalizeConcurrency(value) : undefined;
        if (parsed === undefined) {
          if (value !== undefined) {
            console.error(
              `[acp-gateway] --max-concurrency "${value}" is not a number of ` +
                `tasks; keeping ${options.maxConcurrency}.`,
            );
          }
          break;
        }

        // Said out loud, unlike the workspace's path, which reports the limit
        // it settled on back to the interface. Nothing reports a flag back to
        // the person who typed it, so an existing `--max-concurrency 128` would
        // otherwise quietly boot at the ceiling with no sign it had been cut.
        const asked = Number(value);
        if (Number.isFinite(asked) && Math.trunc(asked) !== parsed) {
          console.error(
            `[acp-gateway] --max-concurrency ${value} is outside ` +
              `${MIN_MAX_CONCURRENCY}-${MAX_MAX_CONCURRENCY}; using ${parsed}.`,
          );
        }
        options.maxConcurrency = parsed;
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
      case "--effort":
        if (value) {
          options.effort = value;
          i++;
        } else {
          console.error("[acp] Warning: --effort provided without a level; ignoring.");
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
      case "--json":
        options.json = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--registry-url":
        if (value) {
          options.registryUrl = value;
          i++;
        }
        break;
      case "--mcp-json":
        if (value) {
          options.mcpJsonPath = value;
          i++;
        } else {
          // Said out loud rather than ignored. The gateway would otherwise
          // start against whatever config happened to be near the working
          // directory, which is exactly what this flag was typed to avoid.
          console.error(
            "[acp-gateway] Warning: --mcp-json provided without a path; ignoring.",
          );
        }
        break;
      case "--acp-version":
        // ACP v1 is the only protocol the gateway speaks. The flag is still
        // read, so launch scripts written when it chose between modes keep
        // working with `--acp-version 1`.
        if (value !== "1") {
          console.error("[acp-gateway] --acp-version must be 1, the only version supported");
          process.exit(1);
        }
        i++;
        break;
      case "--acp-url":
        if (value) {
          options.acpUrl = value;
          i++;
        } else {
          console.error("[acp-gateway] Warning: --acp-url provided without a URL; ignoring.");
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
 *
 * `json` prints `{ agents: [{ id, name, runtimes, unverified? }] }` instead — one array
 * entry per agent, `runtimes` being what [availableKinds] says this machine
 * can actually run it as, which is empty rather than omitted for an agent
 * with no build for this platform. `unverified` is true when the agent would
 * install a binary lacking a SHA-256 and is omitted otherwise.
 */
export async function runListAgents(
  registryUrl?: string,
  fetchImpl: typeof fetch = fetch,
  json = false,
  platformTarget: PlatformTarget | undefined = hostPlatformTarget(),
): Promise<void> {
  const registry = await fetchRegistry(registryUrl, fetchImpl);
  const target = platformTarget;
  if (json) {
    console.log(
      JSON.stringify({
        agents: registry.agents.map((agent) => {
          const runtimes = availableKinds(agent, target);
          const unverified = isAgentUnverified(agent, target);
          return {
            id: agent.id,
            name: agent.name,
            runtimes,
            ...(unverified ? { unverified: true } : {}),
          };
        }),
      }),
    );
    return;
  }
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
  debug(
    `[registry] Running "${options.agentId}" via ${spec.kind}: ${spec.command} ${spec.args.join(" ")}`,
  );

  return { command: [spec.command, ...spec.args], env: spec.env };
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
 * Commands that only deal with the agent itself. None of them hands the agent
 * a workspace or reports to one, so none needs a .mcp.json — `--list-models` is
 * how someone picks a model, and `--login` how someone signs the agent in,
 * before they have set a workspace up at all.
 */
export const WORKSPACE_OPTIONAL_COMMANDS: ReadonlySet<GatewayCommand> = new Set([
  "list-models",
  "agent-info",
  "list-auth-methods",
  "login",
  "logout",
]);

/**
 * Finds the AgentRQ server a command reports to: its URL and token are where
 * the ACP endpoint comes from.
 *
 * A command that only deals with the agent itself does not go looking for
 * one: a .mcp.json that is missing, or broken, has nothing to do with which
 * models the agent offers or whether it is logged in.
 */
export function loadWorkspace(
  command: GatewayCommand,
  mcpJsonPath: string | undefined,
  startDir: string = process.cwd(),
): McpServerConfig {
  if (WORKSPACE_OPTIONAL_COMMANDS.has(command)) {
    return { name: "none", type: "http", env: {} };
  }
  return pickAgentrqServer(loadMcpConfig(startDir, mcpJsonPath));
}

/**
 * Makes an empty directory for `--list-models` to run the agent in.
 *
 * The gateway is usually run from a workspace's own directory, and agents look
 * for MCP servers in the directory they run in — Claude reads its .mcp.json,
 * Gemini its .gemini/settings.json. Run there, a listing agent would connect
 * to the workspace on its own and be taken for the workspace's agent. Here it
 * finds nothing to connect to.
 */
export function makeIsolatedDir(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-gateway-list-models-"));
  return {
    dir,
    remove: () => {
      // On Windows a directory cannot go while the agent just killed is still
      // in it. A stray empty directory in tmp is not worth failing over.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
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
  env: Record<string, string> | undefined,
  authMethodId?: string,
  json = false,
): Promise<void> {
  const [cmd, ...cmdArgs] = acpCmdArgs;
  const isolated = command === "list-models" ? makeIsolatedDir() : undefined;
  let agent: AgentConnection;
  try {
    agent = await openAgentConnection({
      acpCmdArgs,
      env,
      label: command,
      cwd: isolated?.dir,
    });
  } catch (err) {
    isolated?.remove();
    throw err;
  }

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
      const newSessionParams: acp.NewSessionRequest = {
        cwd: isolated!.dir,
        mcpServers: [],
      };
      const sessionResult = await createSessionWithAuth(
        agent.connection,
        newSessionParams,
        {
          methods: authMethods,
          launch: { command: cmd, args: cmdArgs, env },
          preferredId: authMethodId,
          interactive: isInteractiveTerminal(),
        },
      );

      try {
        const modelsResult = extractModels(sessionResult.configOptions);
        if (json) {
          // Deliberately narrower than formatModelsText's grouping: a caller
          // parsing this wants a flat list of what it can pass back as
          // --model, not the "(High)"/"(Low)" section labels a person reads
          // the table by.
          console.log(
            JSON.stringify({
              agent: acpCmdArgs.join(" "),
              models: (modelsResult?.models ?? []).map((m) => ({
                id: m.id,
                name: m.name,
                description: m.description ?? "",
                current: !!m.current,
              })),
            }),
          );
        } else if (modelsResult && modelsResult.models.length > 0) {
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
        if (json) {
          console.log(JSON.stringify({ agent: acpCmdArgs.join(" "), models: [] }));
        } else {
          console.log(`No configurable models advertised by "${acpCmdArgs.join(" ")}".`);
        }
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
      launch: { command: cmd, args: cmdArgs, env },
      preferredId: authMethodId,
      interactive: isInteractiveTerminal(),
    });
  } finally {
    terminateAgentProcess(agent.process);
    isolated?.remove();
  }
}

/**
 * What the ACP bridge runs with, from the gateway's own options and the
 * workspace's AgentRQ entry. A string is the reason it cannot run.
 */
export function nativeOptionsFor(
  options: GatewayOptions,
  acpCmdArgs: string[],
  agentrqConfig: McpServerConfig,
  cwd: string = process.cwd(),
  interactive: boolean = isInteractiveTerminal(),
): NativeOptions | string {
  const token = tokenFrom(agentrqConfig);
  if (!token) return "acp-gateway needs the workspace token from .mcp.json";
  if (!agentrqConfig.url && !options.acpUrl) {
    return "acp-gateway needs the AgentRQ URL from .mcp.json, or --acp-url";
  }
  let endpoint: string;
  try {
    endpoint = nativeEndpoint(agentrqConfig.url ?? "", options.acpUrl);
  } catch {
    return `acp-gateway cannot work out the AgentRQ endpoint from "${agentrqConfig.url}"; pass --acp-url`;
  }
  return {
    acpCmdArgs,
    env: agentrqConfig.env,
    endpoint,
    token,
    agentId: options.agentId ?? path.basename(acpCmdArgs[0] ?? ""),
    modelId: options.modelId,
    effort: options.effort,
    maxConcurrency: options.maxConcurrency,
    permissionTimeoutMinutes: Math.round(options.permissionTimeoutMs / 60_000),
    authMethodId: options.authMethodId,
    cwd: path.resolve(cwd),
    // AgentRQ never runs a terminal login itself. With a terminal here — a
    // shell, or agentrqd's browser terminal — the bridge runs it instead of
    // stopping.
    login: interactive
      ? () => runAgentCommand("login", acpCmdArgs, agentrqConfig.env, options.authMethodId)
      : undefined,
  };
}

/** Runs the ACP bridge, or says why it cannot and exits 1. */
export async function startNativeMode(
  options: GatewayOptions,
  acpCmdArgs: string[],
  agentrqConfig: McpServerConfig,
  run: (o: NativeOptions) => Promise<void> = runNative,
  exit: (code: number) => void = process.exit.bind(process),
): Promise<void> {
  const native = nativeOptionsFor(options, acpCmdArgs, agentrqConfig);
  if (typeof native === "string") {
    console.error(`[acp-gateway] ${native}`);
    return exit(1);
  }
  await run(native);
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
  registry. Everything after \`--\` is passed to the agent untouched. Its ACP
  stream is piped to AgentRQ's ACP v1 endpoint, which speaks ACP itself.
  Needs Node 22 or newer.

AGENT
  --agent <registry-id>       Run an agent from the ACP registry, installing it
                              if needed, instead of a command you supply.
  --list-agents               List every agent in the registry, and how each one
                              can run on this machine. Exits.
  --list-models               List models supported by the agent. Exits.
  --json                      With --list-agents or --list-models, print
                              machine-readable JSON instead of a table.
  --model <model-id>          Select a specific model for the session.
  --effort <level>            Select a reasoning effort level (e.g. low, medium, high).
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
  --max-concurrency <number>  How many tasks may prompt the agent at once, from
                              ${MIN_MAX_CONCURRENCY} to ${MAX_MAX_CONCURRENCY}. Defaults to ${DEFAULT_MAX_CONCURRENCY}. This is the limit
                              to start on — agentrq can change it while running.
  --permission-timeout <min>  How long a tool call waits for someone to approve
                              it before the turn is cancelled. Defaults to 30.
                              0 waits indefinitely, which is what a wedged
                              gateway looks like — use it knowingly.
  --mcp-json <path>           An MCP config to read as well as the one found
                              near the working directory, for running the
                              gateway from outside its workspace. Any filename;
                              a directory means the .mcp.json inside it. Its
                              servers win where the names collide.
  --acp-url <url>             The ACP endpoint, when it cannot be worked out
                              from .mcp.json.

OTHER
  --verbose                   Print everything: the connection to AgentRQ, the
                              agent's own logs, and what the one-shot commands
                              exchange with the agent. Without it, only
                              warnings and errors — and commands that print
                              something and exit print only that.
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
  acp-gateway --mcp-json ~/work/.mcp.json -- gemini --acp

The workspace comes from .mcp.json, searched for in the current directory and up
to three directories above it; only its AgentRQ URL and token are used.
--mcp-json names one directly, wherever it lives and whatever it is called.
--list-models, --agent-info, --list-auth-methods, --login and --logout do not
need a workspace.`;
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

  const { command } = options;
  setVerbose(options.verbose);

  if (command === "help") {
    printHelp();
    process.exit(0);
  }

  // Listing the registry needs neither a workspace nor an agent.
  if (command === "list-agents") {
    await runListAgents(options.registryUrl, undefined, options.json);
    process.exit(0);
  }

  // Nothing to run: the reason someone is looking at the terminal now is that
  // they do not yet know what to type, so show the help rather than an error
  // about a workspace they have not got to yet.
  if (!options.agentId && explicitCommand.length === 0) {
    printHelp();
    process.exit(1);
  }

  if (shouldPrintBanner(options)) console.log(`Starting [acp-gateway] ${pkg.name} v${pkg.version}`);

  await runGateway(options, explicitCommand);
}

/**
 * Everything `main` does once it knows there is an agent to deal with: find
 * the workspace, work out the agent's command, then either run a one-shot
 * command against it or bridge it to AgentRQ.
 *
 * Out here rather than in `main` so it can be tested; `main` reads the real
 * process arguments and never returns.
 */
export async function runGateway(
  options: GatewayOptions,
  explicitCommand: string[],
  deps: {
    resolve?: typeof resolveAgentCommand;
    agentCommand?: typeof runAgentCommand;
    bridge?: typeof startNativeMode;
    exit?: (code: number) => void;
    startDir?: string;
  } = {},
): Promise<void> {
  const {
    resolve = resolveAgentCommand,
    agentCommand = runAgentCommand,
    bridge = startNativeMode,
    exit = process.exit.bind(process),
    startDir = process.cwd(),
  } = deps;

  // These failures are all things the user can act on — a missing .mcp.json,
  // an unknown registry id, no build for this platform, an unverifiable
  // download, a mistyped command — so they get a sentence rather than a stack
  // trace.
  const fail = (err: unknown): void => {
    console.error(`[acp-gateway] ${err instanceof Error ? err.message : err}`);
    exit(1);
  };

  let agentrqConfig: McpServerConfig;
  let resolved: Awaited<ReturnType<typeof resolveAgentCommand>>;
  try {
    // Optional for the commands that only ask the agent about itself.
    agentrqConfig = loadWorkspace(options.command, options.mcpJsonPath, startDir);
    resolved = await resolve(options, explicitCommand);
    assertAgentRunnable(resolved.command[0], Boolean(options.agentId));
  } catch (err) {
    return fail(err);
  }
  const acpCmdArgs = resolved.command;
  if (resolved.env) {
    // The registry entry's env is part of how that agent must be launched, so
    // it travels with the command.
    agentrqConfig.env = { ...agentrqConfig.env, ...resolved.env };
  }

  if (options.command === "run") {
    return bridge(options, acpCmdArgs, agentrqConfig);
  }
  // One-shot commands talk to the agent and exit.
  await agentCommand(
    options.command,
    acpCmdArgs,
    agentrqConfig.env,
    options.authMethodId,
    options.json,
  );
  exit(0);
}

if (process.env.NODE_ENV !== "test") {
  // The bridge reconnects on its own, so a stray rejected promise or async
  // error from a dropped connection should be logged, not fatal. Without these
  // nets, Node terminates the process on the first unhandled rejection.
  process.on("unhandledRejection", (reason) => {
    console.error("[acp-gateway] Unhandled promise rejection (continuing):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[acp-gateway] Uncaught exception (continuing):", err);
  });

  // A rejection from main() itself means startup failed — that is genuinely
  // fatal, so exit.
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}
