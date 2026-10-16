/**
 * native.ts
 *
 * Native mode: AgentRQ speaks ACP itself, and this process only moves bytes.
 * Each line the agent writes becomes one WebSocket text frame and each frame
 * becomes one line on the agent's stdin. It never parses ACP; it reads only
 * the bridge's own control frames, recognised by their prefix.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  BRIDGE_SUBPROTOCOL,
  LineSplitter,
  MAX_LINE_BYTES,
  ReplayRing,
  STDERR_TAIL_LINES,
  backoffMs,
  decodeControl,
  encodeControl,
  isControl,
  preflightUrl,
  respawnDelayMs,
  stderrTail,
  upgradeHeaders,
  type Control,
} from "./nativeFrames.js";
import { needsShell, spawnArgsFor, spawnTarget, terminateAgentProcess } from "./index.js";
import { debug, isVerbose } from "./log.js";
import { pkg } from "./version.js";

/** Close codes after which reconnecting cannot help: version mismatch, a terminal login, policy. */
const FATAL_CLOSES: ReadonlySet<number> = new Set([4002, 4003, 1008]);
/** Error codes the server sends before such a close. */
const FATAL_ERRORS: ReadonlySet<string> = new Set([
  "version_mismatch",
  "auth_required",
  "unauthorized",
  "workspace_archived",
]);
const ACK_EVERY = 64;
const ACK_INTERVAL_MS = 1000;
const RESPAWN_LIMIT = 5;
const RESPAWN_WINDOW_MS = 5 * 60_000;
/** Closes in a row without a welcome before the preflight is asked again. */
const PREFLIGHT_AFTER_CLOSES = 5;
const PREFLIGHT_TIMEOUT_MS = 15_000;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const DRAIN_POLL_MS = 50;
const WS_OPEN = 1;

/** The part of a WebSocket the bridge uses; the built-in one in production, a fake in tests. */
export interface BridgeSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export type BridgeSocketCtor = new (
  url: string,
  init: { protocols: string[]; headers: Record<string, string> },
) => BridgeSocket;

export interface NativeOptions {
  version: 1 | 2;
  acpCmdArgs: string[];
  env?: Record<string, string>;
  endpoint: string;
  token: string;
  agentId?: string;
  modelId?: string;
  effort?: string;
  maxConcurrency?: number;
  permissionTimeoutMinutes?: number;
  authMethodId?: string;
  cwd: string;
  WebSocketImpl?: BridgeSocketCtor;
  spawnImpl?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  /** `process.versions.node`, for the Node 22 check. */
  nodeVersion?: string;
  exit?: (code: number) => void;
}

interface Agent {
  child: ChildProcess;
  /** Set once this process is replaced or stopped: what it says after that is ignored. */
  replaced: boolean;
  ended: boolean;
  stderr: string[];
}

/** Whether this Node can run native mode: a built-in WebSocket that takes headers. */
export function nativeSupported(
  WS: unknown,
  nodeVersion: string = process.versions.node,
): boolean {
  return typeof WS === "function" && Number(nodeVersion.replace(/^v/, "").split(".")[0]) >= 22;
}

/**
 * Runs the bridge until it is told to stop. Resolves once it has stopped, after
 * handing its exit code to `exit`.
 */
