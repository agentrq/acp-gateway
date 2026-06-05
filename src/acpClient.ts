/**
 * acpClient.ts
 *
 * Implements the ACP Client interface for the agentrq workspace.
 * Routes permission requests to the MCP server.
 */

import * as acp from "@agentclientprotocol/sdk";
import type { MCPBridge } from "./mcpClient.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export class AgentRQACPClient implements acp.Client {
  private replyBuffers = new Map<string, string>();
  // chatId → text sent by the agent via the reply MCP tool (for dedup in flushReply)
  private agentReplies = new Map<string, string>();

  constructor(
    private mcpBridge: MCPBridge,
    private getTaskIdForSession: (sessionId: string) => string | undefined = () => undefined,
  ) {}

  async flushReply(sessionId: string): Promise<void> {
    const text = this.replyBuffers.get(sessionId) ?? "";
    this.replyBuffers.delete(sessionId);
    if (!text.trim()) return;

    const taskId = this.getTaskIdForSession(sessionId);
    if (!taskId) {
      console.error(`[acp] No task ID for session ${sessionId}, skipping reply`);
      return;
    }

    const agentReplyText = this.agentReplies.get(taskId);
    this.agentReplies.delete(taskId);
    if (agentReplyText !== undefined && agentReplyText === text) {
      console.error(`[acp] Skipping reply to task ${taskId} — agent already sent identical reply`);
      return;
    }

    try {
      await this.mcpBridge.callTool("reply", { chatId: taskId, text });
      console.error(`[acp] Forwarded agent reply to task ${taskId}`);
    } catch (err) {
      console.error(`[acp] Failed to forward reply to task ${taskId}:`, err);
    }
  }

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = params.toolCall.toolCallId;
    const toolTitle = params.toolCall.title ?? "Unknown Tool";

    // Auto-allow tool calls that contain the pattern: agentrq-<11 chars a-zA-Z0-9>
    const agentrqToolPattern = /agentrq-[a-zA-Z0-9]{11}/;
    if (agentrqToolPattern.test(toolTitle)) {
      console.error(`\n🔓 ACP Auto-allowing tool call: ${toolTitle} (ID: ${requestId})`);
      const option = params.options.find(o => 
        o.kind.startsWith("allow") ||
        o.name.toLowerCase().includes("allow") || 
        o.name.toLowerCase().includes("yes") || 
        o.name.toLowerCase().includes("approve")
      );
      const optionId = option?.optionId ?? params.options[0].optionId;
      return {
        outcome: {
          outcome: "selected",
          optionId: optionId,
        },
      };
    }

    console.error(`\n🔐 ACP Permission requested: ${toolTitle} (ID: ${requestId})`);

    const taskId = params.sessionId ? this.getTaskIdForSession(params.sessionId) : undefined;
    const payload = {
      request_id: requestId,
      task_id: taskId,
      tool_name: toolTitle,
      description: toolTitle,
      input_preview: JSON.stringify(params.toolCall.rawInput ?? {}),
    };
    console.error(`[acp] Bridge Session ID: ${this.mcpBridge.getSessionId() ?? "unknown"}`);
    console.error(`[acp] Sending permission request notification:`, JSON.stringify(payload, null, 2));

    // 1. Forward the permission request to the MCP server as a notification.
    await this.mcpBridge.sendNotification(
      "notifications/claude/channel/permission_request",
      payload
    );

    // 2. Wait for the verdict from the MCP server
    console.error(`⌛ Waiting for human approval in the agentrq dashboard...`);
    
    return new Promise((resolve) => {
      const handler = (data: { requestId: string; behavior: string }) => {
        if (data.requestId === requestId) {
          // Cleanup this listener
          this.mcpBridge.off("verdict", handler);
          
          console.error(`✅ Permission verdict received: ${data.behavior}`);

          // Map "allow"/"deny" to the correct ACP option
          // ACP options usually include "allow_once", "allow_always", etc.
          const verdictMatch = data.behavior === "allow" ? "allow" : "deny";
          const option = params.options.find(o => 
            o.kind.startsWith(verdictMatch) ||
            o.name.toLowerCase().includes(verdictMatch) || 
            (verdictMatch === "allow" && (o.name.toLowerCase().includes("yes") || o.name.toLowerCase().includes("approve")))
          );

          const optionId = option?.optionId ?? params.options[0].optionId;
          console.error(`[acp] Selected permission option: ${optionId} (${option?.name ?? "default"})`);

          resolve({
            outcome: {
              outcome: "selected",
              optionId: optionId,
            },
          });
        }
      };

      this.mcpBridge.on("verdict", handler);
    });
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          process.stdout.write(update.content.text);
          const sid = params.sessionId;
          this.replyBuffers.set(sid, (this.replyBuffers.get(sid) ?? "") + update.content.text);
        }
        break;
      case "tool_call": {
        const agentrqToolPattern = /agentrq-[a-zA-Z0-9]{11}/;
        if (update.title && agentrqToolPattern.test(update.title)) {
          // Track completed reply calls so flushReply can skip exact duplicates
          if (
            update.status === "completed" &&
            update.title.split(/[\s(]/)[0] === "reply" &&
            update.rawInput != null &&
            typeof (update.rawInput as any).chatId === "string"
          ) {
            const { chatId, text = "" } = update.rawInput as { chatId: string; text?: string };
            this.agentReplies.set(chatId, text);
          }
          break;
        }
        console.error(`\n🔧 [ACP Agent] Tool call: ${update.title} (${update.status})`);
        break;
      }
      default:
        break;
    }
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    const filePath = path.resolve(process.cwd(), params.path);
    console.error(`[acp] Writing file: ${params.path}`);
    
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content, "utf8");
      console.error(`[acp] File written successfully: ${params.path}`);
      return {};
    } catch (err: any) {
      console.error(`[acp] Error writing file ${params.path}:`, err.message);
      throw err;
    }
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    const filePath = path.resolve(process.cwd(), params.path);
    console.error(`[acp] Reading file: ${params.path}`);
    
    try {
      const content = await fs.readFile(filePath, "utf8");
      return { content };
    } catch (err: any) {
      console.error(`[acp] Error reading file ${params.path}:`, err.message);
      throw err;
    }
  }
}
