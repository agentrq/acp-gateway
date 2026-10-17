/**
 * mcpServers.ts
 *
 * The MCP servers from .mcp.json, in the shape ACP hands them to an agent, so
 * every session the agent opens can use them as it did under the old gateway.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { McpServerConfig, McpTransport } from "./config.js";
import { debug } from "./log.js";

/**
 * What the agent said about a transport, if anything.
 *
 * stdio is the one transport every agent must support. For the others the
 * answer is only trustworthy when the agent actually stated it: an agent that
 * advertises no MCP capabilities at all is far more likely to be terse than to
 * be unable to reach an HTTP server, and dropping its servers on that reading
 * would take the workspace's own MCP server away from it.
 */
function transportSupport(
  transport: McpTransport,
  agentCapabilities: acp.AgentCapabilities | null | undefined,
): "required" | "declared" | "refused" | "unstated" {
  if (transport === "stdio") return "required";
  const declared = (agentCapabilities?.mcpCapabilities as Record<string, unknown> | undefined)?.[
    transport
  ];
  if (declared === true) return "declared";
  if (declared === false) return "refused";
  return "unstated";
}

export function mapMcpServers(
  configs: McpServerConfig[],
  agentCapabilities?: acp.AgentCapabilities | null,
): acp.McpServer[] {
  return configs
    .filter((cfg) => {
      const support = transportSupport(cfg.type, agentCapabilities);
      if (support === "refused") {
        debug(
          `[acp] Not passing MCP server "${cfg.name}" to the agent: it is ${cfg.type}, ` +
            `and the agent says it does not support that transport. Passing it anyway ` +
            `risks the agent refusing the whole session.`,
        );
        return false;
      }
      if (support === "unstated") {
        debug(
          `[acp] MCP server "${cfg.name}" is ${cfg.type}, which the agent does not ` +
            `advertise either way — passing it and letting the agent decide.`,
        );
      }
      return true;
    })
    .map((cfg): acp.McpServer => {
      if (cfg.type === "stdio") {
        return {
          name: cfg.name,
          command: cfg.command!,
          args: cfg.args ?? [],
          env: Object.entries(cfg.env || {}).map(([name, value]) => ({ name, value })) as any,
        };
      }
      return {
        type: cfg.type,
        name: cfg.name,
        url: cfg.url!,
        headers: Object.entries(cfg.headers || {}).map(([name, value]) => ({ name, value })) as any,
      };
    });
}