export async function runNative(o: NativeOptions): Promise<void> {
  const exit: (code: number) => void = o.exit ?? process.exit.bind(process);
  const WS = o.WebSocketImpl ?? ((globalThis as { WebSocket?: unknown }).WebSocket as BridgeSocketCtor | undefined);
  if (!nativeSupported(WS, o.nodeVersion)) {
    console.error(
      "[acp-gateway] native mode needs Node 22 or newer (classic mode, without --acp-version, still runs here)",
    );
    exit(1);
    return;
  }
  const Socket = WS as BridgeSocketCtor;
  const spawn = o.spawnImpl ?? nodeSpawn;
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));

  const ring = new ReplayRing();
  /** ACP frames received from AgentRQ on this logical connection. */
  let received = 0;
  let unacked = 0;
  let connectionId: string | undefined;
  let socket: BridgeSocket | undefined;
  /** True between the welcome and the close: until then agent lines only go into the ring. */
  let ready = false;
  /** The agent has not yet been bound to a server connection: a fresh welcome need not restart it. */
  let agentFresh = true;
  let attempt = 0;
  let closesWithoutWelcome = 0;
  /** The message of a fatal error frame, waiting for the close that follows it. */
  let fatal: string | undefined;
  let stopped = false;
  /** Bumped when the agent exits: a reconnect scheduled before that must not run. */
  let generation = 0;
  let agent: Agent;
  const exits: number[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let drainPoll: ReturnType<typeof setInterval> | undefined;

  const clearDrainPoll = () => {
    if (drainPoll !== undefined) {
      clearInterval(drainPoll);
      drainPoll = undefined;
    }
  };

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const stop = (code: number) => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    clearInterval(ackTimer);
    clearDrainPoll();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    const s = socket;
    socket = undefined;
    if (s && s.readyState === WS_OPEN) {
      if (code === 0) {
        try {
          s.send(encodeControl({ agentrqBridge: "bye" }));
        } catch {
          // Socket might have closed concurrently
        }
      }
      try {
        s.close(1000);
      } catch {
        // Ignore close error on terminating socket
      }
    }
    if (agent) {
      agent.replaced = true;
      if (!agent.ended) terminateAgentProcess(agent.child);
    }
    exit(code);
    resolveDone();
  };

  // Preflight: a plain GET answers what a failed upgrade cannot tell the
  // built-in WebSocket — whether the endpoint is there and the token good.
  const preflight = async (): Promise<boolean> => {
    const url = preflightUrl(o.endpoint);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${o.token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });
    } catch (err) {
      // A server that is down is covered by the socket's own retries.
      debug(`[native] Preflight to ${url} failed: ${err instanceof Error ? err.message : err}`);
      return true;
    }
    if (res.status === 426) return true;
    const body = (await res.text().catch(() => "")).trim();
    if (res.status === 404) {
      console.error(
        `[acp-gateway] this AgentRQ server does not offer native ACP v${o.version} (HTTP 404); ` +
          "update the server, or start without --acp-version",
      );
    } else if (res.status === 401 || res.status === 403) {
      console.error(
        `[acp-gateway] AgentRQ refused the workspace token (HTTP ${res.status})${body ? `: ${body}` : ""}`,
      );
    } else {
      console.error(
        `[acp-gateway] ${url} answered HTTP ${res.status} instead of offering a WebSocket upgrade${body ? `: ${body}` : ""}. ` +
          "A proxy in front of AgentRQ must pass Upgrade for /api/acp/.",
      );
    }
    stop(1);
    return false;
  };

  const startAgent = (): Agent => {
    const [cmd, ...args] = o.acpCmdArgs;
    const target = spawnTarget(cmd);
    debug(`[native] Spawning agent: ${target} ${args.join(" ")}`);
    const child = spawn(...spawnArgsFor(target, args), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...o.env },
      shell: needsShell(target),
      cwd: o.cwd,
    });
    const a: Agent = { child, replaced: false, ended: false, stderr: [] };
    ring.reset();
    received = 0;
    unacked = 0;
    agentFresh = true;

    const lines = new LineSplitter(MAX_LINE_BYTES, () => dropLine("a line over 16 MiB", true));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (a.replaced) return;
      for (const line of lines.push(chunk)) onAgentLine(line);
    });
    let partial = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (isVerbose()) process.stderr.write(chunk);
      const parts = (partial + chunk).split("\n");
      partial = parts.pop() ?? "";
      a.stderr.push(...parts.map((l) => l.replace(/\r$/, "")));
      if (a.stderr.length > STDERR_TAIL_LINES) a.stderr.splice(0, a.stderr.length - STDERR_TAIL_LINES);
    });
    // EPIPE when the agent dies mid-write: its exit is what matters.
    child.stdin?.on("error", (err: Error) => debug(`[native] Agent stdin error: ${err.message}`));
    const ended = (code: number | null, signal: string | null) => {
      if (a.ended) return;
      a.ended = true;
      if (partial) a.stderr.push(partial);
      if (a.replaced) return;
      onAgentExit(a, code, signal);
    };
    child.on("error", (err: Error) => {
      console.error(`[acp-gateway] The agent could not run: ${err.message}`);
      ended(null, null);
    });
    child.on("exit", ended);
    return a;
  };

  const restartAgent = (reason: string) => {
    console.error(`[acp-gateway] Restarting the agent: ${reason}`);
    clearDrainPoll();
    agent.replaced = true;
    if (!agent.ended) terminateAgentProcess(agent.child);
    agent = startAgent();
  };

  const sendControl = (c: Control) => {
    if (socket?.readyState === WS_OPEN) {
      try {
        socket.send(encodeControl(c));
      } catch (err) {
        debug(`[native] Socket sendControl error: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  const dropLine = (what: string, report = false) => {
    console.error(`[acp-gateway] Dropped ${what} from the agent.`);
    if (report) sendControl({ agentrqBridge: "stderr", lines: [`acp-gateway dropped ${what} from the agent`] });
  };

  const send = (frame: string) => {
    const s = socket!;
    try {
      s.send(frame);
    } catch (err) {
      debug(`[native] Socket send error: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (s.bufferedAmount > HIGH_WATER && drainPoll === undefined) {
      agent.child.stdout?.pause();
      drainPoll = setInterval(() => {
        if ((socket?.bufferedAmount ?? 0) >= LOW_WATER) return;
        clearDrainPoll();
        agent.child.stdout?.resume();
      }, DRAIN_POLL_MS);
    }
  };

  const onAgentLine = (line: string) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return dropLine("a line over 16 MiB", true);
    if (isControl(line)) return dropLine("a line that looks like a bridge control frame");
    ring.push(line);
    if (ready) send(line);
  };

  const sendAck = () => {
    if (!ready) return;
    sendControl({ agentrqBridge: "ack", received });
    unacked = 0;
  };
  const ackTimer = setInterval(() => {
    if (unacked > 0) sendAck();
  }, ACK_INTERVAL_MS);

  const onFrame = (data: unknown) => {
    if (typeof data !== "string") return console.error("[acp-gateway] Dropped a binary frame from AgentRQ.");
    if (isControl(data)) return onControl(decodeControl(data));
    if (data.includes("\n")) return console.error("[acp-gateway] Dropped a frame from AgentRQ that contains a newline.");
    received++;
    agent.child.stdin?.write(data + "\n");
    if (++unacked >= ACK_EVERY) sendAck();
  };

  const onControl = (c: Control | undefined) => {
    switch (c?.agentrqBridge) {
      case "welcome": {
        closesWithoutWelcome = 0;
        attempt = 0;
        let replay: string[] | undefined;
        if (c.resumed) {
          replay = ring.after(c.received ?? 0);
          if (replay === undefined) {
            // The server kept the connection, but what it missed is gone here.
            restartAgent("what AgentRQ missed while disconnected can no longer be replayed");
            connectionId = undefined;
            return reconnectNow();
          }
        } else if (agentFresh) {
          replay = ring.after(0) ?? [];
        } else {
          // The server started over, so the agent's session state is gone with it: so do we.
          restartAgent("AgentRQ started a new connection");
          replay = [];
        }
        connectionId = c.connectionId;
        agentFresh = false;
        ready = true;
        debug(`[native] Connected to AgentRQ (${c.resumed ? "resumed" : "new"} connection ${connectionId})`);
        for (const f of replay) send(f);
        return;
      }
      case "ack":
        return ring.ack(c.received ?? 0);
      case "restart":
        restartAgent(c.reason ?? "AgentRQ asked for it");
        connectionId = undefined;
        return reconnectNow();
      case "error": {
        const message = c.message ?? String(c.code ?? c.error ?? "unknown error");
        console.error(`[acp-gateway] ${message}`);
        if (FATAL_ERRORS.has(String(c.code ?? c.error))) fatal = message;
        return;
      }
      default:
        // Unknown kinds are ignored, so the protocol can grow (§14.3).
        return;
    }
  };

  const connect = (fresh: boolean) => {
    if (stopped) return;
    const resume = !fresh && connectionId && ring.resumable ? { connectionId, received } : undefined;
    const headers = upgradeHeaders({
      token: o.token,
      bridgeVersion: pkg.version,
      cwd: o.cwd,
      platform: `${process.platform}/${process.arch}`,
      agentId: o.agentId,
      modelId: o.modelId,
      effort: o.effort,
      maxConcurrency: o.maxConcurrency,
      permissionTimeoutMinutes: o.permissionTimeoutMinutes,
      authMethodId: o.authMethodId,
      resume,
    });
    ready = false;
    let welcomed = false;
    let s: BridgeSocket;
    try {
      s = new Socket(o.endpoint, { protocols: [BRIDGE_SUBPROTOCOL], headers });
    } catch (err) {
      console.error(`[acp-gateway] Cannot connect to ${o.endpoint}: ${err instanceof Error ? err.message : err}`);
      return stop(1);
    }
    socket = s;
    s.onopen = () => debug(`[native] Socket open to ${o.endpoint}`);
    s.onerror = () => {};
    s.onmessage = (e) => {
      if (s !== socket) return;
      if (!welcomed && typeof e.data === "string" && isControl(e.data)) {
        welcomed = decodeControl(e.data)?.agentrqBridge === "welcome";
      }
      onFrame(e.data);
    };
    s.onclose = (e) => {
      if (s !== socket || stopped) return;
      clearDrainPoll();
      agent.child.stdout?.resume();
      socket = undefined;
      ready = false;
      if (!welcomed) closesWithoutWelcome++;
      onClose(e.code, e.reason);
    };
  };

  /** Drops the current socket on purpose and opens a fresh one straight away. */
  const reconnectNow = () => {
    const s = socket;
    socket = undefined;
    ready = false;
    s?.close(1000);
    connect(true);
  };

  const scheduleReconnect = (fresh: boolean) => {
    const delay = backoffMs(attempt++, random);
    debug(`[native] Reconnecting in ${delay} ms`);
    const gen = generation;
    later(async () => {
      if (closesWithoutWelcome >= PREFLIGHT_AFTER_CLOSES) {
        closesWithoutWelcome = 0;
        if (!(await preflight())) return;
      }
      if (gen === generation) connect(fresh);
    }, delay);
  };

  const onClose = (code: number, reason: string) => {
    if (fatal || FATAL_CLOSES.has(code)) {
      if (!fatal) console.error(`[acp-gateway] AgentRQ closed the connection (${code})${reason ? `: ${reason}` : ""}`);
      return stop(1);
    }
    if (code === 4000) {
      restartAgent(reason || "AgentRQ asked for it");
      connectionId = undefined;
      return scheduleReconnect(true);
    }
    debug(`[native] Connection closed (${code})${reason ? `: ${reason}` : ""}`);
    // 4001 is a grace that expired or a connection the server does not know:
    // the fresh welcome that follows restarts the agent.
    if (code === 4001) connectionId = undefined;
    scheduleReconnect(code === 4001);
  };

  // Never after stop: stop marks the agent replaced, so its exit is not reported.
  const onAgentExit = (a: Agent, code: number | null, signal: string | null) => {
    generation++;
    clearDrainPoll();
    console.error(`[acp-gateway] The agent exited (code=${code}, signal=${signal}).`);
    sendControl({ agentrqBridge: "stderr", lines: stderrTail(a.stderr) });
    sendControl({ agentrqBridge: "exit", code, signal });
    const s = socket;
    socket = undefined;
    ready = false;
    try {
      s?.close(1000);
    } catch {
      // Ignore close error on exit
    }
    for (const t of timers) clearTimeout(t);
    timers.clear();

    const t = now();
    exits.push(t);
    while (exits.length > 0 && exits[0] <= t - RESPAWN_WINDOW_MS) exits.shift();
    if (exits.length >= RESPAWN_LIMIT) {
      const tail = a.stderr.join("\n").trim();
      console.error(
        `[acp-gateway] The agent exited ${RESPAWN_LIMIT} times within 5 minutes; giving up.` +
          (tail ? ` Its last output:\n${tail}` : ""),
      );
      return stop(1);
    }
    const delay = respawnDelayMs(exits.length);
    console.error(`[acp-gateway] Starting it again in ${Math.round(delay / 1000)} s.`);
    later(() => {
      agent = startAgent();
      connectionId = undefined;
      connect(true);
    }, delay);
  };

  const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const handler = () => {
      console.error(`\n[acp-gateway] Received ${signal}, shutting down...`);
      stop(0);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  if (!(await preflight()) || stopped) return done;
  agent = startAgent();
  connect(true);
  return done;
}
