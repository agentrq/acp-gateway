#!/usr/bin/env node
/**
 * index.ts
 *
 * The main entry point for acp-gateway.
 * Orchestrates the bridge between the ACP Agent and the agentrq MCP Server.
 */

import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { readFileSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

import { loadMcpConfig, pickAgentrqServer, type McpServerConfig } from "./config.js";
import { MCPBridge } from "./mcpClient.js";

export function mapMcpServers(configs: McpServerConfig[]): acp.McpServer[] {
  return configs.map((cfg): acp.McpServer => {
    if (cfg.type === "http") {
      return {
        type: "http",
        name: cfg.name,
        url: cfg.url!,
        headers: Object.entries(cfg.headers || {}).map(([name, value]) => ({ name, value })) as any,
      };
    } else {
      return {
        name: cfg.name,
        command: cfg.command!,
        args: cfg.args ?? [],
        env: Object.entries(cfg.env || {}).map(([name, value]) => ({ name, value })) as any,
      };
    }
  });
}
import { AgentRQACPClient } from "./acpClient.js";
import {
  extractTaskIdFromMeta,
  extractTaskIdFromText,
} from "./taskIdentity.js";

const lastTaskContent = new Map<string, string>();

type AcpNewSessionParams = Parameters<
  acp.ClientSideConnection["newSession"]
>[0];

export function createAcpSessionSwitcher(
  connection: acp.ClientSideConnection,
  params: AcpNewSessionParams,
  initialSessionId: string,
) {
  let currentSessionId = initialSessionId;
  const taskSessionMap = new Map<string, string>();
  const sessionTaskMap = new Map<string, string>();

  return {
    getSessionId(): string {
      return currentSessionId;
    },
    getTaskIdForSession(sessionId: string): string | undefined {
      return sessionTaskMap.get(sessionId);
    },
    async ensureForTask(taskId: string | undefined): Promise<string> {
      if (taskId === undefined) {
        return currentSessionId;
      }

      const existing = taskSessionMap.get(taskId);
      if (existing) {
        currentSessionId = existing;
        return existing;
      }

      const next = await connection.newSession(params);
      currentSessionId = next.sessionId;
      taskSessionMap.set(taskId, currentSessionId);
      sessionTaskMap.set(currentSessionId, taskId);
      console.error(
        `[acp] New ACP session for task ${taskId} (MCP connection unchanged): ${currentSessionId}`,
      );
      return currentSessionId;
    },
  };
}


export class TaskQueue {
  private activeTasks = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor(private maxConcurrency: number) {}

  async run(taskFn: () => Promise<void>): Promise<void> {
    if (this.activeTasks < this.maxConcurrency) {
      await this.execute(taskFn);
    } else {
      await new Promise<void>((resolve, reject) => {
        this.queue.push(async () => {
          try {
            await taskFn();
            resolve();
          } catch (err) {
            reject(err);
            throw err;
          }
        });
      });
    }
  }

  private async execute(taskFn: () => Promise<void>): Promise<void> {
    this.activeTasks++;
    try {
      await taskFn();
    } finally {
      this.activeTasks--;
      this.next();
    }
  }

  private next() {
    if (this.queue.length > 0 && this.activeTasks < this.maxConcurrency) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        this.execute(nextTask).catch((err) => {
          console.log("[queue] Error executing queued task:", err);
        });
      }
    }
  }

  public getActiveCount(): number {
    return this.activeTasks;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}

