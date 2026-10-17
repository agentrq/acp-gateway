/**
 * nativeFrames.ts
 *
 * The parts of native mode that are pure: how an agent's stdout becomes
 * frames, how the bridge's few control frames are told apart from the ACP
 * frames it never reads, and what is kept so a dropped connection can resume
 * without losing or repeating anything.
 */

export const BRIDGE_SUBPROTOCOL = "agentrq.bridge.1";
export const CONTROL_PREFIX = '{"agentrqBridge":';
export const REPLAY_MAX_FRAMES = 1024;
export const REPLAY_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** What an `exit` report carries of the agent's stderr: its last lines, within a size cap. */
export const STDERR_TAIL_LINES = 40;
export const STDERR_TAIL_BYTES = 8 * 1024;

export interface Control {
  agentrqBridge: string;
  connectionId?: string;
  resumed?: boolean;
  received?: number;
  graceSeconds?: number;
  lines?: string[];
  /** The agent's exit code on `exit`; the error's name on `error`. */
  code?: number | string | null;
  signal?: string | null;
  reason?: string;
  error?: string;
  message?: string;
}

/** A control frame is recognised by its first bytes alone; ACP frames are never parsed. */
export function isControl(frame: string): boolean {
  return frame.startsWith(CONTROL_PREFIX);
}

export function encodeControl(c: Control): string {
  const { agentrqBridge, ...rest } = c;
  return JSON.stringify({ agentrqBridge, ...rest });
}

