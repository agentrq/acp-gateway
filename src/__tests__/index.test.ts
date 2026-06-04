import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAcpSessionSwitcher, checkForNextTask, mapMcpServers, TaskQueue } from "../index.js";
import type { McpServerConfig } from "../config.js";

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

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("getNextTask");
      expect(mockConnection.prompt).not.toHaveBeenCalled();
    });

    it("should handle error from MCP bridge", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: true,
        content: "some error",
      });

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher, mockAcpClient);

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("getNextTask");
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
});
