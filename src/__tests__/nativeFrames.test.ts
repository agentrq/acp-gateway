import { describe, it, expect, vi } from "vitest";
import {
  BRIDGE_SUBPROTOCOL,
  LineSplitter,
  ReplayRing,
  REPLAY_MAX_BYTES,
  REPLAY_MAX_FRAMES,
  backoffMs,
  decodeControl,
  encodeControl,
  isControl,
  nativeEndpoint,
  preflightUrl,
  respawnDelayMs,
  stderrTail,
  tokenFrom,
  upgradeHeaders,
} from "../nativeFrames.js";

describe("LineSplitter", () => {
  it("splits a chunk into complete lines and keeps the rest", () => {
    const s = new LineSplitter();
    expect(s.push("a\nb")).toEqual(["a"]);
    expect(s.push("c\n")).toEqual(["bc"]);
  });

  it("tolerates CRLF", () => {
    expect(new LineSplitter().push("x\r\n")).toEqual(["x"]);
  });

  it("skips empty lines", () => {
    expect(new LineSplitter().push("\n\n")).toEqual([]);
  });

  it("drops a line that outgrows the limit before its newline, and only that line", () => {
    const onOversize = vi.fn();
    const s = new LineSplitter(4, onOversize);
    expect(s.push("ok\nabcdef")).toEqual(["ok"]);
    expect(onOversize).toHaveBeenCalledTimes(1);
    expect(s.push("ghi")).toEqual([]);
    expect(s.push("jkl\nnext\n")).toEqual(["next"]);
    expect(s.push("more\n")).toEqual(["more"]);
  });

  it("does not call onOversize multiple times across multiple oversized chunks without newlines", () => {
    const onOversize = vi.fn();
    const s = new LineSplitter(4, onOversize);
    expect(s.push("abcdef")).toEqual([]);
    expect(onOversize).toHaveBeenCalledTimes(1);
    expect(s.push("ghijkl")).toEqual([]);
    expect(onOversize).toHaveBeenCalledTimes(1);
    expect(s.push("mnopqr")).toEqual([]);
    expect(onOversize).toHaveBeenCalledTimes(1);
    expect(s.push("st\nnext\n")).toEqual(["next"]);
    expect(onOversize).toHaveBeenCalledTimes(1);
  });
});

describe("control frames", () => {
  it("recognises a control frame by its prefix only", () => {
    expect(isControl('{"agentrqBridge":"ack","received":1}')).toBe(true);
    expect(isControl('{"jsonrpc":"2.0","params":{"agentrqBridge":1}}')).toBe(false);
  });

  it("writes the kind first", () => {
    expect(encodeControl({ received: 3, agentrqBridge: "ack" })).toBe('{"agentrqBridge":"ack","received":3}');
  });

  it("decodes a control frame and rejects anything else", () => {
    expect(decodeControl('{"agentrqBridge":"welcome","resumed":true}')).toEqual({
      agentrqBridge: "welcome",
      resumed: true,
    });
    expect(decodeControl('{"agentrqBridge":1}')).toBeUndefined();
    expect(decodeControl("null")).toBeUndefined();
    expect(decodeControl("{not json")).toBeUndefined();
  });

  it("names the subprotocol", () => {
    expect(BRIDGE_SUBPROTOCOL).toBe("agentrq.bridge.1");
  });
});

describe("ReplayRing", () => {
  const filled = (n: number) => {
    const r = new ReplayRing();
    for (let i = 1; i <= n; i++) r.push(`f${i}`);
    return r;
  };

  it("replays what the server has not received", () => {
    const r = filled(5);
    expect(r.sent).toBe(5);
    expect(r.after(2)).toEqual(["f3", "f4", "f5"]);
    expect(r.after(5)).toEqual([]);
  });

  it("an acknowledged frame cannot be replayed", () => {
    const r = filled(5);
    r.ack(3);
    expect(r.after(1)).toBeUndefined();
    expect(r.after(3)).toEqual(["f4", "f5"]);
    r.ack(4);
    expect(r.after(4)).toEqual(["f5"]);
  });

  it("refuses a count it never sent", () => {
    expect(filled(2).after(3)).toBeUndefined();
    expect(filled(2).after(-1)).toBeUndefined();
  });

  it("overflow makes the ring unresumable", () => {
    const r = filled(REPLAY_MAX_FRAMES + 1);
    expect(r.after(0)).toBeUndefined();
    expect(r.resumable).toBe(false);
    r.push("later");
    expect(r.sent).toBe(REPLAY_MAX_FRAMES + 2);
    expect(r.after(REPLAY_MAX_FRAMES + 2)).toBeUndefined();
  });

  it("overflows on bytes as well as frames", () => {
    const r = new ReplayRing();
    r.push("x".repeat(REPLAY_MAX_BYTES));
    expect(r.resumable).toBe(true);
    r.push("y");
    expect(r.resumable).toBe(false);
  });

  it("frees room as frames are acknowledged", () => {
    const r = new ReplayRing();
    for (let i = 1; i <= 3 * REPLAY_MAX_FRAMES; i++) {
      r.push(`f${i}`);
      r.ack(i - 1);
    }
    expect(r.resumable).toBe(true);
    expect(r.after(3 * REPLAY_MAX_FRAMES - 1)).toEqual([`f${3 * REPLAY_MAX_FRAMES}`]);
  });

  it("starts over on reset", () => {
    const r = filled(REPLAY_MAX_FRAMES + 1);
    r.reset();
    expect(r.sent).toBe(0);
    expect(r.resumable).toBe(true);
    r.push("a");
    expect(r.after(0)).toEqual(["a"]);
  });
});

