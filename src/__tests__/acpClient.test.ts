import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRQACPClient } from "../acpClient.js";
import type { MCPBridge } from "../mcpClient.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Mock dependencies
vi.mock("node:fs/promises");
vi.mock("node:path");

describe("AgentRQACPClient", () => {
  let mcpBridge: any;
  let client: AgentRQACPClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpBridge = {
      getSessionId: vi.fn().mockReturnValue("test-session"),
      sendNotification: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    };
    client = new AgentRQACPClient(mcpBridge as unknown as MCPBridge);
  });

  describe("requestPermission", () => {
    it("should send a notification and wait for a verdict", async () => {
      const params = {
        toolCall: {
          toolCallId: "req-123",
          title: "Test Tool",
          rawInput: { foo: "bar" },
        },
        options: [
          { optionId: "opt-1", kind: "allow", name: "Allow Once" },
          { optionId: "opt-2", kind: "deny", name: "Deny" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(
            () => handler({ requestId: "req-123", behavior: "allow" }),
            10,
          );
        }
      });

      const response = await client.requestPermission(params);
      expect((response.outcome as any).optionId).toBe("opt-1");
    });

    it("should cancel (not throw) when sendNotification rejects, e.g. on network outage", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mcpBridge.sendNotification.mockRejectedValue(
        new Error("MCP not connected after 10s timeout"),
      );

      const params = {
        toolCall: {
          toolCallId: "req-123",
          title: "Test Tool",
          rawInput: { foo: "bar" },
        },
        options: [
          { optionId: "opt-1", kind: "allow", name: "Allow Once" },
          { optionId: "opt-2", kind: "deny", name: "Deny" },
        ],
      } as any;

      // Must resolve with a cancelled outcome rather than reject — a rejection
      // here would surface as an unhandled rejection and crash the gateway.
      const response = await client.requestPermission(params);
      expect(response.outcome.outcome).toBe("cancelled");
      // It must not register a verdict listener it can never clean up.
      expect(mcpBridge.on).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("should include task_id in the payload when available", async () => {
      const getTaskId = vi.fn().mockReturnValue("task-123");
      const clientWithTaskId = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, getTaskId);

      const params = {
        sessionId: "sess-1",
        toolCall: {
          toolCallId: "req-123",
          title: "Test Tool",
          rawInput: { foo: "bar" },
        },
        options: [
          { optionId: "opt-1", kind: "allow", name: "Allow Once" },
          { optionId: "opt-2", kind: "deny", name: "Deny" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(
            () => handler({ requestId: "req-123", behavior: "allow" }),
            10,
          );
        }
      });

      await clientWithTaskId.requestPermission(params);
      
      expect(getTaskId).toHaveBeenCalledWith("sess-1");
      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        "notifications/claude/channel/permission_request",
        expect.objectContaining({
          task_id: "task-123",
        })
      );
    });

    it("should auto-allow tools matching agentrq-<11 chars> pattern in title", async () => {
      const params = {
        toolCall: {
          toolCallId: "req-123",
          title: "updateTaskStatus (agentrq-0aleR6CbZBp MCP Server)",
        },
        options: [
          { optionId: "opt-1", kind: "allow", name: "Allow" },
          { optionId: "opt-2", kind: "deny", name: "Deny" },
        ],
      } as any;

      const response = await client.requestPermission(params);
      
      expect(mcpBridge.sendNotification).not.toHaveBeenCalled();
      expect(response.outcome.outcome).toBe("selected");
      expect((response.outcome as any).optionId).toBe("opt-1");
    });

    it("should handle missing tool title", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [{ optionId: "opt-1", kind: "allow", name: "Allow" }],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(
            () => handler({ requestId: "req-123", behavior: "allow" }),
            10,
          );
        }
      });

      const response = await client.requestPermission(params);
      // Permission matching still works based on behavior, independent of title presence
      expect((response.outcome as any).optionId).toBe("opt-1");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown Tool"),
      );
      consoleSpy.mockRestore();
    });

    it("should handle missing rawInput and missing session ID", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mcpBridge.getSessionId.mockReturnValue(undefined);

      const params = {
        toolCall: { toolCallId: "req-123", title: "Test Tool" },
        options: [{ optionId: "opt-1", kind: "allow", name: "Allow" }],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(() => handler({ requestId: "req-123", behavior: "allow" }), 10);
        }
      });

      const response = await client.requestPermission(params);
      expect((response.outcome as any).optionId).toBe("opt-1");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Bridge Session ID: unknown"),
      );
      
      // Verify payload had empty object for rawInput
      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ input_preview: "{}" })
      );

      consoleSpy.mockRestore();
    });

    it("should match options with 'yes' or 'approve'", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [
          { optionId: "opt-1", kind: "other", name: "Yes, proceed" },
          { optionId: "opt-2", kind: "other", name: "No" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(
            () => handler({ requestId: "req-123", behavior: "allow" }),
            10,
          );
        }
      });

      const response = await client.requestPermission(params);
      expect((response.outcome as any).optionId).toBe("opt-1");
    });

    it("should match options with 'deny' in the name", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [
          { optionId: "opt-1", kind: "allow", name: "Allow" },
          { optionId: "opt-2", kind: "other", name: "Deny this" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(
            () => handler({ requestId: "req-123", behavior: "deny" }),
            10,
          );
        }
      });

      const response = await client.requestPermission(params);
      expect((response.outcome as any).optionId).toBe("opt-2");
    });

    it("should fall back to first option if 'deny' verdict has no specific match", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [
          { optionId: "opt-1", kind: "other", name: "Other 1" },
          { optionId: "opt-2", kind: "other", name: "Other 2" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(
            () => handler({ requestId: "req-123", behavior: "deny" }),
            10,
          );
        }
      });

      const response = await client.requestPermission(params);
      expect((response.outcome as any).optionId).toBe("opt-1");
    });

    it("should fall back to first option if no match", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [{ optionId: "opt-default", kind: "other", name: "Maybe" }],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(
            () => handler({ requestId: "req-123", behavior: "allow" }),
            10,
          );
        }
      });

      const response = await client.requestPermission(params);
      expect((response.outcome as any).optionId).toBe("opt-default");
    });
  });

  describe("sessionUpdate", () => {
    it("should write text chunks to stdout", async () => {
      const writeSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const params = {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      } as any;

      await client.sessionUpdate(params);
      expect(writeSpy).toHaveBeenCalledWith("hello");
      writeSpy.mockRestore();
    });

    it("should ignore non-text chunks", async () => {
      const writeSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const params = {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "other", text: "ignored" },
        },
      } as any;

      await client.sessionUpdate(params);
      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });

    it("should log tool calls", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const params = {
        update: {
          sessionUpdate: "tool_call",
          title: "test-tool",
          status: "pending",
        },
      } as any;

      await client.sessionUpdate(params);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Tool call: test-tool (pending)"),
      );
      consoleSpy.mockRestore();
    });

    it("should skip logging for auto-allowed tool calls", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const params = {
        update: {
          sessionUpdate: "tool_call",
          title: "updateTaskStatus (agentrq-0aleR6CbZBp MCP Server)",
          status: "pending",
        },
      } as any;

      await client.sessionUpdate(params);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should handle unknown update types", async () => {
      const params = { update: { sessionUpdate: "unknown" } } as any;
      await expect(client.sessionUpdate(params)).resolves.toBeUndefined();
    });
  });

  describe("flushReply", () => {
    it("should call reply tool with accumulated text and clear the buffer", async () => {
      mcpBridge.callTool = vi.fn().mockResolvedValue({ isError: false, content: [] });
      const getTaskId = vi.fn().mockReturnValue("task-123");
      const c = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, getTaskId);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await c.sessionUpdate({ sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } } } as any);
      await c.sessionUpdate({ sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } } as any);

      await c.flushReply("sess-1");

      expect(mcpBridge.callTool).toHaveBeenCalledWith("reply", { chatId: "task-123", text: "Hello world" });

      // Buffer cleared — second flush should not call reply again
      mcpBridge.callTool.mockClear();
      await c.flushReply("sess-1");
      expect(mcpBridge.callTool).not.toHaveBeenCalled();
    });

    it("should skip reply if buffer is empty", async () => {
      mcpBridge.callTool = vi.fn();
      const c = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => "task-123");

      await c.flushReply("sess-empty");

      expect(mcpBridge.callTool).not.toHaveBeenCalled();
    });

    it("should skip reply if no task ID is found for the session", async () => {
      mcpBridge.callTool = vi.fn();
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const c = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => undefined);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await c.sessionUpdate({ sessionId: "sess-unknown", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } as any);
      await c.flushReply("sess-unknown");

      expect(mcpBridge.callTool).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No task ID for session"));
      consoleSpy.mockRestore();
    });

    it("should skip reply when agent already sent identical reply via tool call", async () => {
      mcpBridge.callTool = vi.fn().mockResolvedValue({ isError: false, content: [] });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const c = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => "task-123");
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      // Agent buffers text
      await c.sessionUpdate({ sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello world" } } } as any);

      // Agent also called reply via MCP tool with identical params
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          title: "reply (agentrq-0an2BXTfpGj MCP Server)",
          status: "completed",
          toolCallId: "tc-1",
          rawInput: { chatId: "task-123", text: "Hello world" },
        },
      } as any);

      await c.flushReply("sess-1");

      expect(mcpBridge.callTool).not.toHaveBeenCalledWith("reply", expect.anything());
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("agent already sent identical reply"));
      consoleSpy.mockRestore();
    });

    it("should still send reply when agent called reply with different text", async () => {
      mcpBridge.callTool = vi.fn().mockResolvedValue({ isError: false, content: [] });
      const c = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => "task-123");
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await c.sessionUpdate({ sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Full verbose output" } } } as any);

      // Agent sent a different message via reply tool
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          title: "reply (agentrq-0an2BXTfpGj MCP Server)",
          status: "completed",
          toolCallId: "tc-1",
          rawInput: { chatId: "task-123", text: "Summary only" },
        },
      } as any);

      await c.flushReply("sess-1");

      expect(mcpBridge.callTool).toHaveBeenCalledWith("reply", { chatId: "task-123", text: "Full verbose output" });
    });

    it("should not skip reply if agent tool call was not completed", async () => {
      mcpBridge.callTool = vi.fn().mockResolvedValue({ isError: false, content: [] });
      const c = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => "task-123");
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await c.sessionUpdate({ sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello world" } } } as any);

      // Tool call is in_progress, not completed
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          title: "reply (agentrq-0an2BXTfpGj MCP Server)",
          status: "in_progress",
          toolCallId: "tc-1",
          rawInput: { chatId: "task-123", text: "Hello world" },
        },
      } as any);

      await c.flushReply("sess-1");

      expect(mcpBridge.callTool).toHaveBeenCalledWith("reply", { chatId: "task-123", text: "Hello world" });
    });
  });

  describe("file operations", () => {
    it("should read text files", async () => {
      vi.mocked(path.resolve).mockReturnValue("/mock/path/file.txt");
      vi.mocked(fs.readFile).mockResolvedValue("file content");

      const response = await client.readTextFile({
        path: "file.txt",
        sessionId: "test-session",
      });
      expect(response.content).toBe("file content");
    });

    it("should throw error when reading file fails", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("read failed"));
      await expect(
        client.readTextFile({ path: "fail.txt", sessionId: "test-session" }),
      ).rejects.toThrow("read failed");
    });

    it("should write text files", async () => {
      vi.mocked(path.resolve).mockReturnValue("/mock/path/file.txt");
      vi.mocked(path.dirname).mockReturnValue("/mock/path");
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await client.writeTextFile({
        path: "file.txt",
        content: "new content",
        sessionId: "test-session",
      });
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/mock/path/file.txt",
        "new content",
        "utf8",
      );
    });

    it("should throw error when writing file fails", async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error("write failed"));
      await expect(
        client.writeTextFile({
          path: "fail.txt",
          content: "content",
          sessionId: "test-session",
        }),
      ).rejects.toThrow("write failed");
    });
  });
});
