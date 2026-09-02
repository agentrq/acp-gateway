/**
 * config.ts
 *
 * Reads the .mcp.json file from the workspace root and returns the first
 * HTTP MCP server config (preferring any server whose name contains "agentrq").
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The MCP transports ACP defines that this gateway knows how to hand over. */
export const MCP_TRANSPORTS = ["http", "sse", "stdio"] as const;

export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export interface McpServerConfig {
  name: string;
  type: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface McpJson {
  mcpServers: Record<
    string,
    {
      type?: string;
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
    }
  >;
}

/**
 * Find and parse the .mcp.json config file.
 * Searches CWD and then up to 3 parent directories.
 */
export function loadMcpConfig(startDir: string = process.cwd()): McpServerConfig[] {
  const candidates = [
    resolve(startDir, ".mcp.json"),
    resolve(startDir, "..", ".mcp.json"),
    resolve(startDir, "..", "..", ".mcp.json"),
    resolve(startDir, "..", "..", "..", ".mcp.json"),
  ];

  for (const candidate of candidates) {
    // Only reading and parsing may fall through to the next candidate. What the
    // file *says* is a separate matter: once a .mcp.json has been found, a
    // mistake inside it is reported rather than hidden behind "no config found".
    let parsed: McpJson;
    try {
      parsed = JSON.parse(readFileSync(candidate, "utf-8"));
    } catch {
      continue;
    }

    const servers: McpServerConfig[] = Object.entries(parsed.mcpServers ?? {}).map(
      ([name, cfg]) => ({
        name,
        type: readTransport(name, cfg.type, cfg.url),
        url: cfg.url,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        headers: cfg.headers,
      }),
    );
    servers.forEach(assertUsable);

    if (servers.length > 0) {
      console.error(`[config] Loaded .mcp.json from ${candidate}`);
      return servers;
    }
  }

  throw new Error(
    "Could not find .mcp.json — run acp-gateway from your workspace root"
  );
}

/**
 * Reads an entry's transport, defaulting the way MCP clients conventionally do.
 *
 * An unknown transport is refused here rather than quietly treated as stdio,
 * which produced a server with no command and an agent that could not say why.
 */
function readTransport(
  name: string,
  type: string | undefined,
  url: string | undefined,
): McpTransport {
  if (type === undefined) return url ? "http" : "stdio";
  if ((MCP_TRANSPORTS as readonly string[]).includes(type)) return type as McpTransport;
  throw new Error(
    `MCP server "${name}" in .mcp.json has transport "${type}", which this gateway ` +
      `cannot hand to an agent. Use one of: ${MCP_TRANSPORTS.join(", ")}.`,
  );
}

/**
 * Refuses an entry the agent could never connect to.
 *
 * The gateway passes these straight through to the agent, so an entry missing
 * the one field its transport needs fails inside the agent, long after the
 * mistake was made and with nothing to point at.
 */
function assertUsable(server: McpServerConfig): void {
  const missing = server.type === "stdio" ? !server.command : !server.url;
  if (!missing) return;

  const field = server.type === "stdio" ? "command" : "url";
  throw new Error(
    `MCP server "${server.name}" in .mcp.json is ${server.type} but has no ${field}.`,
  );
}

/**
 * Pick the primary agentrq MCP server from the list.
 * Prefers servers with "agentrq" in the name; falls back to the first HTTP server.
 */
export function pickAgentrqServer(
  servers: McpServerConfig[]
): McpServerConfig {
  // Prefer named agentrq server
  const named = servers.find(
    (s) => s.name.toLowerCase().includes("agentrq") && s.type === "http" && s.url
  );
  if (named) return named;

  // Fall back to first HTTP server
  const http = servers.find((s) => s.type === "http" && s.url);
  if (http) return http;

  throw new Error(
    "No HTTP MCP server found in .mcp.json — expected at least one entry with type=http and url"
  );
}