describe("endpoints and tokens", () => {
  it("derives wss from https, keeps the host, replaces the path", () => {
    expect(nativeEndpoint("https://4hro0x9eslxd.mcp.agentrq.com/?token=t", 1)).toBe(
      "wss://4hro0x9eslxd.mcp.agentrq.com/api/acp/v1",
    );
  });

  it("derives ws from http for a local server", () => {
    expect(nativeEndpoint("http://localhost:3911/mcp/0kAbc?token=t#x", 2)).toBe("ws://localhost:3911/api/acp/v2");
  });

  it("an explicit --acp-url wins", () => {
    expect(nativeEndpoint("https://h/", 1, "wss://elsewhere/acp")).toBe("wss://elsewhere/acp");
  });

  it("turns the endpoint back into http for the preflight", () => {
    expect(preflightUrl("wss://h/api/acp/v1")).toBe("https://h/api/acp/v1");
    expect(preflightUrl("ws://localhost:3911/api/acp/v1")).toBe("http://localhost:3911/api/acp/v1");
    expect(preflightUrl("https://h/api/acp/v1")).toBe("https://h/api/acp/v1");
  });

  it("takes the token from the URL or from the Authorization header", () => {
    expect(tokenFrom({ url: "https://h/mcp/w?token=t" })).toBe("t");
    expect(tokenFrom({ url: "https://h/mcp/w", headers: { authorization: "Bearer t" } })).toBe("t");
    expect(tokenFrom({ headers: { Authorization: "Basic x" } })).toBeUndefined();
    expect(tokenFrom({})).toBeUndefined();
    expect(tokenFrom({ url: "not a url", headers: { Authorization: "Bearer t" } })).toBe("t");
  });
});

describe("upgradeHeaders", () => {
  const base = { token: "t", bridgeVersion: "0.3.0", cwd: "/work", platform: "linux/arm64" };

  it("sends only the headers it has", () => {
    expect(upgradeHeaders(base)).toEqual({
      Authorization: "Bearer t",
      "X-AgentRQ-Bridge-Version": "0.3.0",
      "X-AgentRQ-Cwd": "/work",
      "X-AgentRQ-Platform": "linux/arm64",
    });
  });

  it("sends every optional header it is given", () => {
    expect(
      upgradeHeaders({
        ...base,
        agentId: "codex-acp",
        modelId: "m",
        effort: "high",
        maxConcurrency: 4,
        permissionTimeoutMinutes: 0,
        authMethodId: "chatgpt",
        resume: { connectionId: "AB", received: 7 },
      }),
    ).toMatchObject({
      "X-AgentRQ-Agent": "codex-acp",
      "X-AgentRQ-Agent-Model": "m",
      "X-AgentRQ-Agent-Effort": "high",
      "X-AgentRQ-Max-Concurrency": "4",
      "X-AgentRQ-Permission-Timeout": "0",
      "X-AgentRQ-Auth-Method": "chatgpt",
      "X-AgentRQ-Resume": "AB:7",
    });
  });
});

describe("delays", () => {
  it("backs off from one second to a minute", () => {
    const half = () => 0.5;
    expect([0, 1, 6, 20].map((a) => backoffMs(a, half))).toEqual([1000, 2000, 60000, 60000]);
  });

  it("jitters by a fifth either way", () => {
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 1)).toBe(1200);
    const d = backoffMs(0);
    expect(d).toBeGreaterThanOrEqual(800);
    expect(d).toBeLessThanOrEqual(1200);
  });

  it("respawns after two seconds, doubling to a minute", () => {
    expect([0, 1, 2, 3, 10].map(respawnDelayMs)).toEqual([2000, 2000, 4000, 8000, 60000]);
  });
});

describe("stderrTail", () => {
  it("keeps the last 40 lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `l${i}`);
    expect(stderrTail(lines)).toEqual(lines.slice(10));
  });

  it("keeps within 8 KiB, dropping the oldest", () => {
    const big = "x".repeat(3000);
    expect(stderrTail([big, big, big, "end"])).toEqual([big, big, "end"]);
  });

  it("handles empty lines without error", () => {
    expect(stderrTail([])).toEqual([]);
  });

  it("preserves lines when within line count and byte size limits", () => {
    const lines = ["line 1", "line 2", "line 3"];
    expect(stderrTail(lines)).toEqual(["line 1", "line 2", "line 3"]);
  });
});
