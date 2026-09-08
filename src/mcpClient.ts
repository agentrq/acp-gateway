/**
 * mcpClient.ts
 *
 * Connects to the agentrq MCP server using the MCP TypeScript SDK.
 * Listens for 'notifications/claude/channel' and handles tool calls.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { McpServerConfig } from "./config.js";
import { extractTaskIdFromMeta } from "./taskIdentity.js";

export class MCPBridge extends EventEmitter {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private isConnected = false;
  private isConnecting = false;
  private isClosed = false;
  // Whether this bridge has ever been connected. A second connection is a
  // reconnection, which matters to anything already waiting on the workspace.
  private hasConnected = false;
  // What the server said it has, last time it was asked.
  private advertisedTools?: ReadonlySet<string>;

  public getSessionId(): string | undefined {
    return (this.transport as any)?._sessionId;
  }

  /**
   * The configured name of the workspace MCP server.
   *
   * Agents name an MCP tool call after the server it belongs to, so this is
   * what lets the gateway tell the workspace's own tool calls apart from
   * everything else the agent does.
   */
  public getServerName(): string {
    return this.config.name;
  }

  /**
   * The tools the workspace server says it has, or undefined if it has not
   * been asked yet.
   *
   * Read rather than guessed so that a tool added to the workspace needs no
   * release here, while a tool name the workspace never advertised is still
   * refused the auto-approval its own tools get.
   */
  public getAdvertisedTools(): ReadonlySet<string> | undefined {
    return this.advertisedTools;
  }

  /**
   * Asks the workspace what it advertises. Called on every connection, since
   * a reconnect may land on a server that has since gained or lost tools.
   *
   * A failure is not fatal: the caller falls back to the tools the workspace
   * is known to have, so an unanswered `tools/list` costs recognition of a
   * newly added tool, not of the workspace itself.
   */
  private async refreshAdvertisedTools(): Promise<void> {
    try {
      const { tools } = await this.client!.listTools();
      this.advertisedTools = new Set(tools.map((t) => t.name));
      console.error(
        `[mcp] ${this.config.name} advertises ${this.advertisedTools.size} tool(s)`,
      );
    } catch (err: any) {
      console.error(
        `[mcp] Could not list tools on ${this.config.name}: ${err?.message ?? err}`,
      );
    }
  }

  constructor(private config: McpServerConfig) {
    super();
    if (!config.url) {
      throw new Error(`MCP server ${config.name} has no URL`);
    }
  }

  async connect() {
    if (this.isConnecting || this.isConnected) return;
    this.isConnecting = true;
    this.isClosed = false;

    let attempt = 0;
    const initialDelay = 1000;
    const maxDelay = 900000; // 15 minutes

    while (!this.isConnected && !this.isClosed) {
      try {
        await this._connectOnce();
        this.isConnected = true;
        console.error(`[mcp] Connected to ${this.config.name}`);
        if (this.hasConnected) {
          // agentrq routes a permission verdict to the MCP session its request
          // arrived on, and reconnecting mints a new one — so anything already
          // waiting for an answer has just been orphaned. Say so, rather than
          // let those calls sit until they time out.
          this.emit("reconnected");
        }
        this.hasConnected = true;
      } catch (error: any) {
        if (this.isClosed) break;
        const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
        console.error(
          `[mcp] Connection failed to ${this.config.name} (attempt ${attempt + 1}): ${error.message || error}. Retrying in ${delay / 1000}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
      }
    }
    this.isConnecting = false;
  }

  private async _connectOnce() {
    // Clean up existing transport and client
    if (this.transport) {
      this.transport.onclose = undefined;
      this.transport.onerror = undefined;
      await this.transport.close().catch(() => { });
      this.transport = null;
    }
    if (this.client) {
      await this.client.close().catch(() => { });
      this.client = null;
    }

    if (!this.config.url) {
      throw new Error("MCP server URL is not configured");
    }
    const url = new URL(this.config.url);
    this.transport = new StreamableHTTPClientTransport(url, {
      reconnectionOptions: {
        maxRetries: 100, // Allow many retries at the transport level
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 900000, // 15 minutes
        reconnectionDelayGrowFactor: 2,
      },
    });
    this.client = new Client(
      {
        name: "acp-gateway",
        version: "0.2.12",
      },
      {
        capabilities: {},
      },
    );

    // Set up transport hooks for disconnection
    this.transport.onclose = () => {
      console.error(`[mcp] Connection to ${this.config.name} lost.`);
      this.isConnected = false;
      this.connect(); // Start reconnection loop
    };

    this.transport.onerror = (error) => {
      const msg = error?.message || String(error);
      console.error(`[mcp] Transport error:`, msg);

      if (msg.includes("Failed to reconnect SSE stream") || msg.includes("Not Found")) {
        console.error(`[mcp] Unrecoverable transport error, forcing new connection...`);
        this.isConnected = false;
        if (this.transport) {
          this.transport.onclose = undefined;
          this.transport.onerror = undefined;
          this.transport.close().catch(() => { });
        }
        this.connect();
      }
    };

    await this.client.connect(this.transport);

    // Set notification handler for directives from the MCP server.
    this.client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/claude/channel"),
        params: z.object({
          content: z.string(),
          meta: z.any().optional(),
        }),
      }),
      (notification) => {
        console.error("[mcp] Received channel notification");
        const { content, meta } = notification.params;
        this.emit("task", { content, meta });
      },
    );

    // Set notification handler for permission verdicts
    this.client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/claude/channel/permission"),
        params: z.object({
          request_id: z.string(),
          behavior: z.string(), // "allow" | "deny"
        }),
      }),
      (notification) => {
        console.error("[mcp] Received permission verdict");
        const { request_id, behavior } = notification.params;
        this.emit("verdict", { requestId: request_id, behavior });
      },
    );
    // Set notification handler for task cancellation
    this.client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/claude/channel/cancel"),
        params: z
          .object({
            task_id: z.string().optional(),
            taskId: z.string().optional(),
            chat_id: z.string().optional(),
            reason: z.string().optional(),
            meta: z.any().optional(),
            _meta: z.any().optional(),
          })
          .passthrough()
          .optional(),
      }),
      (notification) => {
        console.error("[mcp] Received task cancellation notification");
        const params = notification.params ?? {};
        const taskId =
          params.task_id ||
          params.taskId ||
          params.chat_id ||
          extractTaskIdFromMeta(params.meta) ||
          extractTaskIdFromMeta(params._meta);
        this.emit("cancel", { taskId, reason: params.reason });
      },
    );

    await this.refreshAdvertisedTools();
  }

  private async ensureConnected() {
    if (this.isConnected) return;
    if (!this.isConnecting) {
      // Fire and forget connect loop if not already running
      this.connect().catch((err) => {
        console.error(`[mcp] Unexpected error in connect loop:`, err);
      });
    }

    // Wait up to 10 seconds for connection
    let waited = 0;
    while (!this.isConnected && waited < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      waited += 500;
    }

    if (!this.isConnected) {
      throw new Error(`MCP not connected after 10s timeout`);
    }
  }

  async callTool(name: string, args: any = {}) {
    await this.ensureConnected();
    if (!this.client) throw new Error("MCP client not initialized");
    return await this.client.callTool({
      name,
      arguments: args,
    });
  }

  async sendNotification(method: string, params: any) {
    await this.ensureConnected();
    if (!this.client) throw new Error("MCP client not initialized");
    await this.client.notification({
      method,
      params,
    });
  }

  async close() {
    this.isClosed = true;
    this.isConnected = false;
    if (this.transport) {
      this.transport.onclose = undefined;
      this.transport.onerror = undefined;
      await this.transport.close().catch(() => { });
      this.transport = null;
    }
    if (this.client) {
      await this.client.close().catch(() => { });
      this.client = null;
    }
  }
}
