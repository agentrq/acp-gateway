import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAcpSessionSwitcher, checkForNextTask, mapMcpServers } from "../index.js";
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
  });

  describe("checkForNextTask", () => {
    let mockMcpBridge: any;
    let mockConnection: any;
    let mockSessionSwitcher: any;

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

      // Mock console.error to avoid cluttering test output
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("should do nothing if no tasks are found", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "no pending tasks exist" }],
      });

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher);

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("getNextTask");
      expect(mockConnection.prompt).not.toHaveBeenCalled();
    });

    it("should handle error from MCP bridge", async () => {
      mockMcpBridge.callTool.mockResolvedValue({
        isError: true,
        content: "some error",
      });

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher);

      expect(mockMcpBridge.callTool).toHaveBeenCalledWith("getNextTask");
      expect(mockConnection.prompt).not.toHaveBeenCalled();
    });

    it("should process task and recurse if task is found", async () => {
      // First call returns a task with ID in text, second call returns no task
      mockMcpBridge.callTool
        .mockResolvedValueOnce({
          isError: false,
          content: [{ type: "text", text: "Task ID: T1\ndo something" }],
        })
        .mockResolvedValueOnce({
          isError: false,
          content: [{ type: "text", text: "no pending tasks exist" }],
        });

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher);

      expect(mockMcpBridge.callTool).toHaveBeenCalledTimes(2);
      expect(mockSessionSwitcher.ensureForTask).toHaveBeenCalledWith("T1");
      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: "current-session",
        prompt: [{ type: "text", text: "Task ID: T1\ndo something" }],
      });
    });

    it("should handle exceptions during execution", async () => {
      mockMcpBridge.callTool.mockRejectedValue(new Error("network error"));

      await checkForNextTask(mockMcpBridge, mockConnection, mockSessionSwitcher);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to check for next task"),
        expect.any(Error)
      );
    });
  });
});