export function decodeControl(frame: string): Control | undefined {
  try {
    const c = JSON.parse(frame) as Control;
    return typeof c?.agentrqBridge === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turns stdout chunks into complete lines; the agent speaks newline-delimited
 * JSON. A line that grows past `maxLength` before its newline arrives is
 * dropped whole, and `onOversize` is told, rather than held in memory for ever.
 */
export class LineSplitter {
  private rest = "";
  private skipping = false;

  constructor(
    private readonly maxLength = Infinity,
    private readonly onOversize: () => void = () => {},
  ) {}

  push(chunk: string): string[] {
    if (this.skipping) {
      const nl = chunk.indexOf("\n");
      if (nl === -1) {
        return [];
      }
      this.skipping = false;
      chunk = chunk.slice(nl + 1);
      this.rest = "";
    }
    const parts = (this.rest + chunk).split("\n");
    this.rest = parts.pop() ?? "";
    if (this.rest.length > this.maxLength) {
      this.rest = "";
      this.skipping = true;
      this.onOversize();
    }
    return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
  }
}

/**
 * The frames sent to the server that it has not acknowledged, oldest first.
 * The same rules as the server's ring: an ack trims the head, a resume replays
 * what is past the server's count, and overflow means no resume is possible.
 */
export class ReplayRing {
  private frames: string[] = [];
  private head = 0;
  private first = 1;
  private bytes = 0;
  private total = 0;
  private broken = false;

  /** Every frame pushed since the last reset. */
  get sent(): number {
    return this.total;
  }

  /** False once the ring has overflowed: what it lost cannot be replayed. */
  get resumable(): boolean {
    return !this.broken;
  }

  push(f: string): void {
    this.total++;
    if (this.broken) return;
    this.frames.push(f);
    this.bytes += f.length;
    if (this.frames.length - this.head > REPLAY_MAX_FRAMES || this.bytes > REPLAY_MAX_BYTES) {
      this.broken = true;
      this.frames = [];
      this.head = 0;
      this.bytes = 0;
    }
  }

  ack(received: number): void {
    while (this.head < this.frames.length && this.first <= received) {
      this.bytes -= this.frames[this.head++].length;
      this.first++;
    }
    // Compact once the dead head is the bigger half, so trimming stays O(1) amortised.
    if (this.head > 0 && this.head * 2 >= this.frames.length) {
      this.frames = this.frames.slice(this.head);
      this.head = 0;
    }
  }

  after(received: number): string[] | undefined {
    if (this.broken || received < 0 || received > this.total || received + 1 < this.first) {
      return undefined;
    }
    return this.frames.slice(this.head + received + 1 - this.first);
  }

  reset(): void {
    this.frames = [];
    this.head = 0;
    this.first = 1;
    this.bytes = 0;
    this.total = 0;
    this.broken = false;
  }
}

/** Where the bridge connects: AgentRQ's ACP v1 endpoint, on the host .mcp.json names. */
export function nativeEndpoint(mcpUrl: string, override?: string): string {
  if (override) return override;
  const u = new URL(mcpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/api/acp/v1";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** The same endpoint over plain HTTP, for the preflight GET. */
export function preflightUrl(endpoint: string): string {
  const u = new URL(endpoint);
  if (u.protocol === "wss:") u.protocol = "https:";
  else if (u.protocol === "ws:") u.protocol = "http:";
  return u.toString();
}

/** The workspace token, from the URL's ?token= (as agentrqd writes it) or a header. */
export function tokenFrom(server: { url?: string; headers?: Record<string, string> }): string | undefined {
  const t = server.url && URL.canParse(server.url) ? new URL(server.url).searchParams.get("token") : null;
  if (t) return t;
  const auth = Object.entries(server.headers ?? {}).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
}

export interface NativeHeaderOptions {
  token: string;
  bridgeVersion: string;
  cwd: string;
  platform: string;
  agentId?: string;
  modelId?: string;
  effort?: string;
  maxConcurrency?: number;
  permissionTimeoutMinutes?: number;
  authMethodId?: string;
  resume?: { connectionId: string; received: number };
  /** Stable for the life of one agent process, so AgentRQ can tell a kept agent from a new one. */
  agentInstance?: string;
}

/**
 * The working directory as a header can carry it.
 *
 * Header values are bytes, and the built-in WebSocket refuses anything past
 * Latin-1 outright (a CJK path threw) and sends Latin-1 itself as the wrong
 * bytes. So everything outside printable ASCII is percent-encoded as UTF-8,
 * and so is `%` itself. An ASCII path is sent unchanged, and an encoded one
 * still starts the way it did, so it still reads as absolute. The agent never
 * sees this value: see `prepareSessionRequest`.
 */
export function headerSafeCwd(cwd: string): string {
  return cwd.replace(/[^\x20-\x24\x26-\x7e]+/gu, (run) => encodeURIComponent(run));
}

export function upgradeHeaders(o: NativeHeaderOptions): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${o.token}`,
    "X-AgentRQ-Bridge-Version": o.bridgeVersion,
    "X-AgentRQ-Cwd": headerSafeCwd(o.cwd),
    "X-AgentRQ-Platform": o.platform,
  };
  if (o.agentId) h["X-AgentRQ-Agent"] = o.agentId;
  if (o.modelId) h["X-AgentRQ-Agent-Model"] = o.modelId;
  if (o.effort) h["X-AgentRQ-Agent-Effort"] = o.effort;
  if (o.maxConcurrency !== undefined) h["X-AgentRQ-Max-Concurrency"] = String(o.maxConcurrency);
  if (o.permissionTimeoutMinutes !== undefined) h["X-AgentRQ-Permission-Timeout"] = String(o.permissionTimeoutMinutes);
  if (o.authMethodId) h["X-AgentRQ-Auth-Method"] = o.authMethodId;
  if (o.agentInstance) h["X-AgentRQ-Agent-Instance"] = o.agentInstance;
  if (o.resume) h["X-AgentRQ-Resume"] = `${o.resume.connectionId}:${o.resume.received}`;
  return h;
}

/** Reconnect delay: one second doubling to a minute, with ±20% jitter so many bridges do not reconnect in step. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** attempt, 60_000);
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** Respawn delay for an agent that exited: two seconds doubling to a minute. */
export function respawnDelayMs(exitsInWindow: number): number {
  return Math.min(2000 * 2 ** Math.max(0, exitsInWindow - 1), 60_000);
}

/** The agent's last stderr lines, newest kept, within the `exit` report's caps. */
export function stderrTail(lines: string[]): string[] {
  const kept = lines.slice(-STDERR_TAIL_LINES);
  let bytes = kept.reduce((n, l) => n + Buffer.byteLength(l), 0);
  let start = 0;
  while (start < kept.length && bytes > STDERR_TAIL_BYTES) {
    bytes -= Buffer.byteLength(kept[start++]);
  }
  return start > 0 ? kept.slice(start) : kept;
}

/** The JSON-RPC fields the bridge looks at, when a frame is one. */
export interface RpcShape {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  isResponse: boolean;
}

/**
 * Reads the envelope of an ACP frame, or undefined when it is not a JSON-RPC
 * object. The bridge reads only the envelope, and only for what it has to do
 * itself: keeping the working directory its own, and keeping an agent across a
 * new AgentRQ connection.
 */
export function rpcShape(frame: string): RpcShape | undefined {
  let m: any;
  try {
    m = JSON.parse(frame);
  } catch {
    return undefined;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return undefined;
  const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : undefined;
  const method = typeof m.method === "string" ? m.method : undefined;
  const params = m.params && typeof m.params === "object" && !Array.isArray(m.params) ? m.params : undefined;
  return { id, method, params, result: m.result, isResponse: method === undefined && id !== undefined };
}

/** The requests that carry the directory a session runs in. */
const CWD_METHODS: ReadonlySet<string> = new Set(["session/new", "session/load", "session/resume"]);

/**
 * Fills in a request that opens a session with what only this process knows.
 *
 * The working directory is this process's own: the agent runs here, so that is
 * where it works — not a server's idea of it, not the header's ASCII-safe
 * spelling of it, and present even when AgentRQ sends none.
 *
 * The MCP servers are the ones from .mcp.json, ahead of whatever AgentRQ
 * offers; a server of AgentRQ's with the same name as one of them is left out,
 * so the agent is not handed one workspace twice.
 */
export function prepareSessionRequest(frame: string, cwd: string, servers: readonly unknown[] = []): string {
  if (!frame.includes("session/")) return frame;
  const shape = rpcShape(frame);
  if (!shape?.method || !CWD_METHODS.has(shape.method) || !shape.params) return frame;
  const m = JSON.parse(frame);
  m.params.cwd = cwd;
  if (servers.length > 0) {
    const ours = new Set(servers.map((s) => (s as { name?: unknown }).name));
    const theirs: unknown[] = Array.isArray(m.params.mcpServers) ? m.params.mcpServers : [];
    m.params.mcpServers = [...servers, ...theirs.filter((s) => !ours.has((s as { name?: unknown })?.name))];
  }
  return JSON.stringify(m);
}

/** What answers an agent's request that AgentRQ will now never answer. */
export function abandonedAnswer(id: string | number, method: string): string {
  if (method === "session/request_permission") {
    return JSON.stringify({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
  }
  if (method === "elicitation/create") {
    return JSON.stringify({ jsonrpc: "2.0", id, result: { action: "cancel" } });
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message: "AgentRQ reconnected before answering" },
  });
}

/**
 * The AgentRQ task a prompt is for, from the header AgentRQ starts every task
 * message with: `[Task <id>]`, `[Reply to task <id>]`, `[Response to task
 * <id>]` or `[Task reassigned to agent] <id>`. Only a header at the very start
 * counts, so text that merely mentions a task is never taken for one.
 */
export function taskIdOf(prompt: unknown): string | undefined {
  const first = Array.isArray(prompt) ? prompt[0] : undefined;
  const text = first && typeof first === "object" && typeof first.text === "string" ? first.text : "";
  const m =
    /^\s*\[(?:Task|Reply to task|Response to task)\s+([A-Za-z0-9_-]+)\]/i.exec(text) ??
    /^\s*\[Task reassigned to agent\]\s+([A-Za-z0-9_-]+)/i.exec(text);
  return m?.[1];
}

/** The frame with its `params.sessionId` replaced. */
export function withSessionId(frame: string, sessionId: string): string {
  const m = JSON.parse(frame);
  m.params.sessionId = sessionId;
  return JSON.stringify(m);
}
