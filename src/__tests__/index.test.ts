import { describe, it, expect, vi, beforeEach } from "vitest";
import { Writable, Readable } from "node:stream";
import {
  createAcpSessionSwitcher,
  checkForNextTask,
  mapMcpServers,
  TaskQueue,
  getOrCreateSession,
  activeSessions,
  pickHumanApprovalMode,
  enforceHumanApprovalMode,
} from "../index.js";
import type { McpServerConfig } from "../config.js";

vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn().mockReturnValue({
      stdin: new Writable({ write(chunk, encoding, callback) { callback(); } }),
      stdout: new Readable({ read() { this.push(null); } }),
      kill: vi.fn(),
      on: vi.fn(),
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
      const mockBridge: any = {};
      const configs: any[] = [];
      const agentrqConfig: any = { env: {} };
      
      const session = await getOrCreateSession("T-New", ["node", "agent.js"], configs, agentrqConfig, mockBridge);
      
      expect(session).toBeDefined();
      expect(session.sessionId).toBe("test-sess-123");
      expect(activeSessions.has("T-New")).toBe(true);
    });

    it("should return cached session when already created", async () => {
      const mockBridge: any = {};
      const configs: any[] = [];
      const agentrqConfig: any = { env: {} };

      const session1 = await getOrCreateSession("T-Cache", ["node", "agent.js"], configs, agentrqConfig, mockBridge);
      const session2 = await getOrCreateSession("T-Cache", ["node", "agent.js"], configs, agentrqConfig, mockBridge);

      expect(session1).toBe(session2);
    });

    it("should declare elicitation support when initializing the ACP connection", async () => {
      const mockBridge: any = {};
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
});
