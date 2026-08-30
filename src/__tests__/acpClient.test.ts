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
      callTool: vi.fn(),
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

    // codex-acp emits a `tool_call` session update naming the MCP tool, then
    // requests permission for that same toolCallId with no title and no
    // rawInput. Without correlating the two, agentrq's own calls reach the
    // human as "Unknown Tool" instead of being auto-allowed.
    it("should auto-allow an agentrq MCP call whose permission request carries no title", async () => {
      await client.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_QDSxAGK3Qagv",
          title: "mcp.agentrq-0cHiaZsOGMj.updateTaskStatus",
          status: "pending",
          rawInput: { server: "agentrq-0cHiaZsOGMj", tool: "updateTaskStatus", arguments: {} },
        },
      } as any);

      const params = {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_QDSxAGK3Qagv", kind: "execute", status: "pending" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject" },
        ],
      } as any;

      const response = await client.requestPermission(params);

      expect(mcpBridge.sendNotification).not.toHaveBeenCalled();
      expect((response.outcome as any).optionId).toBe("opt-1");
    });

    it("should recover the title and input from an earlier tool_call_update", async () => {
      await client.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_abc",
          title: "mcp.other-server.doThing",
          status: "pending",
          rawInput: { server: "other-server", tool: "doThing" },
        },
      } as any);

      const params = {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_abc", kind: "execute", status: "pending" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(() => handler({ requestId: "call_abc", behavior: "allow" }), 10);
        }
      });

      await client.requestPermission(params);

      // A non-agentrq tool still goes to the human, but now with a meaningful
      // name and input rather than "Unknown Tool" / "{}".
      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tool_name: "mcp.other-server.doThing",
          input_preview: JSON.stringify({ server: "other-server", tool: "doThing" }),
        }),
      );
    });

    it("should prefer the permission request's own title over the remembered one", async () => {
      await client.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_cmd",
          title: "stale title",
          status: "pending",
          rawInput: { command: "stale" },
        },
      } as any);

      const params = {
        sessionId: "sess-1",
        toolCall: {
          toolCallId: "call_cmd",
          title: "Run command",
          rawInput: { command: "rm index" },
        },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(() => handler({ requestId: "call_cmd", behavior: "allow" }), 10);
        }
      });

      await client.requestPermission(params);

      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tool_name: "Run command",
          input_preview: JSON.stringify({ command: "rm index" }),
        }),
      );
    });

    it("should still report Unknown Tool when nothing was ever recorded", async () => {
      const params = {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_unseen", kind: "execute", status: "pending" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(() => handler({ requestId: "call_unseen", behavior: "allow" }), 10);
        }
      });

      await client.requestPermission(params);

      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ tool_name: "Unknown Tool", input_preview: "{}" }),
      );
    });

    it("should forget a tool call once it has completed, so the map does not grow unbounded", async () => {
      const record = { sessionId: "sess-1", toolCallId: "call_done", title: "mcp.agentrq-0cHiaZsOGMj.reply" };

      await client.sessionUpdate({
        sessionId: "sess-1",
        update: { ...record, sessionUpdate: "tool_call", status: "pending" },
      } as any);
      await client.sessionUpdate({
        sessionId: "sess-1",
        update: { ...record, sessionUpdate: "tool_call_update", status: "completed" },
      } as any);

      const params = {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_done", kind: "execute", status: "pending" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(() => handler({ requestId: "call_done", behavior: "allow" }), 10);
        }
      });

      await client.requestPermission(params);

      // Entry was dropped on completion, so it is no longer auto-allowed by
      // the remembered title — it goes to the human as an unknown tool.
      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ tool_name: "Unknown Tool" }),
      );
    });

    it("should not retain details for a consumed permission request", async () => {
      await client.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_once",
          title: "mcp.agentrq-0cHiaZsOGMj.reply",
          status: "pending",
        },
      } as any);

      const params = {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_once", kind: "execute", status: "pending" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject" },
        ],
      } as any;

      // First request is auto-allowed from the remembered agentrq title.
      const first = await client.requestPermission(params);
      expect((first.outcome as any).optionId).toBe("opt-1");
      expect(mcpBridge.sendNotification).not.toHaveBeenCalled();

      // A replay of the same id no longer resolves, so it reaches the human.
      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(() => handler({ requestId: "call_once", behavior: "allow" }), 10);
        }
      });
      await client.requestPermission(params);
      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ tool_name: "Unknown Tool" }),
      );
    });

    // codex-acp follows an accepted MCP approval with a bare
    // {toolCallId, status: "in_progress"} update carrying no title.
    it("should retain a known title when a later update omits it", async () => {
      await client.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_keep",
          title: "mcp.agentrq-0cHiaZsOGMj.reply",
          status: "pending",
        },
      } as any);
      await client.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_keep",
          status: "in_progress",
        },
      } as any);

      const params = {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_keep", kind: "execute", status: "pending" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject" },
        ],
      } as any;

      const response = await client.requestPermission(params);

      expect(mcpBridge.sendNotification).not.toHaveBeenCalled();
      expect((response.outcome as any).optionId).toBe("opt-1");
    });

    it("should record nothing for an update with neither title nor input", async () => {
      await client.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_bare",
          status: "in_progress",
        },
      } as any);

      const params = {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call_bare", kind: "execute", status: "pending" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject" },
        ],
      } as any;

      mcpBridge.on.mockImplementation((event: string, handler: Function) => {
        if (event === "verdict") {
          setTimeout(() => handler({ requestId: "call_bare", behavior: "allow" }), 10);
        }
      });

      await client.requestPermission(params);

      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ tool_name: "Unknown Tool", input_preview: "{}" }),
      );
    });

    it("should ignore session updates that carry no tool call id", async () => {
      await expect(
        client.sessionUpdate({
          sessionId: "sess-1",
          update: { sessionUpdate: "tool_call_update", title: "no id here" },
        } as any),
      ).resolves.toBeUndefined();
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

    it("should match spec-compliant reject_once/reject_always kinds on deny (not just a literal 'deny' kind prefix)", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Allow Once" },
          { optionId: "opt-2", kind: "reject_once", name: "Reject Once" },
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
      // A spec-compliant "reject_once" kind must never be missed and fall
      // through to the first (allow) option — that would silently approve a
      // tool call the human explicitly denied.
      expect((response.outcome as any).optionId).toBe("opt-2");
    });

    it("should never resolve a deny verdict to an allow-kind option, even with no matching option", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [
          { optionId: "opt-1", kind: "allow_once", name: "Proceed" },
          { optionId: "opt-2", kind: "other", name: "Skip" },
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

    it("should cancel a deny verdict rather than select an allow option when every option is allow-kind", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [{ optionId: "opt-1", kind: "allow_once", name: "Proceed" }],
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
      expect(response.outcome.outcome).toBe("cancelled");
    });

    it("should select the once option on allow, never the always option, so future calls still require agentrq approval", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [
          { optionId: "opt-always", kind: "allow_always", name: "Always Allow" },
          { optionId: "opt-once", kind: "allow_once", name: "Allow Once" },
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
      // Selecting "allow_always" would make the spawned agent remember this
      // decision and stop asking for matching future tool calls, bypassing
      // agentrq entirely for those. Must always pick the once-only variant.
      expect((response.outcome as any).optionId).toBe("opt-once");
    });

    it("should select the once option on deny, never the always option", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [
          { optionId: "opt-always", kind: "reject_always", name: "Always Reject" },
          { optionId: "opt-once", kind: "reject_once", name: "Reject Once" },
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
      expect((response.outcome as any).optionId).toBe("opt-once");
    });

    it("should cancel an allow verdict rather than select an always-kind option when no once option exists", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [{ optionId: "opt-always", kind: "allow_always", name: "Always Allow" }],
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
      expect(response.outcome.outcome).toBe("cancelled");
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

  describe("createElicitation", () => {
    it("should delegate form mode to the elicit tool and return an accept result", async () => {
      const getTaskId = vi.fn().mockReturnValue("task-123");
      const clientWithTaskId = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, getTaskId);

      mcpBridge.callTool.mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ action: "accept", content: { strategy: "balanced" } }) }],
      });

      const params = {
        sessionId: "sess-1",
        mode: "form",
        message: "How should I proceed?",
        requestedSchema: { type: "object", properties: { strategy: { type: "string" } } },
      } as any;

      const response = await clientWithTaskId.createElicitation(params);

      expect(getTaskId).toHaveBeenCalledWith("sess-1");
      expect(mcpBridge.callTool).toHaveBeenCalledWith("elicit", {
        taskId: "task-123",
        message: "How should I proceed?",
        mode: "form",
        requestedSchema: params.requestedSchema,
      });
      expect(response).toEqual({ action: "accept", content: { strategy: "balanced" } });
    });

    it("should delegate url mode to the elicit tool", async () => {
      const getTaskId = vi.fn().mockReturnValue("task-123");
      const clientWithTaskId = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, getTaskId);

      mcpBridge.callTool.mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ action: "accept" }) }],
      });

      const params = {
        sessionId: "sess-1",
        mode: "url",
        elicitationId: "oauth-1",
        url: "https://example.com/connect",
        message: "Please authorize access.",
      } as any;

      const response = await clientWithTaskId.createElicitation(params);

      expect(mcpBridge.callTool).toHaveBeenCalledWith("elicit", {
        taskId: "task-123",
        message: "Please authorize access.",
        mode: "url",
        url: "https://example.com/connect",
      });
      expect(response).toEqual({ action: "accept" });
    });

    it("should map decline and cancel actions through", async () => {
      const getTaskId = vi.fn().mockReturnValue("task-123");
      const clientWithTaskId = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, getTaskId);
      const params = {
        sessionId: "sess-1",
        mode: "form",
        message: "Name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      } as any;

      mcpBridge.callTool.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ action: "decline" }) }],
      });
      expect(await clientWithTaskId.createElicitation(params)).toEqual({ action: "decline" });

      mcpBridge.callTool.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ action: "cancel" }) }],
      });
      expect(await clientWithTaskId.createElicitation(params)).toEqual({ action: "cancel" });
    });

    it("should create and start a task when there is no associated task, then delegate to it", async () => {
      const params = {
        mode: "form",
        message: "Please provide your workspace name to continue setup.",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      } as any;

      mcpBridge.callTool.mockImplementation(async (name: string) => {
        if (name === "createTask") {
          return { content: [{ type: "text", text: "task created with id=T-new123" }] };
        }
        if (name === "updateTaskStatus") {
          return { content: [{ type: "text", text: "ok" }] };
        }
        if (name === "elicit") {
          return { content: [{ type: "text", text: JSON.stringify({ action: "accept", content: { name: "acme" } }) }] };
        }
        throw new Error(`unexpected tool ${name}`);
      });

      const response = await client.createElicitation(params);

      expect(mcpBridge.callTool).toHaveBeenNthCalledWith(1, "createTask", {
        title: params.message,
        body: params.message,
        assignee: "human",
      });
      expect(mcpBridge.callTool).toHaveBeenNthCalledWith(2, "updateTaskStatus", {
        taskId: "T-new123",
        status: "ongoing",
      });
      expect(mcpBridge.callTool).toHaveBeenNthCalledWith(3, "elicit", {
        taskId: "T-new123",
        message: params.message,
        mode: "form",
        requestedSchema: params.requestedSchema,
      });
      expect(response).toEqual({ action: "accept", content: { name: "acme" } });
    });

    it("should truncate long messages for the created task's title", async () => {
      const longMessage = "x".repeat(120);
      const params = { mode: "form", message: longMessage, requestedSchema: { type: "object", properties: {} } } as any;

      mcpBridge.callTool.mockImplementation(async (name: string) => {
        if (name === "createTask") return { content: [{ type: "text", text: "task created with id=T-1" }] };
        if (name === "updateTaskStatus") return { content: [{ type: "text", text: "ok" }] };
        return { content: [{ type: "text", text: JSON.stringify({ action: "cancel" }) }] };
      });

      await client.createElicitation(params);

      const [, createTaskArgs] = mcpBridge.callTool.mock.calls[0];
      expect(createTaskArgs.title).toBe(`${"x".repeat(77)}...`);
      expect(createTaskArgs.title.length).toBe(80);
      expect(createTaskArgs.body).toBe(longMessage);
    });

    it("should cancel when the created task's ID cannot be parsed", async () => {
      const params = { sessionId: undefined, mode: "form", message: "Name?", requestedSchema: {} } as any;
      mcpBridge.callTool.mockResolvedValue({ content: [{ type: "text", text: "something went wrong" }] });

      const response = await client.createElicitation(params);

      expect(mcpBridge.callTool).toHaveBeenCalledTimes(1);
      expect(mcpBridge.callTool).toHaveBeenCalledWith("createTask", expect.any(Object));
      expect(response).toEqual({ action: "cancel" });
    });

    it("should cancel when task creation throws", async () => {
      const params = { mode: "form", message: "Name?", requestedSchema: {} } as any;
      mcpBridge.callTool.mockRejectedValue(new Error("MCP not connected"));

      const response = await client.createElicitation(params);

      expect(response).toEqual({ action: "cancel" });
    });

    it("should cancel for an unsupported elicitation mode", async () => {
      const getTaskId = vi.fn().mockReturnValue("task-123");
      const clientWithTaskId = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, getTaskId);
      const params = { sessionId: "sess-1", mode: "_custom", message: "?" } as any;

      const response = await clientWithTaskId.createElicitation(params);

      expect(mcpBridge.callTool).not.toHaveBeenCalled();
      expect(response).toEqual({ action: "cancel" });
    });

    it("should cancel when the elicit tool call errors", async () => {
      const getTaskId = vi.fn().mockReturnValue("task-123");
      const clientWithTaskId = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, getTaskId);
      const params = {
        sessionId: "sess-1",
        mode: "form",
        message: "Name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      } as any;

      mcpBridge.callTool.mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "taskId and message are required" }],
      });

      const response = await clientWithTaskId.createElicitation(params);
      expect(response).toEqual({ action: "cancel" });
    });

    it("should cancel when the elicit tool call throws", async () => {
      const getTaskId = vi.fn().mockReturnValue("task-123");
      const clientWithTaskId = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, getTaskId);
      const params = {
        sessionId: "sess-1",
        mode: "form",
        message: "Name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      } as any;

      mcpBridge.callTool.mockRejectedValue(new Error("MCP not connected"));

      const response = await clientWithTaskId.createElicitation(params);
      expect(response).toEqual({ action: "cancel" });
    });
  });

  describe("completeElicitation", () => {
    it("should resolve without side effects", async () => {
      await expect(
        client.completeElicitation({ elicitationId: "oauth-1" } as any)
      ).resolves.toBeUndefined();
      expect(mcpBridge.callTool).not.toHaveBeenCalled();
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
