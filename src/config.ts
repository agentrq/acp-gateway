/**
 * config.ts
 *
 * Reads the MCP server definitions the gateway hands to its agent, and picks
 * the agentrq workspace out of them.
 *
 * They normally come from a .mcp.json found by searching upwards from the
 * working directory. `--mcp-json` names one outright, wherever it lives and
 * whatever it is called, for the gateway that is run from somewhere other than
 * the workspace it belongs to.
 */

import { readFileSync, statSync } from "node:fs";
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
 * Collects the MCP servers the gateway will offer its agent.
 *
 * A file named by `--mcp-json` and the one found by searching upwards are both
 * read, and their servers merged — the flag adds a workspace rather than hiding
 * whatever is in the directory. Where both define a server under one name, the
 * named file wins: it was pointed at deliberately, and the other was merely
 * nearby. That ordering decides `pickAgentrqServer`'s fallback as well, so the
 * file someone named is the workspace the gateway connects to.
 */
export function loadMcpConfig(
  startDir: string = process.cwd(),
  givenPath?: string,
): McpServerConfig[] {
  const given = givenPath === undefined ? [] : loadGivenMcpJson(givenPath);
  const found = searchForMcpJson(startDir);

  const names = new Set(given.map((server) => server.name));
  const servers = [...given, ...found.filter((server) => !names.has(server.name))];
  if (servers.length > 0) return servers;

  // Reached only when nothing anywhere defined a server: an empty file that was
  // named is reported as such below, before ever getting here.
  throw new Error(
    "Could not find .mcp.json — run acp-gateway from your workspace root, " +
      "or name a config with --mcp-json <path>",
  );
}

/**
 * Reads the config someone named, and refuses to carry on without it.
 *
 * Nothing here falls back to the directory search. A mistyped path that quietly
 * became "whatever .mcp.json is lying around" would not look like a failure —
 * it would look like it worked, while connecting the agent to the wrong
 * workspace, which is the one outcome worth being loud about.
 */
function loadGivenMcpJson(givenPath: string): McpServerConfig[] {
  const path = resolveGivenPath(givenPath);

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read the MCP config at ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: McpJson;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Named separately from the read: "the file is not there" and "the file is
    // not JSON" send someone to two different places.
    //
    // Read as an Error without checking, unlike the read above: JSON.parse
    // throws a SyntaxError and nothing else, so a fallback for other throwables
    // would be a branch that cannot be reached and so cannot be tested.
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  const servers = toServers(parsed, path);
  if (servers.length === 0) {
    // Distinguished from "found nothing anywhere", because the answer is
    // different: the file is right there, and it is empty.
    throw new Error(`${path} defines no MCP servers under "mcpServers".`);
  }
  console.error(`[config] Loaded MCP config from ${path}`);
  return servers;
}

/**
 * What `--mcp-json` actually points at.
 *
 * The name is a convention, not a requirement — the flag takes a path to a
 * file, whatever it is called. A directory is taken to mean the .mcp.json
 * inside it, since handing a flag the folder instead of the file is an easy
 * slip and a pointless way to fail.
 */
function resolveGivenPath(givenPath: string): string {
  const path = resolve(givenPath);
  try {
    if (statSync(path).isDirectory()) return resolve(path, ".mcp.json");
  } catch {
    // Nothing there at all. Let the read fail, so the message names the path as
    // it was given rather than one this guessed at.
  }
  return path;
}

/**
 * Looks for a .mcp.json beside the gateway, and up to three directories above.
 *
 * Returns nothing at all when there is none. That is not an error on its own
 * any more: `--mcp-json` may have supplied the whole answer.
 */
function searchForMcpJson(startDir: string): McpServerConfig[] {
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

    const servers = toServers(parsed, candidate);
    if (servers.length > 0) {
      console.error(`[config] Loaded .mcp.json from ${candidate}`);
      return servers;
    }
  }

  return [];
}

/**
 * Turns one parsed config into servers, and refuses the ones no agent could
 * use. `source` names the file in anything it complains about — which matters
 * more now that the file is not necessarily called .mcp.json.
 */
function toServers(parsed: McpJson, source: string): McpServerConfig[] {
  const servers: McpServerConfig[] = Object.entries(parsed.mcpServers ?? {}).map(
    ([name, cfg]) => ({
      name,
      type: readTransport(name, cfg.type, cfg.url, source),
      url: cfg.url,
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
      headers: cfg.headers,
    }),
  );
  servers.forEach((server) => assertUsable(server, source));
  return servers;
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
  source: string,
): McpTransport {
  if (type === undefined) return url ? "http" : "stdio";
  if ((MCP_TRANSPORTS as readonly string[]).includes(type)) return type as McpTransport;
  throw new Error(
    `MCP server "${name}" in ${source} has transport "${type}", which this gateway ` +
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
function assertUsable(server: McpServerConfig, source: string): void {
  const missing = server.type === "stdio" ? !server.command : !server.url;
  if (!missing) return;

  const field = server.type === "stdio" ? "command" : "url";
  throw new Error(
    `MCP server "${server.name}" in ${source} is ${server.type} but has no ${field}.`,
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
