import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import {
  createAcpSessionSwitcher,
  checkForNextTask,
  mapMcpServers,
  TaskQueue,
  getOrCreateSession,
  activeSessions,
  authConfig,
  createSessionWithAuth,
  isInteractiveTerminal,
  openAgentConnection,
  parseGatewayArgs,
  assertAgentRunnable,
  helpText,
  isRunnable,
  printHelp,
  resolveAgentCommand,
  runListAgents,
  pickHumanApprovalMode,
  enforceHumanApprovalMode,
  handleAgentModeChange,
  runAgentCommand,
} from "../index.js";
import { AUTH_REQUIRED_CODE } from "../auth.js";
import type { McpServerConfig } from "../config.js";

/**
 * A stand-in for the workspace bridge.
 *
 * The ACP client registers a verdict listener on it as soon as it is built, so
 * a bare object is not enough — the real bridge is an EventEmitter.
 */
function fakeBridge(): any {
  return new EventEmitter();
}

// Real emitters so the agent-process lifecycle handlers can be exercised.
const { spawnedAgents } = vi.hoisted(() => ({ spawnedAgents: [] as any[] }));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { Writable, Readable } = await import("node:stream");
  return {
    spawn: vi.fn(() => {
      const child: any = new EventEmitter();
      child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
      child.stdout = new Readable({ read() { this.push(null); } });
      child.kill = vi.fn();
      spawnedAgents.push(child);
      return child;
    }),
  };
});

vi.mock("@agentclientprotocol/sdk", async () => {
  const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>("@agentclientprotocol/sdk");
  return {
    ...actual,
    ClientSideConnection: vi.fn().mockImplementation(function() {
      return {
        initialize: vi.fn().mockResolvedValue({ protocolVersion: "0.1.0" }),
        newSession: vi.fn().mockResolvedValue({ sessionId: "test-sess-123" }),
        prompt: vi.fn().mockResolvedValue({ stopReason: "complete" }),
      };
    }),
  };
});