async function main() {
  console.log(`Starting [acp-gateway] ${pkg.name} v${pkg.version}`);

  const args = process.argv.slice(2);

  // Find where the command starts (after -- if provided, or just all args)
  const cmdStartIndex = args.indexOf("--");
  const acpCmdArgs =
    cmdStartIndex !== -1 ? args.slice(cmdStartIndex + 1) : args;

  if (acpCmdArgs.length === 0) {
    console.log("Usage: acp-gateway [--max-concurrency <number>] -- <acp-server-command> [args...]");
    console.log("Example: acp-gateway --max-concurrency 4 -- gemini --acp");
    process.exit(1);
  }

  // 1. Load MCP Config
  const configs = loadMcpConfig();
  const agentrqConfig = pickAgentrqServer(configs);

  // Parse max concurrency from CLI args, falling back to default of 2
  let maxConcurrency = 2;
  const gatewayArgs = cmdStartIndex !== -1 ? args.slice(0, cmdStartIndex) : [];
  const maxConcurrencyIdx = gatewayArgs.findIndex(
    (arg) => arg === "--max-concurrency" || arg === "--maxConcurrency",
  );
  if (maxConcurrencyIdx !== -1 && maxConcurrencyIdx + 1 < gatewayArgs.length) {
    const val = parseInt(gatewayArgs[maxConcurrencyIdx + 1], 10);
    if (!isNaN(val)) {
      maxConcurrency = val;
    }
  }

  const taskQueue = new TaskQueue(maxConcurrency);

  // 2. Initialize MCP Bridge
  const mcpBridge = new MCPBridge(agentrqConfig);
  await mcpBridge.connect();

  // 3. Spawn ACP Agent Subprocess
  const [cmd, ...cmdArgs] = acpCmdArgs;
  console.error(`[acp] Spawning agent: ${cmd} ${cmdArgs.join(" ")}`);

  const agentProcess = spawn(cmd, cmdArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...agentrqConfig.env },
  });

  const input = Writable.toWeb(agentProcess.stdin!);
  const output = Readable.toWeb(
    agentProcess.stdout!,
  ) as ReadableStream<Uint8Array>;

  // 4. Create ACP Connection
  // taskIdLookup is filled in after the session switcher is created below.
  let taskIdLookup: (sessionId: string) => string | undefined = () => undefined;
  const acpClient = new AgentRQACPClient(mcpBridge, (sid) => taskIdLookup(sid));
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(
    (_agent) => acpClient,
    stream,
  );

  try {
    // 5. Initialize ACP Connection
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    console.error(
      `[acp] Connected to agent (protocol v${initResult.protocolVersion})`,
    );

    // 6. Create ACP Session
    // We pass our agentrq MCP server to the agent so it can use our tools directly.
    // The McpServer object must follow the ACP protocol schema (type, name, url, headers).
    const newSessionParams: AcpNewSessionParams = {
      cwd: process.cwd(),
      mcpServers: mapMcpServers(configs),
    };

    const sessionResult = await connection.newSession(newSessionParams);

    const sessionSwitcher = createAcpSessionSwitcher(
      connection,
      newSessionParams,
      sessionResult.sessionId,
    );
    taskIdLookup = (sid) => sessionSwitcher.getTaskIdForSession(sid);
    console.error(`[acp] Created session: ${sessionSwitcher.getSessionId()}`);

    // Bridge: MCP -> ACP
    // When the MCP server sends a notification to 'notifications/claude/channel',
    // it contains a new task content.
    mcpBridge.on("task", ({ content, meta }) => {
      const taskId = extractTaskIdFromMeta(meta);
      if (taskId) {
        if (lastTaskContent.get(taskId) === content) {
          console.log(`[bridge] Dropping repetitive task notification for ${taskId}`);
          return;
        }
        lastTaskContent.set(taskId, content);
      }
      console.error(
        "\n[bridge] Incoming task from MCP server. Forwarding to ACP agent...",
      );
      taskQueue.run(async () => {
        try {
          const sessionId = await sessionSwitcher.ensureForTask(taskId);
          const result = await connection.prompt({
            sessionId,
            prompt: [{ type: "text", text: content }],
          });

          await acpClient.flushReply(sessionId);
          console.error(
            `\n[acp] Agent completed task. Reason: ${result.stopReason}`,
          );
        } catch (err) {
          console.error("[acp] Error during prompt execution:", err);
        }
      }).catch((err) => {
        console.error("[bridge] Error queuing task:", err);
      });
    });

    // Initial check for a pending task
    await checkForNextTask(mcpBridge, connection, sessionSwitcher, acpClient, taskQueue);

    // Keep the process alive
    await new Promise(() => { });
  } catch (error) {
    console.error("[acp-gateway] Error:", error);
  } finally {
    agentProcess.kill();
    await mcpBridge.close();
    process.exit(0);
  }
}

/**
 * Checks for the next pending task using the 'getNextTask' tool on the MCP server.
 * If found, sends it to the ACP agent.
 */
export async function checkForNextTask(
  mcpBridge: MCPBridge,
  connection: acp.ClientSideConnection,
  sessionSwitcher: ReturnType<typeof createAcpSessionSwitcher>,
  acpClient: AgentRQACPClient,
  taskQueue?: TaskQueue,
) {
  console.error("[bridge] Checking for next task via MCP server...");
  try {
    const result = await mcpBridge.callTool("getNextTask");

    if (result.isError) {
      console.error("[mcp] Error getting next task:", result.content);
      return;
    }

    const contentBlock = result.content as Array<{
      type: string;
      text?: string;
    }>;
    const content = contentBlock[0] as { type: string; text: string };
    if (
      content &&
      content.text &&
      !content.text.includes("no pending tasks exist")
    ) {
      const text = content.text;
      const taskId = extractTaskIdFromText(text);
      if (taskId) {
        if (lastTaskContent.get(taskId) === text) {
          console.log(`[bridge] Dropping repetitive checked task for ${taskId}`);
          return;
        }
        lastTaskContent.set(taskId, text);
      }
      console.error(
        `[bridge] Found task: "${text.slice(0, 50).replace(/\n/g, " ")}..."`,
      );

      const runFn = async () => {
        const sessionId = await sessionSwitcher.ensureForTask(taskId);
        const promptResult = await connection.prompt({
          sessionId,
          prompt: [{ type: "text", text }],
        });

        await acpClient.flushReply(sessionId);
        console.error(`\n[acp] Agent completed with: ${promptResult.stopReason}`);
      };

      if (taskQueue) {
        await taskQueue.run(runFn);
      } else {
        await runFn();
      }
    } else {
      console.error("[bridge] No pending tasks available.");
    }
  } catch (err) {
    console.error("[bridge] Failed to check for next task:", err);
  }
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}

