import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
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

  /**
   * Answers the tool call that is waiting, the way agentrq does: by echoing
   * back the request id the gateway actually sent.
   */
  function answerWith(behavior: string) {
    setTimeout(() => {
      const sent = mcpBridge.sendNotification.mock.calls.at(-1)?.[1];
      mcpBridge.emit("verdict", { requestId: sent?.request_id, behavior });
    }, 10);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // A real emitter: the client registers one shared verdict listener when it
    // is constructed, so a mocked `on` would never see a verdict at all.
    mcpBridge = Object.assign(new EventEmitter(), {
      getSessionId: vi.fn().mockReturnValue("test-session"),
      sendNotification: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn(),
    });
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

      answerWith("allow");

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
      // Nothing may be left waiting on a verdict that will never come.
      expect(client.pendingPermissionCount).toBe(0);

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

      answerWith("allow");

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

      answerWith("allow");

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

      answerWith("allow");

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

      answerWith("allow");

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

      answerWith("allow");

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

      answerWith("allow");

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

      answerWith("allow");

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
      answerWith("allow");
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

      answerWith("allow");

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

      answerWith("allow");

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

      answerWith("deny");

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

      answerWith("deny");

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

      answerWith("deny");

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

      answerWith("deny");

      const response = await client.requestPermission(params);
      expect((response.outcome as any).optionId).toBe("opt-2");
    });

    it("should cancel a deny verdict rather than select an allow option when every option is allow-kind", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [{ optionId: "opt-1", kind: "allow_once", name: "Proceed" }],
      } as any;

      answerWith("deny");

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

      answerWith("allow");

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

      answerWith("deny");

      const response = await client.requestPermission(params);
      expect((response.outcome as any).optionId).toBe("opt-once");
    });

    it("should cancel an allow verdict rather than select an always-kind option when no once option exists", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [{ optionId: "opt-always", kind: "allow_always", name: "Always Allow" }],
      } as any;

      answerWith("allow");

      const response = await client.requestPermission(params);
      expect(response.outcome.outcome).toBe("cancelled");
    });

    it("should fall back to first option if no match", async () => {
      const params = {
        toolCall: { toolCallId: "req-123" },
        options: [{ optionId: "opt-default", kind: "other", name: "Maybe" }],
      } as any;

      answerWith("allow");

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

  describe("waiting for a verdict", () => {
    const params = (overrides: Record<string, any> = {}) => ({
      sessionId: "sess-1",
      toolCall: { toolCallId: "call-1", title: "Bash", rawInput: { command: "ls" } },
      options: [
        { optionId: "opt-1", kind: "allow_once", name: "Allow" },
        { optionId: "opt-2", kind: "reject_once", name: "Deny" },
      ],
      ...overrides,
    }) as any;

    it("should scope the request id to the session it came from", async () => {
      answerWith("allow");
      await client.requestPermission(params());

      // agentrq keys its bookkeeping on the request id alone, workspace-wide,
      // while tool call ids are only unique within one session.
      expect(mcpBridge.sendNotification.mock.calls[0][1].request_id).toBe("sess-1:call-1");
    });

    it("should fall back to the bare tool call id when there is no session", async () => {
      answerWith("allow");
      await client.requestPermission(params({ sessionId: undefined }));

      expect(mcpBridge.sendNotification.mock.calls[0][1].request_id).toBe("call-1");
    });

    it("should keep one verdict listener however many calls are waiting", async () => {
      const waiting = [
        client.requestPermission(params()),
        client.requestPermission(params({ toolCall: { toolCallId: "call-2", title: "Bash" } })),
        client.requestPermission(params({ toolCall: { toolCallId: "call-3", title: "Bash" } })),
      ];
      await vi.waitFor(() => expect(client.pendingPermissionCount).toBe(3));

      // A listener per request was only ever removed on a matching verdict, so
      // every unanswered request leaked one for the life of the process.
      expect(mcpBridge.listenerCount("verdict")).toBe(1);

      client.cancelPendingPermissions("test");
      await Promise.all(waiting);
      expect(client.pendingPermissionCount).toBe(0);
    });

    it("should ignore a verdict for a call that is not waiting", async () => {
      answerWith("allow");
      await client.requestPermission(params());

      expect(() => mcpBridge.emit("verdict", { requestId: "gone", behavior: "allow" })).not.toThrow();
    });

    it("should give up on a call nobody answers, and stop the turn", async () => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const bounded = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => "task-1", {
        permissionTimeoutMs: 60_000,
      });
      bounded.setSessionCanceller(cancel);

      const waiting = bounded.requestPermission(params());
      await vi.waitFor(() => expect(bounded.pendingPermissionCount).toBe(1));
      await vi.advanceTimersByTimeAsync(60_000);

      // Cancelling as well as answering: the spec treats "cancelled" as the
      // answer a client gives because it cancelled the turn. Answering alone
      // would leave the agent free to carry on and ask again.
      expect((await waiting).outcome.outcome).toBe("cancelled");
      expect(cancel).toHaveBeenCalledWith("sess-1");
      expect(bounded.pendingPermissionCount).toBe(0);
      vi.useRealTimers();
    });

    it("should survive a turn that cannot be cancelled", async () => {
      vi.useFakeTimers();
      const bounded = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => "task-1", {
        permissionTimeoutMs: 60_000,
      });
      bounded.setSessionCanceller(() => {
        throw new Error("connection gone");
      });

      const waiting = bounded.requestPermission(params());
      await vi.waitFor(() => expect(bounded.pendingPermissionCount).toBe(1));
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await waiting).outcome.outcome).toBe("cancelled");
      vi.useRealTimers();
    });

    it("should wait indefinitely when the timeout is switched off", async () => {
      vi.useFakeTimers();
      const unbounded = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => "task-1", {
        permissionTimeoutMs: 0,
      });

      const waiting = unbounded.requestPermission(params());
      await vi.waitFor(() => expect(unbounded.pendingPermissionCount).toBe(1));
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

      expect(unbounded.pendingPermissionCount).toBe(1);
      unbounded.cancelPendingPermissions("test over");
      expect((await waiting).outcome.outcome).toBe("cancelled");
      vi.useRealTimers();
    });

    it("should answer everything still waiting when the agent is gone", async () => {
      const waiting = client.requestPermission(params());
      await vi.waitFor(() => expect(client.pendingPermissionCount).toBe(1));

      client.cancelPendingPermissions("agent process exited");

      expect((await waiting).outcome.outcome).toBe("cancelled");
      expect(client.pendingPermissionCount).toBe(0);
    });

    it("should re-send waiting calls when the workspace reconnects", async () => {
      const waiting = client.requestPermission(params());
      await vi.waitFor(() => expect(client.pendingPermissionCount).toBe(1));
      const sentFirst = mcpBridge.sendNotification.mock.calls.length;

      mcpBridge.emit("reconnected");
      await vi.waitFor(() =>
        expect(mcpBridge.sendNotification.mock.calls.length).toBe(sentFirst + 1),
      );

      // Same request id: the workspace has to recognise this as the decision it
      // is already showing, not a new one to ask about again.
      const [first, resent] = mcpBridge.sendNotification.mock.calls.map((c: any[]) => c[1]);
      expect(resent).toEqual(first);
      expect(client.pendingPermissionCount).toBe(1);

      answerWith("allow");
      expect((await waiting).outcome.outcome).toBe("selected");
    });

    it("should not talk to the workspace on reconnect when nothing is waiting", () => {
      mcpBridge.emit("reconnected");

      expect(mcpBridge.sendNotification).not.toHaveBeenCalled();
    });

    it("should keep waiting when the re-send itself fails", async () => {
      const waiting = client.requestPermission(params());
      await vi.waitFor(() => expect(client.pendingPermissionCount).toBe(1));

      mcpBridge.sendNotification.mockRejectedValueOnce(new Error("still down"));
      mcpBridge.emit("reconnected");
      await vi.waitFor(() =>
        expect(mcpBridge.sendNotification.mock.calls.length).toBeGreaterThan(1),
      );

      // The next reconnect gets another go; giving up here would lose the turn.
      expect(client.pendingPermissionCount).toBe(1);
      client.cancelPendingPermissions("test over");
      await waiting;
    });


    it("should cancel only the pending permissions for the specified session", async () => {
      const waitSess1 = client.requestPermission(params({ sessionId: "sess-1", toolCall: { toolCallId: "call-1", title: "Bash" } }));
      const waitSess2 = client.requestPermission(params({ sessionId: "sess-2", toolCall: { toolCallId: "call-2", title: "Bash" } }));
      const waitNoSess = client.requestPermission(params({ sessionId: undefined, toolCall: { toolCallId: "call-3", title: "Bash" } }));
      await vi.waitFor(() => expect(client.pendingPermissionCount).toBe(3));

      client.cancelPendingPermissions("task cancelled", "sess-1");

      expect((await waitSess1).outcome.outcome).toBe("cancelled");
      expect(client.pendingPermissionCount).toBe(2);

      // Requests with undefined sessionId should NOT be cancelled by a session-scoped cancel
      mcpBridge.emit("verdict", { requestId: "sess-2:call-2", behavior: "allow" });
      expect((await waitSess2).outcome.outcome).toBe("selected");
      mcpBridge.emit("verdict", { requestId: "call-3", behavior: "allow" });
      expect((await waitNoSess).outcome.outcome).toBe("selected");
      expect(client.pendingPermissionCount).toBe(0);
    });

    it("should do nothing if sessionId does not match any waiting permissions", async () => {
      const waiting = client.requestPermission(params({ sessionId: "sess-1" }));
      await vi.waitFor(() => expect(client.pendingPermissionCount).toBe(1));

      client.cancelPendingPermissions("task cancelled", "sess-999");
      expect(client.pendingPermissionCount).toBe(1);

      answerWith("allow");
      expect((await waiting).outcome.outcome).toBe("selected");
    });

    it("should send session/cancel RPC before settling pending permissions", async () => {
      const callOrder: string[] = [];
      const cancelSession = vi.fn().mockImplementation(async () => {
        callOrder.push("cancelRPC");
      });
      client.setSessionCanceller(cancelSession);

      const waiting = client.requestPermission(params({ sessionId: "sess-1" })).then((res) => {
        callOrder.push("settledPermission");
        return res;
      });
      await vi.waitFor(() => expect(client.pendingPermissionCount).toBe(1));

      await client.cancelTurn("sess-1");
      const res = await waiting;

      expect(callOrder).toEqual(["cancelRPC", "settledPermission"]);
      expect(res.outcome.outcome).toBe("cancelled");
      expect(cancelSession).toHaveBeenCalledWith("sess-1");
      expect(client.pendingPermissionCount).toBe(0);
    });

    it("should settle waiting permissions even if session/cancel never returns", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // An agent wedged on its stdin: the write goes out, nothing comes back.
      // The permissions must still settle or their queue slots are held forever.
      client.setSessionCanceller(() => new Promise(() => {}));

      const waiting = client.requestPermission(params({ sessionId: "sess-1" }));
      await vi.waitFor(() => expect(client.pendingPermissionCount).toBe(1));

      vi.useFakeTimers();
      try {
        const cancelling = client.cancelTurn("sess-1");
        await vi.advanceTimersByTimeAsync(5000);
        await cancelling;
      } finally {
        vi.useRealTimers();
      }

      expect((await waiting).outcome.outcome).toBe("cancelled");
      expect(client.pendingPermissionCount).toBe(0);
      errorSpy.mockRestore();
    });

    it("should handle cancelTurn with undefined sessionId or no canceller gracefully", async () => {
      await expect(client.cancelTurn(undefined)).resolves.toBeUndefined();

      const freshClient = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => "task-1");
      await expect(freshClient.cancelTurn("sess-1")).resolves.toBeUndefined();
    });

    it("should log error if cancelSession rejects during cancelTurn", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      client.setSessionCanceller(() => {
        throw new Error("cancel RPC failed");
      });

      await client.cancelTurn("sess-1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to cancel turn for session sess-1:"),
        expect.any(Error)
      );
      errorSpy.mockRestore();
    });

    it("should say nothing when there is nothing waiting to cancel", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      client.cancelPendingPermissions("nothing doing");

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe("session mode changes", () => {
    it("should hand a mode change to whoever is watching for it", async () => {
      const onMode = vi.fn();
      client.setModeChangeHandler(onMode);

      await client.sessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "current_mode_update", currentModeId: "auto" },
      } as any);

      expect(onMode).toHaveBeenCalledWith("sess-1", "auto");
    });

    it("should not mind a mode change nobody is watching for", async () => {
      await expect(
        client.sessionUpdate({
          sessionId: "sess-1",
          update: { sessionUpdate: "current_mode_update", currentModeId: "auto" },
        } as any),
      ).resolves.toBeUndefined();
    });
  });

  describe("reportStopReason", () => {
    function clientForTask(taskId: string | undefined) {
      return new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => taskId);
    }

    it("should say nothing when the agent simply finished", async () => {
      await clientForTask("task-1").reportStopReason("sess-1", "end_turn");

      expect(mcpBridge.callTool).not.toHaveBeenCalled();
    });

    it("should tell the workspace when a turn was refused or cut short", async () => {
      const client = clientForTask("task-1");

      await client.reportStopReason("sess-1", "refusal");
      await client.reportStopReason("sess-1", "max_tokens");
      await client.reportStopReason("sess-1", "max_turn_requests");
      await client.reportStopReason("sess-1", "cancelled");

      const texts = mcpBridge.callTool.mock.calls.map((c: any[]) => c[1].text);
      expect(mcpBridge.callTool.mock.calls.every((c: any[]) => c[0] === "reply")).toBe(true);
      expect(texts[0]).toContain("refused");
      expect(texts[1]).toContain("ran out of output tokens");
      expect(texts[2]).toContain("model requests");
      expect(texts[3]).toContain("cancelled");
    });

    it("should still report a stop reason it does not recognise", async () => {
      await clientForTask("task-1").reportStopReason("sess-1", "something_new");

      expect(mcpBridge.callTool).toHaveBeenCalledWith("reply", {
        chatId: "task-1",
        text: expect.stringContaining("something_new"),
      });
    });

    it("should skip a session with no task behind it", async () => {
      await clientForTask(undefined).reportStopReason("sess-1", "refusal");

      expect(mcpBridge.callTool).not.toHaveBeenCalled();
    });

    it("should survive a workspace that cannot be reached", async () => {
      mcpBridge.callTool.mockRejectedValue(new Error("offline"));

      await expect(
        clientForTask("task-1").reportStopReason("sess-1", "refusal"),
      ).resolves.toBeUndefined();
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
  describe("streaming telemetry", () => {
    /** Every telemetry notification the bridge was asked to send, in order. */
    function telemetrySent() {
      return mcpBridge.sendNotification.mock.calls
        .filter((c: any[]) => c[0] === "notifications/claude/channel/telemetry")
        .map((c: any[]) => c[1]);
    }

    function newClient(taskId = "task-123") {
      mcpBridge.callTool = vi
        .fn()
        .mockResolvedValue({ isError: false, content: [] });
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      return new AgentRQACPClient(
        mcpBridge as unknown as MCPBridge,
        () => taskId,
      );
    }

    function thought(text: string) {
      return {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        },
      } as any;
    }

    it("batches thought chunks into one block per boundary", async () => {
      const c = newClient();

      await c.sessionUpdate(thought("Let me "));
      await c.sessionUpdate(thought("check the config."));
      // Nothing goes out mid-block: one notification per token is unusable.
      expect(telemetrySent()).toHaveLength(0);

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          title: "read_file",
          status: "pending",
          toolCallId: "tc-1",
        },
      } as any);
      await c.flushReply("sess-1");

      const thoughts = telemetrySent().filter((p: any) => p.kind === "thought");
      expect(thoughts).toHaveLength(1);
      expect(thoughts[0]).toMatchObject({
        task_id: "task-123",
        session_id: "sess-1",
        kind: "thought",
        text: "Let me check the config.",
      });
    });

    it("closes off a reasoning block when the agent starts answering", async () => {
      const c = newClient();

      await c.sessionUpdate(thought("Thinking first."));
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The answer." },
        },
      } as any);
      await c.sessionUpdate(thought("Second thought."));
      await c.flushReply("sess-1");

      expect(
        telemetrySent()
          .filter((p: any) => p.kind === "thought")
          .map((p: any) => p.text),
      ).toEqual(["Thinking first.", "Second thought."]);
    });

    it("keeps reasoning out of the reply the human sees", async () => {
      const c = newClient();

      await c.sessionUpdate(thought("Internal reasoning."));
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done." },
        },
      } as any);
      await c.flushReply("sess-1");

      expect(mcpBridge.callTool).toHaveBeenCalledWith("reply", {
        chatId: "task-123",
        text: "Done.",
      });
    });

    it("ignores non-text thought chunks", async () => {
      const c = newClient();

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "image", data: "…" },
        },
      } as any);
      await c.flushReply("sess-1");

      expect(telemetrySent()).toHaveLength(0);
    });

    it("does not report whitespace-only reasoning", async () => {
      const c = newClient();

      await c.sessionUpdate(thought("   \n  "));
      await c.flushReply("sess-1");

      expect(telemetrySent()).toHaveLength(0);
    });

    it("reports a legacy plan update as soon as it arrives", async () => {
      const c = newClient();

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read the config", priority: "high", status: "completed" },
            { content: "Add tests", priority: "low", status: "pending" },
          ],
        },
      } as any);
      // Plans are queued, not awaited on the stream's hot path.
      await c.flushReply("sess-1");

      expect(telemetrySent()).toEqual([
        {
          task_id: "task-123",
          session_id: "sess-1",
          kind: "plan",
          text: "- ✅ Read the config\n- ⬜ Add tests",
          data: {
            planId: "default",
            planType: "items",
            entries: [
              {
                content: "Read the config",
                priority: "high",
                status: "completed",
              },
              { content: "Add tests", priority: "low", status: "pending" },
            ],
          },
        },
      ]);
    });

    it("reports an ID-keyed plan update", async () => {
      const c = newClient();

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "plan_update",
          plan: {
            type: "markdown",
            planId: "plan-7",
            content: "## Steps\n1. Ship it",
          },
        },
      } as any);
      await c.flushReply("sess-1");

      expect(telemetrySent()[0]).toMatchObject({
        kind: "plan",
        text: "## Steps\n1. Ship it",
        data: {
          planId: "plan-7",
          planType: "markdown",
          content: "## Steps\n1. Ship it",
        },
      });
    });

    it("reports a withdrawn plan so the human sees it was dropped", async () => {
      const c = newClient();

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "plan_removed", planId: "plan-7" },
      } as any);
      await c.flushReply("sess-1");

      expect(telemetrySent()[0]).toMatchObject({
        kind: "plan",
        text: "Plan withdrawn.",
        data: { planId: "plan-7", removed: true },
      });
    });

    it("puts reasoning in front of the plan it explains", async () => {
      const c = newClient();

      await c.sessionUpdate(thought("I should plan this out."));
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "plan", entries: [] },
      } as any);
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "plan_removed", planId: "default" },
      } as any);
      await c.flushReply("sess-1");

      expect(telemetrySent().map((p: any) => p.kind)).toEqual([
        "thought",
        "plan",
        "plan",
      ]);
    });

    it("reports only the last usage snapshot, once the turn is over", async () => {
      const c = newClient();

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "usage_update", used: 100, size: 200_000 },
      } as any);
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "usage_update",
          used: 50_000,
          size: 200_000,
          cost: { amount: 0.42, currency: "USD" },
        },
      } as any);
      // Each snapshot supersedes the last, so none go out mid-turn.
      expect(telemetrySent()).toHaveLength(0);

      await c.flushReply("sess-1");

      expect(telemetrySent()).toEqual([
        {
          task_id: "task-123",
          session_id: "sess-1",
          kind: "usage",
          text: "Context 50,000 / 200,000 tokens (25%) · 0.42 USD",
          data: {
            used: 50_000,
            size: 200_000,
            percent: 25,
            cost: { amount: 0.42, currency: "USD" },
          },
        },
      ]);
    });

    it("does not report the same usage snapshot on a later turn", async () => {
      const c = newClient();

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "usage_update", used: 100, size: 200_000 },
      } as any);
      await c.flushReply("sess-1");
      mcpBridge.sendNotification.mockClear();

      await c.flushReply("sess-1");
      expect(telemetrySent()).toHaveLength(0);
    });

    it("orders reasoning, the reply, then the usage footer", async () => {
      const c = newClient();
      const order: string[] = [];
      mcpBridge.sendNotification = vi.fn(async (_m: string, p: any) => {
        order.push(p.kind);
      });
      mcpBridge.callTool = vi.fn(async () => {
        order.push("reply");
        return { isError: false, content: [] };
      });

      await c.sessionUpdate(thought("Reasoning."));
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Answer." },
        },
      } as any);
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: { sessionUpdate: "usage_update", used: 1, size: 100 },
      } as any);
      await c.flushReply("sess-1");

      expect(order).toEqual(["thought", "reply", "usage"]);
    });

    it("drops telemetry when the session has no task to attach it to", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const c = new AgentRQACPClient(
        mcpBridge as unknown as MCPBridge,
        () => undefined,
      );

      await c.sessionUpdate(thought("Nowhere to put this."));
      await c.flushReply("sess-1");

      expect(telemetrySent()).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("dropping thought telemetry"),
      );
      consoleSpy.mockRestore();
    });

    it("still delivers the reply when telemetry cannot be sent", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const c = newClient();
      mcpBridge.sendNotification.mockRejectedValue(new Error("offline"));

      await c.sessionUpdate(thought("Reasoning."));
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Answer." },
        },
      } as any);
      await c.flushReply("sess-1");

      expect(mcpBridge.callTool).toHaveBeenCalledWith("reply", {
        chatId: "task-123",
        text: "Answer.",
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send thought telemetry"),
        expect.anything(),
      );
      consoleSpy.mockRestore();
    });

    it("keeps sending telemetry after one send has failed", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const c = newClient();
      mcpBridge.sendNotification
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(undefined);

      await c.sessionUpdate(thought("First block."));
      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          title: "read_file",
          status: "pending",
          toolCallId: "tc-1",
        },
      } as any);
      await c.sessionUpdate(thought("Second block."));
      await c.flushReply("sess-1");

      expect(telemetrySent().map((p: any) => p.text)).toEqual([
        "First block.",
        "Second block.",
      ]);
      consoleSpy.mockRestore();
    });

    it("survives a queued send that throws outright", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // Looking up the task is the gateway's own callback, and it is the one
      // step outside sendTelemetry's own error handling.
      const c = new AgentRQACPClient(mcpBridge as unknown as MCPBridge, () => {
        throw new Error("task lookup blew up");
      });

      await c.sessionUpdate(thought("Reasoning."));
      await expect(c.flushReply("sess-1")).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Telemetry send failed"),
        expect.anything(),
      );
      consoleSpy.mockRestore();
    });

    it("keeps each session's telemetry to itself", async () => {
      const c = new AgentRQACPClient(
        mcpBridge as unknown as MCPBridge,
        (sessionId: string) => `task-${sessionId}`,
      );

      await c.sessionUpdate(thought("Session one."));
      await c.sessionUpdate({
        sessionId: "sess-2",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Session two." },
        },
      } as any);
      await c.flushReply("sess-2");

      expect(telemetrySent()).toHaveLength(1);
      expect(telemetrySent()[0]).toMatchObject({
        task_id: "task-sess-2",
        text: "Session two.",
      });
    });
  });

  describe("models support", () => {
    it("forwards models to workspace on config_option_update", async () => {
      const c = new AgentRQACPClient(
        mcpBridge as unknown as MCPBridge,
        (sessionId: string) => `task-${sessionId}`,
      );

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "claude-3-7-sonnet",
              options: [
                { value: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
                { value: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
              ],
            },
          ],
        },
      } as any);

      expect(mcpBridge.sendNotification).toHaveBeenCalledWith(
        "notifications/claude/channel/models",
        {
          task_id: "task-sess-1",
          session_id: "sess-1",
          config_id: "model",
          current_model: "claude-3-7-sonnet",
          models: [
            { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", current: true },
            { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku", current: false },
          ],
        },
      );
    });

    it("ignores config_option_update if no model options exist", async () => {
      const c = new AgentRQACPClient(
        mcpBridge as unknown as MCPBridge,
        (sessionId: string) => `task-${sessionId}`,
      );

      await c.sessionUpdate({
        sessionId: "sess-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "theme",
              name: "Theme",
              type: "select",
              currentValue: "dark",
              options: [{ value: "dark", name: "Dark" }],
            },
          ],
        },
      } as any);

      expect(mcpBridge.sendNotification).not.toHaveBeenCalledWith(
        "notifications/claude/channel/models",
        expect.anything(),
      );
    });

    it("skips models notification when no task ID is found for session", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const c = new AgentRQACPClient(
        mcpBridge as unknown as MCPBridge,
        () => undefined,
      );

      await c.sendModelsToWorkspace("sess-notask", {
        configId: "model",
        currentModelId: "gpt-4",
        models: [{ id: "gpt-4", name: "GPT-4", current: true }],
      });

      expect(mcpBridge.sendNotification).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No task ID for session sess-notask, not sending models notification"),
      );
      consoleSpy.mockRestore();
    });

    it("handles error when sending models notification fails", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mcpBridge.sendNotification.mockRejectedValue(new Error("network error"));

      const c = new AgentRQACPClient(
        mcpBridge as unknown as MCPBridge,
        (sessionId: string) => `task-${sessionId}`,
      );

      await c.sendModelsToWorkspace("sess-1", {
        configId: "model",
        currentModelId: "gpt-4",
        models: [{ id: "gpt-4", name: "GPT-4", current: true }],
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send models notification for session sess-1:"),
        expect.anything(),
      );
      consoleSpy.mockRestore();
    });
  });
});