describe("index", () => {
  describe("mapMcpServers", () => {
    it("should correctly map HTTP servers with headers and env", () => {
      const configs: McpServerConfig[] = [{
        type: "http",
        name: "test-http",
        url: "http://localhost:8000",
        env: { "Authorization": "Bearer env-token", "Other": "Val" },
        headers: { "Authorization": "Bearer header-token", "Custom": "Header" }
      }];
      const result = mapMcpServers(configs);
      expect(result).toEqual([{
        type: "http",
        name: "test-http",
        url: "http://localhost:8000",
        headers: [
          { name: "Authorization", value: "Bearer header-token" },
          { name: "Custom", value: "Header" }
        ]
      }]);
    });

    it("should default headers to empty object for HTTP servers", () => {
      const configs: McpServerConfig[] = [{
        type: "http",
        name: "test-http",
        url: "http://localhost:8000"
      }];
      const result = mapMcpServers(configs);
      expect(result).toEqual([{
        type: "http",
        name: "test-http",
        url: "http://localhost:8000",
        headers: []
      }]);
    });

    it("should map an sse server as its own transport", () => {
      const configs: McpServerConfig[] = [{
        type: "sse",
        name: "events",
        url: "http://localhost:8000/sse",
      }];

      expect(mapMcpServers(configs, { mcpCapabilities: { sse: true } } as any)).toEqual([{
        type: "sse",
        name: "events",
        url: "http://localhost:8000/sse",
        headers: [],
      }]);
    });

    it("should leave out a transport the agent says it does not support", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const configs: McpServerConfig[] = [
        { type: "http", name: "remote", url: "http://localhost:8000" },
        { type: "stdio", name: "local", command: "npx" },
      ];

      // An agent may refuse the whole session/new rather than skip one entry.
      const result = mapMcpServers(configs, {
        mcpCapabilities: { http: false, sse: false },
      } as any);

      expect(result.map((s: any) => s.name)).toEqual(["local"]);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        'Not passing MCP server "remote"',
      );
      errorSpy.mockRestore();
    });

    it("should still hand over a transport the agent never mentions", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const configs: McpServerConfig[] = [
        { type: "http", name: "remote", url: "http://localhost:8000" },
      ];

      // A terse agent is likelier than one that genuinely cannot reach HTTP,
      // and dropping this would take the workspace's own server away from it.
      expect(mapMcpServers(configs, {} as any).map((s: any) => s.name)).toEqual(["remote"]);
      expect(mapMcpServers(configs).map((s: any) => s.name)).toEqual(["remote"]);
      errorSpy.mockRestore();
    });

    it("should correctly map stdio servers", () => {
      const configs: McpServerConfig[] = [{
        type: "stdio",
        name: "test-stdio",
        command: "npx",
        args: ["-y", "some-pkg"],
        env: {
          API_KEY: "secret",
          MODE: "test"
        }
      }];
      const result = mapMcpServers(configs);
      expect(result).toEqual([{
        name: "test-stdio",
        command: "npx",
        args: ["-y", "some-pkg"],
        env: [
          { name: "API_KEY", value: "secret" },
          { name: "MODE", value: "test" }
        ]
      }]);
    });

    it("should default args to empty array and env to empty object for stdio servers", () => {
      const configs: McpServerConfig[] = [{
        type: "stdio",
        name: "minimal-stdio",
        command: "echo"
      }];
      const result = mapMcpServers(configs);
      expect(result).toEqual([{
        name: "minimal-stdio",
        command: "echo",
        args: [],
        env: []
      }]);
    });
  });

  describe("createAcpSessionSwitcher", () => {
    let mockConnection: any;
    let params: any;

    beforeEach(() => {
      mockConnection = {
        newSession: vi.fn().mockResolvedValue({ sessionId: "new-session-id" }),
      };
      params = { cwd: "/test", mcpServers: [{ name: "s1", url: "http://s1", headers: [] }] };
    });

    it("should return initial session ID", () => {
      const switcher = createAcpSessionSwitcher(mockConnection, params, "initial-id");
      expect(switcher.getSessionId()).toBe("initial-id");
    });

    it("should return current session ID if taskId is undefined", async () => {
      const switcher = createAcpSessionSwitcher(mockConnection, params, "initial-id");
      const id = await switcher.ensureForTask(undefined);
      expect(id).toBe("initial-id");
      expect(mockConnection.newSession).not.toHaveBeenCalled();
    });

    it("should create a new session on first call with taskId", async () => {
      const switcher = createAcpSessionSwitcher(mockConnection, params, "initial-id");
      const id = await switcher.ensureForTask("task-1");
      expect(id).toBe("new-session-id");
      expect(mockConnection.newSession).toHaveBeenCalled();

      // Second call with same taskId should still return same ID
      const id2 = await switcher.ensureForTask("task-1");
      expect(id2).toBe("new-session-id");
      expect(mockConnection.newSession).toHaveBeenCalledTimes(1);
    });

    it("should create a new session when taskId changes", async () => {
      params = { cwd: "/test", mcpServers: [{ name: "s1", url: "http://s1", headers: [] }] };
      const switcher = createAcpSessionSwitcher(mockConnection, params, "initial-id");

      // Set initial task
      await switcher.ensureForTask("task-1");

      // Change task
      const id = await switcher.ensureForTask("task-2");

      expect(id).toBe("new-session-id");
      expect(mockConnection.newSession).toHaveBeenCalledTimes(2);
      expect(switcher.getSessionId()).toBe("new-session-id");
    });

    it("should return existing session when a previously seen task returns", async () => {
      mockConnection.newSession
        .mockResolvedValueOnce({ sessionId: "session-for-task-1" })
        .mockResolvedValueOnce({ sessionId: "session-for-task-2" });

      const switcher = createAcpSessionSwitcher(mockConnection, params, "initial-id");

      const id1 = await switcher.ensureForTask("task-1");
      expect(id1).toBe("session-for-task-1");

      const id2 = await switcher.ensureForTask("task-2");
      expect(id2).toBe("session-for-task-2");

      // task-1 returns — must reuse session-for-task-1, not create a third session
      const id3 = await switcher.ensureForTask("task-1");
      expect(id3).toBe("session-for-task-1");
      expect(mockConnection.newSession).toHaveBeenCalledTimes(2);
    });
  });

  describe("createAcpSessionSwitcher – getTaskIdForSession", () => {
    let mockConnection: any;
    let params: any;

    beforeEach(() => {
      mockConnection = {
        newSession: vi.fn()
          .mockResolvedValueOnce({ sessionId: "session-for-task-1" })
          .mockResolvedValueOnce({ sessionId: "session-for-task-2" }),
      };
      params = { cwd: "/test", mcpServers: [] };
    });

    it("should return taskId for a known session", async () => {
      const switcher = createAcpSessionSwitcher(mockConnection, params, "initial-id");
      await switcher.ensureForTask("task-1");
      expect(switcher.getTaskIdForSession("session-for-task-1")).toBe("task-1");
    });

    it("should return undefined for an unknown session", async () => {
      const switcher = createAcpSessionSwitcher(mockConnection, params, "initial-id");
      expect(switcher.getTaskIdForSession("unknown-session")).toBeUndefined();
    });

    it("should track multiple sessions independently", async () => {
      const switcher = createAcpSessionSwitcher(mockConnection, params, "initial-id");
      await switcher.ensureForTask("task-1");
      await switcher.ensureForTask("task-2");
      expect(switcher.getTaskIdForSession("session-for-task-1")).toBe("task-1");
      expect(switcher.getTaskIdForSession("session-for-task-2")).toBe("task-2");
    });
  });

  describe("checkForNextTask", () => {
    let mockMcpBridge: any;
    let mockConnection: any;
    let mockSessionSwitcher: any;
    let mockAcpClient: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockMcpBridge = {
        callTool: vi.fn(),
      };
      mockConnection = {
        prompt: vi.fn().mockResolvedValue({ stopReason: "complete" }),
      };
      mockSessionSwitcher = {
        getSessionId: vi.fn().mockReturnValue("current-session"),
        ensureForTask: vi.fn().mockResolvedValue("current-session"),
      };
      mockAcpClient = {
        flushReply: vi.fn().mockResolvedValue(undefined),
      };

      // Mock console.error to avoid cluttering test output
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("should do nothing if no tasks are found", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "no pending tasks exist" }],
      });

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher, mockAcpClient);

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("getTask");
      expect(mockConnection.prompt).not.toHaveBeenCalled();
    });

    it("should handle error from MCP bridge", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: true,
        content: "some error",
      });

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher, mockAcpClient);

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("getTask");
      expect(mockConnection.prompt).not.toHaveBeenCalled();
    });

    it("should process task and NOT recurse if task is found", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "Task ID: T1\ndo something" }],
      });

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher, mockAcpClient);

      expect(mockMcpBridge.callTool).toHaveBeenCalledTimes(1);
      expect(mockSessionSwitcher.ensureForTask).toHaveBeenCalledWith("T1");
      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: "current-session",
        prompt: [{ type: "text", text: "Task ID: T1\ndo something" }],
      });
      expect(mockAcpClient.flushReply).toHaveBeenCalledWith("current-session");
    });

    it("should handle exceptions during execution", async () => {
      mockMcpBridge.callTool.mockRejectedValue(new Error("network error"));

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher, mockAcpClient);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to check for next task"),
        expect.any(Error)
      );
    });

    it("should drop repetitive task messages for the same taskId", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "Task ID: T-Rep\nsome repetitive task" }],
      });

      // First run: should execute
      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher, mockAcpClient);
      expect(mockConnection.prompt).toHaveBeenCalledTimes(1);

      // Reset mock connection call count
      mockConnection.prompt.mockClear();

      // Second run with same content: should drop and not execute
      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher, mockAcpClient);
      expect(mockConnection.prompt).not.toHaveBeenCalled();
    });
  });

  describe("TaskQueue", () => {
    it("should run tasks up to maxConcurrency immediately", async () => {
      const queue = new TaskQueue(2);
      let running = 0;
      const tasks = Array.from({ length: 3 }, async (_, i) => {
        return queue.run(async () => {
          running++;
          expect(running).toBeLessThanOrEqual(2);
          await new Promise((resolve) => setTimeout(resolve, 20));
          running--;
        });
      });
      await Promise.all(tasks);
    });

    it("should queue subsequent tasks and execute them when previous ones finish", async () => {
      const queue = new TaskQueue(1);
      const executionOrder: number[] = [];
      const t1 = queue.run(async () => {
        executionOrder.push(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const t2 = queue.run(async () => {
        executionOrder.push(2);
      });
      await Promise.all([t1, t2]);
      expect(executionOrder).toEqual([1, 2]);
    });

    it("should handle error in immediate task and decrement activeCount", async () => {
      const queue = new TaskQueue(1);
      await expect(queue.run(async () => {
        throw new Error("immediate error");
      })).rejects.toThrow("immediate error");
      expect(queue.getActiveCount()).toBe(0);
    });

    it("should handle error in queued task, reject, and trigger next task", async () => {
      const queue = new TaskQueue(1);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      let resolveFirst: any;
      const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });
      const t1 = queue.run(async () => {
        await firstPromise;
      });

      const t2 = queue.run(async () => {
        throw new Error("queued error");
      });

      let ranThird = false;
      const t3 = queue.run(async () => {
        ranThird = true;
      });

      expect(queue.getQueueLength()).toBe(2);

      resolveFirst();
      await t1;

      await expect(t2).rejects.toThrow("queued error");
      await t3;

      // Allow catch microtasks to run
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(ranThird).toBe(true);
      expect(queue.getActiveCount()).toBe(0);
      expect(logSpy).toHaveBeenCalledWith("[queue] Error executing queued task:", expect.any(Error));

      logSpy.mockRestore();
    });
  });

  describe("getOrCreateSession", () => {
    beforeEach(() => {
      activeSessions.clear();
    });

    it("should spawn a new session when not cached", async () => {
      const mockBridge: any = fakeBridge();
      const configs: any[] = [];
      const agentrqConfig: any = { env: {} };
      
      const session = await getOrCreateSession("T-New", ["node", "agent.js"], configs, agentrqConfig, mockBridge);
      
      expect(session).toBeDefined();
      expect(session.sessionId).toBe("test-sess-123");
      expect(activeSessions.has("T-New")).toBe(true);
    });

    it("should return cached session when already created", async () => {
      const mockBridge: any = fakeBridge();
      const configs: any[] = [];
      const agentrqConfig: any = { env: {} };

      const session1 = await getOrCreateSession("T-Cache", ["node", "agent.js"], configs, agentrqConfig, mockBridge);
      const session2 = await getOrCreateSession("T-Cache", ["node", "agent.js"], configs, agentrqConfig, mockBridge);

      expect(session1).toBe(session2);
    });

    it("should declare elicitation support when initializing the ACP connection", async () => {
      const mockBridge: any = fakeBridge();
      const configs: any[] = [];
      const agentrqConfig: any = { env: {} };

      const session = await getOrCreateSession("T-Elicit", ["node", "agent.js"], configs, agentrqConfig, mockBridge);

      expect(session.connection.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          clientCapabilities: expect.objectContaining({
            elicitation: { form: {}, url: {} },
          }),
        }),
      );
    });

    it("should declare whether it can host a terminal login", async () => {
      const mockBridge: any = fakeBridge();

      const session = await getOrCreateSession("T-Auth-Cap", ["node", "agent.js"], [], { env: {} } as any, mockBridge);

      expect(session.connection.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          clientCapabilities: expect.objectContaining({
            auth: { terminal: isInteractiveTerminal() },
          }),
        }),
      );
    });

    it("should log in and retry when the agent refuses the session", async () => {
      const authenticate = vi.fn().mockResolvedValue({});
      const newSession = vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("Authentication required"), { code: AUTH_REQUIRED_CODE }),
        )
        .mockResolvedValue({ sessionId: "authed-sess" });
      vi.mocked(acp.ClientSideConnection).mockImplementationOnce(function () {
        return {
          initialize: vi.fn().mockResolvedValue({
            protocolVersion: "0.1.0",
            authMethods: [{ id: "agent-login", name: "Agent login" }],
          }),
          newSession,
          authenticate,
          prompt: vi.fn(),
        } as any;
      } as any);

      const session = await getOrCreateSession("T-Login", ["node", "agent.js"], [], { env: {} } as any, fakeBridge());

      expect(authenticate).toHaveBeenCalledWith({ methodId: "agent-login" });
      expect(newSession).toHaveBeenCalledTimes(2);
      expect(session.sessionId).toBe("authed-sess");
    });

    it("should drop the cached session when the agent process dies", async () => {
      const mockBridge: any = fakeBridge();
      await getOrCreateSession("T-Exit", ["node", "agent.js"], [], { env: {} } as any, mockBridge);
      expect(activeSessions.has("T-Exit")).toBe(true);

      spawnedAgents[spawnedAgents.length - 1].emit("exit", 1, null);
      expect(activeSessions.has("T-Exit")).toBe(false);
    });
  });

  describe("openAgentConnection", () => {
    beforeEach(() => {
      spawnedAgents.length = 0;
    });

    it("should report the agent's login methods and survive process failures", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(acp.ClientSideConnection).mockImplementationOnce(function () {
        return {
          initialize: vi.fn().mockResolvedValue({
            protocolVersion: "0.1.0",
            authMethods: [{ id: "agent-login", name: "Agent login" }],
          }),
        } as any;
      } as any);

      const onExit = vi.fn();
      const agent = await openAgentConnection({
        acpCmdArgs: ["node", "agent.js"],
        mcpBridge: fakeBridge(),
        label: "login",
        onExit,
      });

      expect(agent.initResult.authMethods).toHaveLength(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("Agent login (agent-login)");

      agent.process.emit("error", new Error("spawn failed"));
      agent.process.stdin.emit("error", new Error("EPIPE"));
      expect(onExit).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });
  });

  describe("createSessionWithAuth", () => {
    const auth = {
      methods: [{ id: "agent-login", name: "Agent login" }] as any,
      launch: { command: "node", args: ["agent.js"] },
    };

    it("should start the session directly when no login is needed", async () => {
      const connection: any = {
        newSession: vi.fn().mockResolvedValue({ sessionId: "s1" }),
        authenticate: vi.fn(),
      };

      const result = await createSessionWithAuth(connection, {} as any, auth);

      expect(result.sessionId).toBe("s1");
      expect(connection.authenticate).not.toHaveBeenCalled();
    });

    it("should surface failures that are not about authentication", async () => {
      const connection: any = {
        newSession: vi.fn().mockRejectedValue(new Error("cwd does not exist")),
        authenticate: vi.fn(),
      };

      await expect(createSessionWithAuth(connection, {} as any, auth)).rejects.toThrow(
        "cwd does not exist",
      );
      expect(connection.authenticate).not.toHaveBeenCalled();
    });
  });

  describe("parseGatewayArgs", () => {
    it("should default to bridging tasks with a concurrency of 2", () => {
      expect(parseGatewayArgs([])).toEqual({
        maxConcurrency: 2,
        permissionTimeoutMs: 30 * 60_000,
        command: "run",
        allowUnverifiedAgent: false,
        rest: [],
      });
    });

    it("should take the permission timeout in minutes", () => {
      expect(parseGatewayArgs(["--permission-timeout", "5"]).permissionTimeoutMs).toBe(300_000);
      // Zero is a deliberate "wait indefinitely", so it must not be ignored.
      expect(parseGatewayArgs(["--permission-timeout", "0"]).permissionTimeoutMs).toBe(0);
    });

    it("should keep the default when the timeout makes no sense", () => {
      expect(parseGatewayArgs(["--permission-timeout"]).permissionTimeoutMs).toBe(30 * 60_000);
      expect(parseGatewayArgs(["--permission-timeout", "soon"]).permissionTimeoutMs).toBe(
        30 * 60_000,
      );
      expect(parseGatewayArgs(["--permission-timeout", "-5"]).permissionTimeoutMs).toBe(
        30 * 60_000,
      );
    });

    it("should accept both spellings of the concurrency flag", () => {
      expect(parseGatewayArgs(["--max-concurrency", "4"]).maxConcurrency).toBe(4);
      expect(parseGatewayArgs(["--maxConcurrency", "8"]).maxConcurrency).toBe(8);
    });

    it("should keep the default when the concurrency value is missing or not a number", () => {
      expect(parseGatewayArgs(["--max-concurrency"]).maxConcurrency).toBe(2);
      expect(parseGatewayArgs(["--max-concurrency", "many"]).maxConcurrency).toBe(2);
      expect(parseGatewayArgs(["--max-concurrency", "--logout"])).toMatchObject({
        maxConcurrency: 2,
        command: "logout",
      });
    });

    it("should read the preferred auth method", () => {
      expect(parseGatewayArgs(["--auth-method", "oauth"])).toMatchObject({
        maxConcurrency: 2,
        command: "run",
        authMethodId: "oauth",
      });
      expect(parseGatewayArgs(["--auth-method"]).authMethodId).toBeUndefined();
    });

    it("should recognise the auth commands", () => {
      expect(parseGatewayArgs(["--login"])).toMatchObject({ maxConcurrency: 2, command: "login" });
      expect(parseGatewayArgs(["--login", "oauth"])).toMatchObject({
        maxConcurrency: 2,
        command: "login",
        authMethodId: "oauth",
      });
      expect(parseGatewayArgs(["--logout"]).command).toBe("logout");
      expect(parseGatewayArgs(["--list-auth-methods"]).command).toBe("list-auth-methods");
    });

    it("should keep tokens it does not recognise as the agent command", () => {
      const options = parseGatewayArgs(["--verbose", "--login"]);
      expect(options.command).toBe("login");
      expect(options.rest).toEqual(["--verbose"]);
    });

    it("should collect an agent command given without a -- separator", () => {
      expect(parseGatewayArgs(["--max-concurrency", "4", "gemini", "--acp"])).toMatchObject({
        maxConcurrency: 4,
        rest: ["gemini", "--acp"],
      });
    });

    it("should read the registry options", () => {
      expect(parseGatewayArgs(["--agent", "gemini"])).toMatchObject({
        agentId: "gemini",
        command: "run",
      });
      expect(parseGatewayArgs(["--agent"]).agentId).toBeUndefined();
      expect(parseGatewayArgs(["--list-agents"]).command).toBe("list-agents");
      expect(parseGatewayArgs(["--allow-unverified-agent"]).allowUnverifiedAgent).toBe(true);
      expect(
        parseGatewayArgs(["--registry-url", "http://localhost/registry.json"]).registryUrl,
      ).toBe("http://localhost/registry.json");
      expect(parseGatewayArgs(["--registry-url"]).registryUrl).toBeUndefined();
    });

    it("should recognise both spellings of the help flag", () => {
      expect(parseGatewayArgs(["--help"]).command).toBe("help");
      expect(parseGatewayArgs(["-h"]).command).toBe("help");
    });
  });

  describe("isRunnable", () => {
    it("finds a command on PATH", () => {
      expect(isRunnable("node", { PATH: process.env.PATH }, process.platform)).toBe(true);
    });

    it("does not find one that is not there", () => {
      expect(isRunnable("acp-gateway-no-such-command", { PATH: process.env.PATH })).toBe(false);
      expect(isRunnable("node", { PATH: "" })).toBe(false);
      expect(isRunnable("node", {})).toBe(false);
    });

    it("checks a path directly rather than searching PATH", () => {
      expect(isRunnable(process.execPath, {})).toBe(true);
      expect(isRunnable("/no/such/agent", {})).toBe(false);
    });

    it("honours PATHEXT and backslashes on Windows", () => {
      // A bare name on Windows resolves through PATHEXT, so "npx" alone finds
      // nothing while "npx.cmd" would.
      expect(isRunnable("npx", { PATH: "C:\\tools", PATHEXT: ".EXE" }, "win32")).toBe(false);
      expect(isRunnable("C:\\nope\\agent.exe", {}, "win32")).toBe(false);
    });
  });

  describe("assertAgentRunnable", () => {
    it("accepts a command that exists", () => {
      expect(() => assertAgentRunnable("node", false)).not.toThrow();
    });

    it("suggests --agent when the command looks like a registry id", () => {
      expect(() => assertAgentRunnable("antigravity-acp", false)).toThrow(
        /run it with --agent antigravity-acp/,
      );
    });

    it("blames the registry when the id was already resolved", () => {
      expect(() => assertAgentRunnable("acp-gateway-no-such-runner", true)).toThrow(
        /The registry says to run it as "acp-gateway-no-such-runner", which is not installed/,
      );
    });
  });

  describe("runListAgents", () => {
    const registry = {
      version: "1.0.0",
      agents: [
        {
          id: "gemini",
          name: "Gemini CLI",
          version: "0.58.0",
          description: "Google's CLI",
          distribution: { npx: { package: "@google/gemini-cli", args: ["--acp"] } },
        },
      ],
    };

    it("should print every agent and how to run one", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => registry });

      await runListAgents(undefined, fetchImpl as any);

      const printed = logSpy.mock.calls.flat().join("\n");
      logSpy.mockRestore();
      expect(printed).toContain("ACP registry v1.0.0 — 1 agents");
      expect(printed).toContain("gemini");
      expect(printed).toContain("acp-gateway --agent <id>");
    });

    it("should read a registry the user pointed it at", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => registry });

      await runListAgents("http://localhost/registry.json", fetchImpl as any);
      logSpy.mockRestore();

      expect(fetchImpl).toHaveBeenCalledWith("http://localhost/registry.json");
    });
  });

  describe("resolveAgentCommand", () => {
    const options = (overrides: Record<string, any> = {}) => ({
      maxConcurrency: 2,
      permissionTimeoutMs: 30 * 60_000,
      command: "run" as const,
      allowUnverifiedAgent: false,
      rest: [],
      ...overrides,
    });

    it("should use the command given after -- when no registry id was named", async () => {
      const fetchImpl = vi.fn();

      const resolved = await resolveAgentCommand(options(), ["gemini", "--acp"], fetchImpl as any);

      expect(resolved).toEqual({ command: ["gemini", "--acp"] });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("should resolve a registry id into the command that runs it", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          version: "1.0.0",
          agents: [
            {
              id: "gemini",
              name: "Gemini CLI",
              version: "0.58.0",
              description: "Google's CLI",
              distribution: {
                npx: { package: "@google/gemini-cli@0.58.0", args: ["--acp"], env: { K: "v" } },
              },
            },
          ],
        }),
      });

      const resolved = await resolveAgentCommand(
        options({ agentId: "gemini" }),
        [],
        fetchImpl as any,
      );
      errorSpy.mockRestore();

      expect(resolved.command[0]).toMatch(/^npx/);
      expect(resolved.command.slice(1)).toEqual(["-y", "@google/gemini-cli@0.58.0", "--acp"]);
      expect(resolved.env).toEqual({ K: "v" });
    });

    it("should surface a registry id that does not exist", async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "1.0.0", agents: [] }),
      });

      await expect(
        resolveAgentCommand(options({ agentId: "nope" }), [], fetchImpl as any),
      ).rejects.toThrow(/No agent "nope" in the ACP registry/);
    });
  });

  describe("runAgentCommand", () => {
    const agentrqConfig: any = { env: {} };
    let logSpy: any;
    let errorSpy: any;

    function mockConnection(overrides: Record<string, any>, initResult: Record<string, any> = {}) {
      const connection: Record<string, any> = {
        initialize: vi.fn().mockResolvedValue({ protocolVersion: "0.1.0", ...initResult }),
        ...overrides,
      };
      vi.mocked(acp.ClientSideConnection).mockImplementationOnce(function () {
        return connection as any;
      } as any);
      return connection;
    }

    beforeEach(() => {
      spawnedAgents.length = 0;
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("should list the agent's login methods and shut the agent down again", async () => {
      mockConnection({}, {
        authMethods: [{ id: "agent-login", name: "Agent login" }],
        agentCapabilities: { auth: { logout: {} } },
      });

      await runAgentCommand("list-auth-methods", ["gemini", "--acp"], agentrqConfig, fakeBridge());

      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("Agent login (agent-login)");
      expect(printed).toContain("--logout");
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should print what the agent says it supports", async () => {
      mockConnection({}, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          mcpCapabilities: { http: true },
        },
      });

      await runAgentCommand("agent-info", ["gemini", "--acp"], agentrqConfig, fakeBridge());

      const printed = String(logSpy.mock.calls.at(-1)[0]);
      expect(printed).toContain("gemini --acp");
      expect(printed).toContain("ACP protocol version 1");
      expect(printed).toContain("session/resume  yes");
      expect(printed).toContain("session/close   no");
      expect(printed).toContain("http  yes");
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should report agents that advertise no login", async () => {
      mockConnection({});

      await runAgentCommand("list-auth-methods", ["gemini", "--acp"], agentrqConfig, fakeBridge());

      expect(logSpy.mock.calls.flat().join("\n")).toContain("no authentication methods");
    });

    it("should log out", async () => {
      const connection = mockConnection({ logout: vi.fn().mockResolvedValue({}) }, {
        agentCapabilities: { auth: { logout: {} } },
      });

      await runAgentCommand("logout", ["gemini", "--acp"], agentrqConfig, fakeBridge());

      expect(connection.logout).toHaveBeenCalledWith({});
    });

    it("should log in with the method the user named", async () => {
      const connection = mockConnection({ authenticate: vi.fn().mockResolvedValue({}) }, {
        authMethods: [
          { id: "agent-login", name: "Agent login" },
          { id: "oauth", name: "OAuth" },
        ],
      });

      await runAgentCommand("login", ["gemini", "--acp"], agentrqConfig, fakeBridge(), "oauth");

      expect(connection.authenticate).toHaveBeenCalledWith({ methodId: "oauth" });
    });

    it("should still shut the agent down when the login fails", async () => {
      mockConnection({ authenticate: vi.fn() }, {
        authMethods: [{ id: "agent-login", name: "Agent login" }],
      });

      await expect(
        runAgentCommand("login", ["gemini", "--acp"], agentrqConfig, fakeBridge(), "missing"),
      ).rejects.toThrow(/Unknown authentication method/);
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });
  });

  describe("helpText", () => {
    it("should explain every option the parser accepts", () => {
      const text = helpText("9.9.9");

      // Every documented flag must be one parseGatewayArgs actually handles,
      // and every flag it handles must be documented.
      const documented = [...text.matchAll(/^\s{2}(--[a-z-]+|-h)/gm)].map((m) => m[1]);
      expect(new Set(documented)).toEqual(
        new Set([
          "--agent",
          "--list-agents",
          "--agent-info",
          "--allow-unverified-agent",
          "--registry-url",
          "--list-auth-methods",
          "--login",
          "--logout",
          "--auth-method",
          "--max-concurrency",
          "--permission-timeout",
          "--help",
        ]),
      );
    });

    it("should name the version and show how to run an agent both ways", () => {
      const text = helpText("9.9.9");

      expect(text).toContain("acp-gateway 9.9.9");
      expect(text).toContain("acp-gateway --agent gemini");
      expect(text).toContain("acp-gateway -- gemini --acp");
      expect(text).toContain(".mcp.json");
    });

    it("should say why an unverified agent is not installed by default", () => {
      expect(helpText()).toMatch(/no way to tell what was downloaded/);
    });
  });

  describe("printHelp", () => {
    it("should print the help text", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      printHelp();
      const printed = logSpy.mock.calls.flat().join("\n");
      logSpy.mockRestore();

      expect(printed).toContain("USAGE");
      expect(printed).toContain("--list-agents");
    });
  });

  describe("authConfig", () => {
    it("should start out with no preferred login method", () => {
      expect(authConfig).toEqual({});
    });
  });

  describe("isInteractiveTerminal", () => {
    it("should be true only when both stdin and stderr are a TTY", () => {
      const original = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
      try {
        process.stdin.isTTY = true;
        process.stderr.isTTY = true;
        expect(isInteractiveTerminal()).toBe(true);

        process.stderr.isTTY = false;
        expect(isInteractiveTerminal()).toBe(false);
      } finally {
        process.stdin.isTTY = original.stdin;
        process.stderr.isTTY = original.stderr;
      }
    });
  });

  describe("pickHumanApprovalMode", () => {
    // The real modes codex-acp advertises. Its default is "agent", whose
    // reviewer is an automated Guardian Review that approves on the human's
    // behalf — so tool calls never reach agentrq.
    const codexModes: any = {
      currentModeId: "agent",
      availableModes: [
        { id: "read-only", name: "Ask for approval", _meta: { kind: "standard" } },
        { id: "agent", name: "Approve for me", _meta: { kind: "auto_review" } },
        { id: "agent-full-access", name: "Full access", _meta: { kind: "full_access" } },
      ],
    };

    it("should pick the human-approval mode over auto-reviewing and full-access modes", () => {
      expect(pickHumanApprovalMode(codexModes)).toBe("read-only");
    });

    it("should return undefined when the agent advertises no modes", () => {
      expect(pickHumanApprovalMode(undefined)).toBeUndefined();
      expect(pickHumanApprovalMode(null)).toBeUndefined();
      expect(pickHumanApprovalMode({ currentModeId: "x", availableModes: [] } as any)).toBeUndefined();
    });

    it("should return undefined when every available mode auto-approves", () => {
      const modes: any = {
        currentModeId: "agent",
        availableModes: [
          { id: "agent", name: "Approve for me", _meta: { kind: "auto_review" } },
          { id: "yolo", name: "Never ask", _meta: { kind: "full_access" } },
        ],
      };
      expect(pickHumanApprovalMode(modes)).toBeUndefined();
    });

    it("should fall back to the first non-auto-approving mode when none names approval", () => {
      const modes: any = {
        currentModeId: "fast",
        availableModes: [
          { id: "fast", name: "Full access", _meta: { kind: "full_access" } },
          { id: "careful", name: "Careful" },
          { id: "other", name: "Other" },
        ],
      };
      expect(pickHumanApprovalMode(modes)).toBe("careful");
    });

    it("should tolerate modes without _meta or with a non-string kind", () => {
      const modes: any = {
        currentModeId: "a",
        availableModes: [
          { id: "a", name: "Full access" },
          { id: "b", name: "Ask first", _meta: { kind: 42 } },
        ],
      };
      expect(pickHumanApprovalMode(modes)).toBe("b");
    });
  });

  describe("enforceHumanApprovalMode", () => {
    let consoleSpy: any;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("should switch out of an auto-approving default mode", async () => {
      const connection: any = { setSessionMode: vi.fn().mockResolvedValue({}) };
      const sessionResult: any = {
        sessionId: "sess-1",
        modes: {
          currentModeId: "agent",
          availableModes: [
            { id: "read-only", name: "Ask for approval", _meta: { kind: "standard" } },
            { id: "agent", name: "Approve for me", _meta: { kind: "auto_review" } },
          ],
        },
      };

      await enforceHumanApprovalMode(connection, sessionResult);

      expect(connection.setSessionMode).toHaveBeenCalledWith({
        sessionId: "sess-1",
        modeId: "read-only",
      });
    });

    it("should do nothing when the agent advertises no modes", async () => {
      const connection: any = { setSessionMode: vi.fn() };

      await enforceHumanApprovalMode(connection, { sessionId: "sess-1" } as any);
      await enforceHumanApprovalMode(connection, {
        sessionId: "sess-1",
        modes: { currentModeId: "x", availableModes: [] },
      } as any);

      expect(connection.setSessionMode).not.toHaveBeenCalled();
    });

    it("should not switch when already in a human-approval mode", async () => {
      const connection: any = { setSessionMode: vi.fn() };
      const sessionResult: any = {
        sessionId: "sess-1",
        modes: {
          currentModeId: "read-only",
          availableModes: [
            { id: "read-only", name: "Ask for approval", _meta: { kind: "standard" } },
            { id: "agent", name: "Approve for me", _meta: { kind: "auto_review" } },
          ],
        },
      };

      await enforceHumanApprovalMode(connection, sessionResult);

      expect(connection.setSessionMode).not.toHaveBeenCalled();
    });

    it("should warn and not switch when every mode auto-approves", async () => {
      const connection: any = { setSessionMode: vi.fn() };
      const sessionResult: any = {
        sessionId: "sess-1",
        modes: {
          currentModeId: "agent",
          availableModes: [
            { id: "agent", name: "Approve for me", _meta: { kind: "auto_review" } },
            { id: "full", name: "Full access", _meta: { kind: "full_access" } },
          ],
        },
      };

      await enforceHumanApprovalMode(connection, sessionResult);

      expect(connection.setSessionMode).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("no mode that defers approvals to the human"),
      );
    });

    it("should log and not throw when setSessionMode fails", async () => {
      const connection: any = {
        setSessionMode: vi.fn().mockRejectedValue(new Error("unsupported")),
      };
      const sessionResult: any = {
        sessionId: "sess-1",
        modes: {
          currentModeId: "agent",
          availableModes: [
            { id: "read-only", name: "Ask for approval", _meta: { kind: "standard" } },
            { id: "agent", name: "Approve for me", _meta: { kind: "auto_review" } },
          ],
        },
      };

      await expect(
        enforceHumanApprovalMode(connection, sessionResult),
      ).resolves.toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to set session mode"),
        expect.any(Error),
      );
    });
  });
  describe("handleAgentModeChange", () => {
    const modes: any = {
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask first" },
        { id: "auto", name: "Auto approve" },
      ],
    };

    let errorSpy: any;
    beforeEach(() => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => errorSpy.mockRestore());

    it("should leave a mode that still asks the human alone", async () => {
      const connection: any = { setSessionMode: vi.fn() };

      await handleAgentModeChange(connection, "sess-ok", "ask", modes);

      expect(connection.setSessionMode).not.toHaveBeenCalled();
    });

    it("should put the session back when the agent starts approving for us", async () => {
      const connection: any = { setSessionMode: vi.fn().mockResolvedValue({}) };

      await handleAgentModeChange(connection, "sess-drift", "auto", modes);

      expect(connection.setSessionMode).toHaveBeenCalledWith({
        sessionId: "sess-drift",
        modeId: "ask",
      });
    });

    it("should treat a mode the agent never advertised as untrusted", async () => {
      const connection: any = { setSessionMode: vi.fn().mockResolvedValue({}) };

      await handleAgentModeChange(connection, "sess-unknown", "something-new", modes);

      expect(connection.setSessionMode).toHaveBeenCalledWith({
        sessionId: "sess-unknown",
        modeId: "ask",
      });
    });

    it("should stop fighting an agent that keeps switching back", async () => {
      const connection: any = { setSessionMode: vi.fn().mockResolvedValue({}) };

      for (let i = 0; i < 5; i++) {
        await handleAgentModeChange(connection, "sess-stubborn", "auto", modes);
      }

      // An unbounded fight would be an endless stream of setSessionMode calls.
      expect(connection.setSessionMode).toHaveBeenCalledTimes(3);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("Giving up after 3 attempts");
    });

    it("should start counting again once the session is back in a safe mode", async () => {
      const connection: any = { setSessionMode: vi.fn().mockResolvedValue({}) };

      await handleAgentModeChange(connection, "sess-recovered", "auto", modes);
      await handleAgentModeChange(connection, "sess-recovered", "ask", modes);
      for (let i = 0; i < 4; i++) {
        await handleAgentModeChange(connection, "sess-recovered", "auto", modes);
      }

      expect(connection.setSessionMode).toHaveBeenCalledTimes(4);
    });

    it("should do nothing for an agent that offers no modes at all", async () => {
      const connection: any = { setSessionMode: vi.fn() };

      await handleAgentModeChange(connection, "sess-modeless", "whatever", undefined);
      await handleAgentModeChange(connection, "sess-modeless", "whatever", { availableModes: [] } as any);

      expect(connection.setSessionMode).not.toHaveBeenCalled();
    });
  });

});
