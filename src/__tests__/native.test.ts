import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { nativeSupported, runNative, type NativeOptions } from "../native.js";
import { setVerbose } from "../log.js";
import { pkg } from "../version.js";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith?: number;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  constructor(
    public url: string,
    public init: { protocols: string[]; headers: Record<string, string> },
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
    this.onerror?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
  welcome(extra: Record<string, unknown> = {}) {
    this.receive(JSON.stringify({ agentrqBridge: "welcome", connectionId: "AB", resumed: false, received: 0, graceSeconds: 120, ...extra }));
  }
  drop(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  controls() {
    return this.sent.filter((f) => f.startsWith('{"agentrqBridge":')).map((f) => JSON.parse(f));
  }
  data() {
    return this.sent.filter((f) => !f.startsWith('{"agentrqBridge":'));
  }
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  written: string[];
}

function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.pid = 42;
  c.written = [];
  c.stdin.on("data", (d) => c.written.push(String(d)));
  c.kill = vi.fn(() => c.emit("exit", null, "SIGTERM"));
  return c;
}

const flush = () => new Promise((r) => setImmediate(r));

const status = (code: number, body = "") => vi.fn(async () => new Response(body || null, { status: code }));

async function start(over: Partial<NativeOptions> = {}) {
  const children: FakeChild[] = [];
  const spawnImpl = vi.fn(() => {
    const c = fakeChild();
    children.push(c);
    return c;
  });
  const exit = vi.fn();
  const fetchImpl = (over.fetchImpl as ReturnType<typeof vi.fn>) ?? status(426);
  let finished = false;
  const done = runNative({
    acpCmdArgs: ["agent", "--acp"],
    endpoint: "wss://h/api/acp/v1",
    token: "t",
    cwd: "/work",
    WebSocketImpl: FakeSocket as any,
    spawnImpl: spawnImpl as any,
    nodeVersion: "22.0.0",
    random: () => 0.5,
    now: () => Date.now(),
    exit,
    ...over,
    fetchImpl: fetchImpl as any,
  }).then(() => {
    finished = true;
  });
  await flush();
  return {
    children,
    spawnImpl,
    exit,
    fetchImpl,
    done,
    isDone: () => finished,
    ws: () => FakeSocket.instances[FakeSocket.instances.length - 1],
  };
}

/** Starts, opens the socket and takes the first welcome. */
async function connected(over: Partial<NativeOptions> = {}) {
  const t = await start(over);
  t.ws().open();
  t.ws().welcome();
  return t;
}

let errors: ReturnType<typeof vi.spyOn>;
const printed = () => errors.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  // Stops any bridge a test left running, and its signal handlers with it.
  process.emit("SIGTERM");
  setVerbose(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  errors.mockRestore();
});

describe("nativeSupported", () => {
  it("needs a WebSocket and Node 22", () => {
    expect(nativeSupported(FakeSocket, "22.4.0")).toBe(true);
    expect(nativeSupported(FakeSocket, "v22.4.0")).toBe(true);
    expect(nativeSupported(FakeSocket, "20.11.0")).toBe(false);
    expect(nativeSupported(FakeSocket, "v20.11.0")).toBe(false);
    expect(nativeSupported(undefined, "26.0.0")).toBe(false);
    expect(nativeSupported(FakeSocket)).toBe(Number(process.versions.node.split(".")[0]) >= 22);
  });
});

