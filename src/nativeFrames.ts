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
    const parts = (this.rest + chunk).split("\n");
    this.rest = parts.pop() ?? "";
    if (this.skipping && parts.length > 0) {
      // The tail end of the line that was already dropped.
      parts.shift();
      this.skipping = false;
    }
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

/** Where native mode connects: next to the MCP endpoint, on the same host. */
export function nativeEndpoint(mcpUrl: string, version: 1 | 2, override?: string): string {
  if (override) return override;
  const u = new URL(mcpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `/api/acp/v${version}`;
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
}

export function upgradeHeaders(o: NativeHeaderOptions): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${o.token}`,
    "X-AgentRQ-Bridge-Version": o.bridgeVersion,
    "X-AgentRQ-Cwd": o.cwd,
    "X-AgentRQ-Platform": o.platform,
  };
  if (o.agentId) h["X-AgentRQ-Agent"] = o.agentId;
  if (o.modelId) h["X-AgentRQ-Agent-Model"] = o.modelId;
  if (o.effort) h["X-AgentRQ-Agent-Effort"] = o.effort;
  if (o.maxConcurrency !== undefined) h["X-AgentRQ-Max-Concurrency"] = String(o.maxConcurrency);
  if (o.permissionTimeoutMinutes !== undefined) h["X-AgentRQ-Permission-Timeout"] = String(o.permissionTimeoutMinutes);
  if (o.authMethodId) h["X-AgentRQ-Auth-Method"] = o.authMethodId;
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
  while (kept.length > 0 && bytes > STDERR_TAIL_BYTES) {
    bytes -= Buffer.byteLength(kept.shift()!);
  }
  return kept;
}