describe("runNative", () => {
  it("connects with the subprotocol and headers, and no resume the first time", async () => {
    const t = await start({ agentId: "codex-acp", modelId: "m", effort: "high", maxConcurrency: 2 });
    expect(t.ws().url).toBe("wss://h/api/acp/v1");
    expect(t.ws().init.protocols).toEqual(["agentrq.bridge.1"]);
    expect(t.ws().init.headers).toMatchObject({
      Authorization: "Bearer t",
      "X-AgentRQ-Cwd": "/work",
      "X-AgentRQ-Agent": "codex-acp",
      "X-AgentRQ-Agent-Model": "m",
      "X-AgentRQ-Agent-Effort": "high",
      "X-AgentRQ-Max-Concurrency": "2",
      "X-AgentRQ-Bridge-Version": pkg.version,
      "X-AgentRQ-Platform": `${process.platform}/${process.arch}`,
    });
    expect(t.ws().init.headers["X-AgentRQ-Resume"]).toBeUndefined();
    expect(t.spawnImpl).toHaveBeenCalledWith(
      "agent",
      ["--acp"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"], cwd: "/work", shell: false }),
    );
    expect(t.fetchImpl).toHaveBeenCalledWith(
      "https://h/api/acp/v1",
      expect.objectContaining({ headers: { Authorization: "Bearer t" }, redirect: "manual" }),
    );
  });

  it("pipes agent lines to frames and frames to agent lines", async () => {
    const t = await connected();
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await flush();
    expect(t.ws().data()).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);

    t.ws().receive('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    await flush();
    expect(t.children[0].written.join("")).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  });

  it("holds lines written before the welcome and sends them once it arrives", async () => {
    const t = await start();
    t.children[0].stdout.write("early\n");
    await flush();
    t.ws().open();
    expect(t.ws().sent).toEqual([]);
    t.ws().welcome();
    expect(t.ws().data()).toEqual(["early"]);
  });

  it("drops an agent line that forges a control frame", async () => {
    const t = await connected();
    t.children[0].stdout.write('{"agentrqBridge":"bye"}\n');
    await flush();
    expect(t.ws().sent).toEqual([]);
    expect(printed()).toMatch(/Dropped a line that looks like a bridge control frame/);
  });

  it("drops a line over 16 MiB and tells AgentRQ", async () => {
    const t = await connected();
    t.children[0].stdout.write("x".repeat(16 * 1024 * 1024 + 1) + "\nafter\n");
    await flush();
    expect(t.ws().data()).toEqual(["after"]);
    expect(t.ws().controls()).toEqual([
      { agentrqBridge: "stderr", lines: ["acp-gateway dropped a line over 16 MiB from the agent"] },
    ]);
  });

  it("drops a line that outgrows 16 MiB before its newline", async () => {
    const t = await connected();
    t.children[0].stdout.write("x".repeat(16 * 1024 * 1024 + 1));
    t.children[0].stdout.write("tail\nnext\n");
    await flush();
    expect(t.ws().data()).toEqual(["next"]);
    expect(printed()).toMatch(/Dropped a line over 16 MiB/);
  });

  it("drops a frame that contains a newline", async () => {
    const t = await connected();
    t.ws().receive('{"a":"x\ny"}');
    await flush();
    expect(t.children[0].written).toEqual([]);
    expect(printed()).toMatch(/contains a newline/);
  });

  it("drops a binary frame", async () => {
    const t = await connected();
    t.ws().receive(new ArrayBuffer(2));
    expect(printed()).toMatch(/binary frame/);
  });

  it("ignores control frames it does not know, and broken ones", async () => {
    const t = await connected();
    t.ws().receive('{"agentrqBridge":"later-kind","x":1}');
    t.ws().receive('{"agentrqBridge":nope');
    expect(t.exit).not.toHaveBeenCalled();
    expect(t.children[0].written).toEqual([]);
  });

  it("acks every 64 frames", async () => {
    const t = await connected();
    for (let i = 0; i < 64; i++) t.ws().receive(`{"n":${i}}`);
    expect(t.ws().controls()).toEqual([{ agentrqBridge: "ack", received: 64 }]);
  });

  it("acks within a second while frames flow, and not when none did", async () => {
    const t = await connected();
    vi.advanceTimersByTime(1000);
    expect(t.ws().controls()).toEqual([]);
    t.ws().receive('{"n":1}');
    vi.advanceTimersByTime(1000);
    expect(t.ws().controls()).toEqual([{ agentrqBridge: "ack", received: 1 }]);
  });

  it("resumes with what it received and replays what the server missed", async () => {
    const t = await connected();
    t.children[0].stdout.write("l1\nl2\nl3\n");
    await flush();
    t.ws().receive('{"s":1}');
    t.ws().receive('{"s":2}');
    t.ws().receive('{"agentrqBridge":"ack","received":1}');
    t.ws().drop(1006);

    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const second = t.ws();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(second.init.headers["X-AgentRQ-Resume"]).toBe("AB:2");

    second.open();
    second.welcome({ resumed: true, received: 2 });
    expect(second.data()).toEqual(["l3"]);
    expect(t.children).toHaveLength(1);
  });

  it("buffers agent lines while disconnected and replays them on resume", async () => {
    const t = await connected();
    t.ws().drop(1006);
    t.children[0].stdout.write("offline\n");
    await flush();
    vi.advanceTimersByTime(1000);
    t.ws().open();
    t.ws().welcome({ resumed: true, received: 0 });
    expect(t.ws().data()).toEqual(["offline"]);
  });

  /** Connects, has the agent answer AgentRQ's initialize, and opens a session for a prompt. */
  async function initialized() {
    const t = await connected();
    t.ws().receive('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}');
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1}}\n');
    t.ws().receive('{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"S1"}}');
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"S1"}}\n');
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":8,"method":"elicitation/create","params":{}}\n');
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":9,"method":"fs/read_text_file","params":{}}\n');
    await flush();
    t.children[0].written.length = 0;
    return t;
  }

  /** Drops the connection and takes a fresh (not resumed) welcome on the next. */
  function freshReconnect(t: Awaited<ReturnType<typeof start>>) {
    t.ws().drop(1006);
    vi.advanceTimersByTime(1000);
    t.ws().open();
    t.ws().welcome({ resumed: false, connectionId: "CD" });
  }

  it("a fresh welcome on a reconnect keeps the agent and its sessions", async () => {
    const t = await initialized();
    const instance = t.ws().init.headers["X-AgentRQ-Agent-Instance"];
    expect(instance).toMatch(/^[0-9a-f-]{36}$/);
    freshReconnect(t);
    await flush();

    expect(t.children).toHaveLength(1);
    expect(t.children[0].kill).not.toHaveBeenCalled();
    expect(t.ws().init.headers["X-AgentRQ-Agent-Instance"]).toBe(instance);
    expect(printed()).toMatch(/keeping the agent and its sessions/);
    // What the old connection left open is closed: its requests answered, its turns cancelled.
    expect(t.children[0].written.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", id: 8, result: { action: "cancel" } },
      { jsonrpc: "2.0", id: 9, error: { code: -32603, message: "AgentRQ reconnected before answering" } },
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "S1" } },
    ]);
  });

  it("answers a new connection's initialize from the agent's first answer", async () => {
    const t = await initialized();
    freshReconnect(t);
    await flush();
    t.children[0].written.length = 0;

    t.ws().receive('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}');
    await flush();
    expect(t.children[0].written).toEqual([]);
    expect(t.ws().data()).toEqual(['{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1}}']);
  });

  it("keeps a new connection's request ids apart from an earlier connection's", async () => {
    const t = await initialized();
    freshReconnect(t);
    await flush();
    t.children[0].written.length = 0;

    t.ws().receive('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/work","mcpServers":[]}}');
    await flush();
    expect(JSON.parse(t.children[0].written[0]).id).toBe("1:1");

    // The cancelled turn of the old connection answers its id 1 late: nobody asked.
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"cancelled"}}\n');
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":"1:1","result":{"sessionId":"S2"}}\n');
    await flush();
    expect(t.ws().data()).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"sessionId":"S2"}}']);
  });

  it("sends a second connection's initialize to an agent that never answered the first", async () => {
    const t = await connected();
    t.ws().receive('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}');
    await flush();
    freshReconnect(t);
    await flush();
    t.children[0].written.length = 0;

    t.ws().receive('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}');
    await flush();
    expect(t.children[0].written).toEqual(['{"jsonrpc":"2.0","id":"1:0","method":"initialize","params":{}}\n']);
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":"1:0","result":{"protocolVersion":1}}\n');
    await flush();
    expect(t.ws().data()).toEqual(['{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1}}']);

    // ...and remembers that answer for the next connection.
    freshReconnect(t);
    t.ws().receive('{"jsonrpc":"2.0","id":5,"method":"initialize","params":{}}');
    await flush();
    expect(t.ws().data()).toEqual(['{"jsonrpc":"2.0","id":5,"result":{"protocolVersion":1}}']);
  });

  it("carries a task's conversation on in its own session after the agent is kept", async () => {
    const t = await connected();
    const prompt = (id: number, sessionId: string, text: string) =>
      JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } });
    const sent = () => t.children[0].written.map((l) => JSON.parse(l));
    t.ws().receive(prompt(1, "S1", "[Task T1] start"));
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}\n');
    await flush();
    freshReconnect(t);
    await flush();
    t.children[0].written.length = 0;

    // The new connection opened S2 for T1; its prompts reach S1, where T1's conversation is.
    t.ws().receive(prompt(2, "S2", "[Reply to task T1] more"));
    t.ws().receive('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"S2"}}');
    t.ws().receive(prompt(3, "S3", "[Task T2] new task"));
    t.ws().receive(prompt(4, "S4", "no task header"));
    await flush();
    expect(sent().map((m) => m.params.sessionId)).toEqual(["S1", "S1", "S3", "S4"]);

    // What the agent says about S1 is what AgentRQ knows as S2.
    t.children[0].stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"S1","update":{}}}\n');
    t.children[0].stdout.write('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"S3","update":{}}}\n');
    await flush();
    expect(t.ws().data().map((f) => JSON.parse(f).params.sessionId)).toEqual(["S2", "S3"]);

    // Once AgentRQ closes it, the task starts afresh in whatever session it opens next.
    t.children[0].written.length = 0;
    t.ws().receive('{"jsonrpc":"2.0","id":5,"method":"session/close","params":{"sessionId":"S2"}}');
    t.ws().receive(prompt(6, "S5", "[Task T1] again"));
    await flush();
    expect(sent().map((m) => m.params.sessionId)).toEqual(["S1", "S5"]);
  });

  it("forgets the agent's requests AgentRQ has answered", async () => {
    const t = await initialized();
    t.ws().receive('{"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}');
    t.ws().receive('{"jsonrpc":"2.0","id":8,"result":{"action":"accept"}}');
    t.ws().receive('{"jsonrpc":"2.0","id":9,"result":{"content":""}}');
    await flush();
    t.children[0].written.length = 0;
    freshReconnect(t);
    await flush();
    expect(t.children[0].written.map((l) => JSON.parse(l).method)).toEqual(["session/cancel"]);
  });

  it("gives the agent this process's own directory, whatever AgentRQ sends", async () => {
    const t = await connected({ cwd: "/home/文档 é" });
    t.ws().receive('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/home/%E6%96%87%E6%A1%A3%20%C3%A9","mcpServers":[]}}');
    t.ws().receive('{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"sessionId":"S","cwd":"/elsewhere","mcpServers":[]}}');
    await flush();
    expect(t.children[0].written.map((l) => JSON.parse(l).params.cwd)).toEqual(["/home/文档 é", "/home/文档 é"]);
    expect(t.ws().init.headers["X-AgentRQ-Cwd"]).toBe("/home/%E6%96%87%E6%A1%A3 %C3%A9");
  });

  it("hands every session the servers from .mcp.json, as far as the agent can take them", async () => {
    const t = await connected({
      cwd: "/work",
      mcpServers: [
        { name: "agentrq-workspace", type: "http", url: "https://w/mcp?token=t" },
        { name: "files", type: "stdio", command: "npx", args: ["-y", "fs-mcp"] },
      ],
    });
    const newSession = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "session/new",
        params: { mcpServers: [{ type: "http", name: "agentrq-workspace", url: "https://w/mcp", headers: [] }] },
      });
    const params = () => t.children[0].written.map((l) => JSON.parse(l).params);

    // Before the agent has said anything about its transports, every server goes.
    t.ws().receive(newSession(1));
    await flush();
    expect(params()[0]).toEqual({
      cwd: "/work",
      mcpServers: [
        { type: "http", name: "agentrq-workspace", url: "https://w/mcp?token=t", headers: [] },
        { name: "files", command: "npx", args: ["-y", "fs-mcp"], env: [] },
      ],
    });

    // An agent that refuses http keeps only what it can take.
    t.ws().receive('{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}');
    t.children[0].stdout.write('{"jsonrpc":"2.0","id":2,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":false}}}}\n');
    await flush();
    // (AgentRQ itself sends no http server to such an agent.)
    t.ws().receive('{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"mcpServers":[]}}');
    await flush();
    expect(params()[2].mcpServers.map((s: any) => s.name)).toEqual(["files"]);
  });

  it("close 4001 reconnects fresh, and the fresh welcome keeps the agent", async () => {
    const t = await connected();
    t.ws().drop(4001, "grace expired");
    vi.advanceTimersByTime(1000);
    expect(t.ws().init.headers["X-AgentRQ-Resume"]).toBeUndefined();
    t.ws().open();
    t.ws().welcome();
    expect(t.children).toHaveLength(1);
  });

  it("a resume it cannot replay reconnects fresh and keeps the agent", async () => {
    const t = await connected();
    t.ws().drop(1006);
    vi.advanceTimersByTime(1000);
    t.ws().open();
    t.ws().welcome({ resumed: true, received: 99 });
    expect(t.children).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(t.ws().init.headers["X-AgentRQ-Resume"]).toBeUndefined();
    expect(printed()).toMatch(/can no longer be replayed; reconnecting/);
  });

  describe("an agent that needs a terminal login", () => {
    const refuse = (t: Awaited<ReturnType<typeof start>>) => {
      t.ws().receive(JSON.stringify({ agentrqBridge: "error", error: "auth_required", message: "run --login on this machine" }));
      t.ws().drop(4003, "auth_required");
    };

    it("is logged in at this terminal, then started again on a new connection", async () => {
      const login = vi.fn(async () => {});
      const t = await connected({ login });
      refuse(t);
      await flush();

      expect(login).toHaveBeenCalledTimes(1);
      expect(t.children[0].kill).toHaveBeenCalled();
      expect(t.children).toHaveLength(2);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(t.ws().init.headers["X-AgentRQ-Resume"]).toBeUndefined();
      expect(t.exit).not.toHaveBeenCalled();
      expect(printed()).toMatch(/logging it in at this terminal/);
      expect(printed()).not.toMatch(/run --login on this machine/);
    });

    it("stops when the login fails", async () => {
      const t = await connected({ login: vi.fn(async () => Promise.reject(new Error("abandoned"))) });
      refuse(t);
      await t.done;
      expect(printed()).toMatch(/The login did not work: abandoned/);
      expect(t.exit).toHaveBeenCalledWith(1);
    });

    it("stops when a non-Error failure ends the login", async () => {
      const t = await connected({ login: vi.fn(async () => Promise.reject("no")) });
      refuse(t);
      await t.done;
      expect(printed()).toMatch(/The login did not work: no/);
    });

    it("is not logged in again straight after a login", async () => {
      const login = vi.fn(async () => {});
      const t = await connected({ login });
      refuse(t);
      await flush();
      t.ws().open();
      t.ws().welcome();
      refuse(t);
      await t.done;
      expect(login).toHaveBeenCalledTimes(1);
      expect(printed()).toMatch(/run --login on this machine/);
      expect(t.exit).toHaveBeenCalledWith(1);
    });

    it("does not start an agent when the bridge was stopped during the login", async () => {
      let finish!: () => void;
      const t = await connected({ login: vi.fn(() => new Promise<void>((r) => (finish = r))) });
      refuse(t);
      process.emit("SIGTERM");
      finish();
      await flush();
      expect(t.children).toHaveLength(1);
    });

    it("stops with AgentRQ's instructions when there is no terminal", async () => {
      const t = await connected();
      refuse(t);
      await t.done;
      expect(printed()).toMatch(/run --login on this machine/);
      expect(t.exit).toHaveBeenCalledWith(1);
    });
  });

  it("ignores what a replaced agent still writes", async () => {
    const t = await connected();
    t.ws().receive('{"agentrqBridge":"restart","reason":"wedged"}');
    t.children[0].stdout.write("stale\n");
    await flush();
    expect(FakeSocket.instances.flatMap((s) => s.data())).toEqual([]);
  });

  it("the restart control frame restarts the agent and reconnects fresh", async () => {
    const t = await connected();
    t.ws().receive('{"agentrqBridge":"restart","reason":"no answer to initialize in 60 s"}');
    expect(t.children[0].kill).toHaveBeenCalled();
    expect(t.children).toHaveLength(2);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0].closedWith).toBe(1000);
    expect(t.ws().init.headers["X-AgentRQ-Resume"]).toBeUndefined();
    expect(printed()).toMatch(/no answer to initialize in 60 s/);

    // The new agent was started for this connection: its welcome does not restart it again.
    t.ws().open();
    t.ws().welcome({ connectionId: "EF" });
    expect(t.children).toHaveLength(2);
  });

  it("a restart frame without a reason still restarts", async () => {
    const t = await connected();
    t.ws().receive('{"agentrqBridge":"restart"}');
    expect(t.children).toHaveLength(2);
    expect(printed()).toMatch(/AgentRQ asked for it/);
  });

  it("close 4000 restarts the agent and reconnects fresh after the backoff", async () => {
    const t = await connected();
    t.ws().drop(4000);
    expect(t.children).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(t.ws().init.headers["X-AgentRQ-Resume"]).toBeUndefined();
    t.ws().open();
    t.ws().welcome();
    expect(t.children).toHaveLength(2);
  });

  it("does not ask to resume once its replay ring has overflowed", async () => {
    const t = await connected();
    t.ws().drop(1006);
    t.children[0].stdout.write(Array.from({ length: 1025 }, (_, i) => `l${i}`).join("\n") + "\n");
    await flush();
    vi.advanceTimersByTime(1000);
    expect(t.ws().init.headers["X-AgentRQ-Resume"]).toBeUndefined();
  });

  it("backs off longer after each failed reconnect, and starts again after a welcome", async () => {
    const t = await connected();
    t.ws().drop(1006);
    vi.advanceTimersByTime(1000);
    t.ws().drop(1006);
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    t.ws().open();
    t.ws().welcome({ resumed: true, received: 0 });
    t.ws().drop(1001, "server shutting down");
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("a version mismatch is printed and exits 1", async () => {
    const t = await connected();
    const message = "this agent speaks ACP v2; start it with --acp-version 2";
    t.ws().receive(JSON.stringify({ agentrqBridge: "error", code: "version_mismatch", message }));
    t.ws().drop(4002);
    await t.done;
    expect(printed()).toContain(message);
    expect(t.exit).toHaveBeenCalledWith(1);
    expect(t.children[0].kill).toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("a terminal login requirement is printed and exits 1", async () => {
    const t = await connected();
    const message =
      "the agent needs a terminal login: run npx -y @agentrq/acp-gateway@latest --login --agent x on this machine, then start it again";
    t.ws().receive(JSON.stringify({ agentrqBridge: "error", code: "auth_required", message }));
    t.ws().drop(4003);
    await t.done;
    expect(printed()).toContain(message);
    expect(t.exit).toHaveBeenCalledWith(1);
  });

  it("a fatal error frame exits on the close that follows, whatever its code", async () => {
    const t = await connected();
    t.ws().receive(JSON.stringify({ agentrqBridge: "error", code: "workspace_archived" }));
    t.ws().drop(1000);
    await t.done;
    expect(printed()).toContain("workspace_archived");
    expect(t.exit).toHaveBeenCalledWith(1);
  });

  it("a policy close without an error frame prints its reason and exits 1", async () => {
    const t = await connected();
    t.ws().drop(1008, "too many agent connections");
    await t.done;
    expect(printed()).toContain("AgentRQ closed the connection (1008): too many agent connections");
    expect(t.exit).toHaveBeenCalledWith(1);
  });

  it("a fatal close with no reason still says so", async () => {
    const t = await connected();
    t.ws().drop(4002);
    await t.done;
    expect(printed()).toContain("AgentRQ closed the connection (4002)");
  });

  it("a non-fatal error frame is printed and the bridge reconnects", async () => {
    const t = await connected();
    t.ws().receive(JSON.stringify({ agentrqBridge: "error", code: "server_shutdown", message: "the server is shutting down" }));
    t.ws().receive(JSON.stringify({ agentrqBridge: "error" }));
    t.ws().drop(1001);
    vi.advanceTimersByTime(1000);
    expect(printed()).toContain("the server is shutting down");
    expect(printed()).toContain("unknown error");
    expect(t.exit).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("an agent exit is reported and the agent respawned", async () => {
    const t = await connected();
    t.children[0].stderr.write("boom\npanic: x");
    await flush();
    t.children[0].emit("exit", 1, null);

    const first = FakeSocket.instances[0];
    expect(first.controls()).toEqual([
      { agentrqBridge: "stderr", lines: ["boom", "panic: x"] },
      { agentrqBridge: "exit", code: 1, signal: null },
    ]);
    expect(first.closedWith).toBe(1000);

    vi.advanceTimersByTime(1999);
    expect(t.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.children).toHaveLength(2);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(t.ws().init.headers["X-AgentRQ-Resume"]).toBeUndefined();

    // The respawned agent belongs to the fresh connection: no second restart.
    t.ws().open();
    t.ws().welcome({ connectionId: "GH" });
    expect(t.children).toHaveLength(2);
  });

  it("an agent exit while disconnected cancels the pending reconnect", async () => {
    const t = await connected();
    t.ws().drop(1006);
    t.children[0].emit("exit", 0, null);
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(t.children).toHaveLength(2);
  });

  it("an agent that cannot be started counts as an exit", async () => {
    const t = await connected();
    t.children[0].emit("error", new Error("spawn agent ENOENT"));
    t.children[0].emit("exit", -2, null);
    expect(printed()).toContain("The agent could not run: spawn agent ENOENT");
    vi.advanceTimersByTime(2000);
    expect(t.children).toHaveLength(2);
  });

  it("five exits within five minutes give up", async () => {
    const t = await connected();
    for (let i = 0; i < 4; i++) {
      t.children[i].stderr.write(`last words ${i}\n`);
      await flush();
      t.children[i].emit("exit", 1, null);
      vi.advanceTimersByTime(60_000);
    }
    expect(t.children).toHaveLength(5);
    t.children[4].stderr.write("final words\n");
    await flush();
    t.children[4].emit("exit", 1, null);
    await t.done;
    expect(t.exit).toHaveBeenCalledWith(1);
    expect(printed()).toMatch(/exited 5 times within 5 minutes; giving up\. Its last output:\nfinal words/);
  });

  it("gives up without a tail when the agent said nothing", async () => {
    const t = await connected();
    for (let i = 0; i < 4; i++) {
      t.children[i].emit("exit", 1, null);
      vi.advanceTimersByTime(60_000);
    }
    t.children[4].emit("exit", 1, null);
    await t.done;
    expect(printed()).toMatch(/giving up\.$/m);
  });

  it("exits spread over more than five minutes keep respawning", async () => {
    const t = await connected();
    for (let i = 0; i < 4; i++) {
      t.children[i].emit("exit", 1, null);
      vi.advanceTimersByTime(60_000);
    }
    vi.advanceTimersByTime(120_000);
    t.children[4].emit("exit", 1, null);
    vi.advanceTimersByTime(60_000);
    expect(t.exit).not.toHaveBeenCalled();
    expect(t.children).toHaveLength(6);
  });

  it("passes the agent's stderr through under --verbose", async () => {
    setVerbose(true);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const t = await connected();
    t.children[0].stderr.write("debug line\r\n");
    await flush();
    expect(write).toHaveBeenCalledWith("debug line\r\n");
    write.mockRestore();
  });

  it("refuses to start on Node 20", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const t = await start({ WebSocketImpl: undefined });
    await t.done;
    expect(printed()).toContain("acp-gateway needs Node 22 or newer");
    expect(t.exit).toHaveBeenCalledWith(1);
    expect(t.spawnImpl).not.toHaveBeenCalled();
    expect(t.fetchImpl).not.toHaveBeenCalled();

    const old = await start({ nodeVersion: "20.11.0" });
    await old.done;
    expect(old.spawnImpl).not.toHaveBeenCalled();
  });

  it("the preflight's 426 means go ahead", async () => {
    const t = await start();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(t.children).toHaveLength(1);
  });

  it("a server it cannot reach is left to the socket's own retries", async () => {
    const t = await start({ fetchImpl: vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))) as any });
    expect(FakeSocket.instances).toHaveLength(1);
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("an old server without the endpoint is named, not retried for ever", async () => {
    const t = await start({ fetchImpl: status(404) as any });
    await t.done;
    expect(printed()).toContain(
      "this AgentRQ server does not offer ACP v1 (HTTP 404); update the server",
    );
    expect(t.exit).toHaveBeenCalledWith(1);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(t.spawnImpl).not.toHaveBeenCalled();
  });

  it("a bad token is reported with the server's reason", async () => {
    const t = await start({ fetchImpl: status(401, "not a workspace access token\n") as any });
    await t.done;
    expect(printed()).toContain("AgentRQ refused the workspace token (HTTP 401): not a workspace access token");
    expect(t.exit).toHaveBeenCalledWith(1);
  });

  it("a forbidden workspace is reported even without a body", async () => {
    const t = await start({ fetchImpl: status(403) as any });
    await t.done;
    expect(printed()).toMatch(/refused the workspace token \(HTTP 403\)$/m);
  });

  it("a proxy that does not pass the upgrade is reported", async () => {
    const t = await start({ fetchImpl: status(400, "Bad Request") as any });
    await t.done;
    expect(printed()).toContain("https://h/api/acp/v1 answered HTTP 400 instead of offering a WebSocket upgrade: Bad Request");
    expect(printed()).toContain("must pass Upgrade for /api/acp/");
    expect(t.exit).toHaveBeenCalledWith(1);

    const bare = await start({ fetchImpl: status(502) as any });
    await bare.done;
    expect(printed()).toContain("answered HTTP 502 instead of offering a WebSocket upgrade. A proxy");
  });

  it("a body that cannot be read is treated as empty", async () => {
    const res = { status: 401, text: () => Promise.reject(new Error("aborted")) };
    const t = await start({ fetchImpl: vi.fn(async () => res) as any });
    await t.done;
    expect(printed()).toMatch(/\(HTTP 401\)$/m);
  });

  it("five reconnects without a welcome run the preflight again", async () => {
    const fetchImpl = status(426);
    const t = await start({ fetchImpl: fetchImpl as any });
    for (let i = 0; i < 4; i++) {
      t.ws().drop(1006);
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t.ws().drop(1006);
    fetchImpl.mockImplementation(async () => new Response(null, { status: 404 }));
    await vi.advanceTimersByTimeAsync(16_000);
    await t.done;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(printed()).toContain("does not offer ACP v1 (HTTP 404)");
    expect(t.exit).toHaveBeenCalledWith(1);
    expect(FakeSocket.instances).toHaveLength(5);
  });

  it("a preflight that passes goes on to reconnect", async () => {
    const t = await start();
    for (let i = 0; i < 5; i++) {
      t.ws().drop(1006);
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i);
    }
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(6);
  });

  it("a reconnect overtaken by an agent exit during its preflight does not run", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = status(426);
    const t = await start({ fetchImpl: fetchImpl as any });
    for (let i = 0; i < 4; i++) {
      t.ws().drop(1006);
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i);
    }
    t.ws().drop(1006);
    fetchImpl.mockImplementation(() => new Promise<Response>((r) => (answer = r)));
    await vi.advanceTimersByTimeAsync(16_000);
    t.children[0].emit("exit", 1, null);
    answer(new Response(null, { status: 426 }));
    await flush();
    expect(FakeSocket.instances).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.instances).toHaveLength(6);
  });

  it.each([[404], [426]])("a signal during a reconnect's preflight wins over its answer (%s)", async (code) => {
    let answer!: (r: Response) => void;
    const fetchImpl = status(426);
    const t = await start({ fetchImpl: fetchImpl as any });
    for (let i = 0; i < 4; i++) {
      t.ws().drop(1006);
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i);
    }
    t.ws().drop(1006);
    fetchImpl.mockImplementation(() => new Promise<Response>((r) => (answer = r)));
    await vi.advanceTimersByTimeAsync(16_000);
    process.emit("SIGTERM");
    answer(new Response(null, { status: code }));
    await flush();
    await flush();
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    expect(FakeSocket.instances).toHaveLength(5);
  });

  it("reports only the agent's last 40 stderr lines", async () => {
    const t = await connected();
    t.children[0].stderr.write(Array.from({ length: 45 }, (_, i) => `e${i}`).join("\n") + "\n");
    await flush();
    t.children[0].emit("exit", 1, null);
    const [stderr] = FakeSocket.instances[0].controls();
    expect(stderr.lines).toHaveLength(40);
    expect(stderr.lines[0]).toBe("e5");
  });

  it("survives a broken pipe to a dying agent", async () => {
    const t = await connected();
    t.children[0].stdin.emit("error", new Error("write EPIPE"));
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("a socket that cannot be made is reported and exits 1", async () => {
    class Throwing {
      constructor() {
        throw new SyntaxError("Invalid URL");
      }
    }
    const t = await start({ WebSocketImpl: Throwing as any });
    await t.done;
    expect(printed()).toContain("Cannot connect to wss://h/api/acp/v1: Invalid URL");
    expect(t.exit).toHaveBeenCalledWith(1);
    expect(t.children[0].kill).toHaveBeenCalled();
  });

  it("SIGTERM says bye, closes and stops the agent", async () => {
    const t = await connected();
    process.emit("SIGTERM");
    await t.done;
    expect(FakeSocket.instances[0].controls()).toEqual([{ agentrqBridge: "bye" }]);
    expect(FakeSocket.instances[0].closedWith).toBe(1000);
    expect(t.children[0].kill).toHaveBeenCalled();
    expect(t.exit).toHaveBeenCalledWith(0);
    expect(printed()).toContain("Received SIGTERM");

    // Stopped for good: nothing it scheduled runs, and a second signal is a no-op.
    process.emit("SIGINT");
    vi.advanceTimersByTime(120_000);
    expect(t.exit).toHaveBeenCalledTimes(1);
  });

  it("SIGHUP before the socket opens still stops the agent", async () => {
    const t = await start();
    process.emit("SIGHUP");
    await t.done;
    expect(FakeSocket.instances[0].sent).toEqual([]);
    expect(t.children[0].kill).toHaveBeenCalled();
    expect(t.exit).toHaveBeenCalledWith(0);
  });

  it("a full socket pauses the agent's output", async () => {
    const t = await connected();
    const stdout = t.children[0].stdout;
    t.ws().bufferedAmount = 9 * 1024 * 1024;
    stdout.write("big\n");
    await flush();
    expect(stdout.isPaused()).toBe(true);

    t.ws().bufferedAmount = 2 * 1024 * 1024;
    vi.advanceTimersByTime(50);
    expect(stdout.isPaused()).toBe(true);

    t.ws().bufferedAmount = 0;
    vi.advanceTimersByTime(50);
    expect(stdout.isPaused()).toBe(false);
  });

  it("a dropped socket releases a paused agent", async () => {
    const t = await connected();
    t.ws().bufferedAmount = 9 * 1024 * 1024;
    t.children[0].stdout.write("big\n");
    await flush();
    t.ws().drop(1006);
    vi.advanceTimersByTime(50);
    expect(t.children[0].stdout.isPaused()).toBe(false);
  });

  it("ignores events from a socket it already replaced", async () => {
    const t = await connected();
    const old = t.ws();
    old.drop(1006);
    old.receive('{"n":1}');
    old.drop(1006);
    expect(t.children[0].written).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("a signal during initial preflight stops cleanly without spawning agent", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (answer = r)));
    const t = await start({ fetchImpl: fetchImpl as any });
    process.emit("SIGTERM");
    answer(new Response(null, { status: 426 }));
    await t.done;
    expect(t.exit).toHaveBeenCalledWith(0);
    expect(t.spawnImpl).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("survives unexpected socket send failure without crashing", async () => {
    const t = await connected();
    t.ws().send = vi.fn(() => {
      throw new Error("WebSocket closed");
    });
    t.children[0].stdout.write("line\n");
    await flush();
    expect(t.exit).not.toHaveBeenCalled();
  });

  it("survives unexpected socket send failure in sendControl without crashing", async () => {
    const t = await connected();
    t.ws().send = vi.fn(() => {
      throw new Error("Socket error");
    });
    t.children[0].stdout.write("x".repeat(17 * 1024 * 1024) + "\n");
    await flush();
    expect(t.exit).not.toHaveBeenCalled();
  });
});
