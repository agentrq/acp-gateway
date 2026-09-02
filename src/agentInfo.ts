/**
 * agentInfo.ts
 *
 * Renders what an agent said about itself during `initialize`.
 *
 * An agent's capabilities are only knowable from a live handshake — nothing in
 * the registry lists them — so the answer to "can this agent resume a session?"
 * or "will it accept an HTTP MCP server?" is otherwise a guess.
 */

import * as acp from "@agentclientprotocol/sdk";
import { describeAuthMethods } from "./auth.js";

/** ACP marks an optional capability as supported by supplying `{}` for it. */
function supported(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function yesNo(value: unknown): string {
  return supported(value) ? "yes" : "no";
}

function section(title: string, rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  const body = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
  return [title, ...body].join("\n");
}

/** The agent's own name for itself, falling back to how it was launched. */
function heading(
  initResult: acp.InitializeResponse,
  launchedAs: string,
): string {
  const info = (initResult as { agentInfo?: { name?: string; title?: string; version?: string } })
    .agentInfo;
  if (!info?.name) return launchedAs;

  const title = info.title && info.title !== info.name ? ` — ${info.title}` : "";
  const version = info.version ? ` ${info.version}` : "";
  return `${info.name}${title}${version}`;
}

/**
 * Describes an agent's capabilities as the agent itself reported them.
 *
 * `launchedAs` is only used when the agent supplies no `agentInfo`, so that the
 * output still says which agent is being described.
 */
export function describeAgentInfo(
  initResult: acp.InitializeResponse,
  launchedAs: string,
): string {
  const caps = (initResult.agentCapabilities ?? {}) as acp.AgentCapabilities & {
    sessionCapabilities?: Record<string, unknown>;
  };
  const sessions = caps.sessionCapabilities ?? {};
  const prompt = caps.promptCapabilities ?? {};
  const mcp = caps.mcpCapabilities ?? {};

  const blocks = [
    `${heading(initResult, launchedAs)}\nACP protocol version ${initResult.protocolVersion}`,

    section("SESSIONS", [
      ["session/load", yesNo(caps.loadSession)],
      ["session/list", yesNo(sessions.list)],
      ["session/resume", yesNo(sessions.resume)],
      ["session/close", yesNo(sessions.close)],
      ["session/delete", yesNo(sessions.delete)],
      ["session/fork", yesNo(sessions.fork)],
    ]),

    section("PROMPT CONTENT", [
      ["image", yesNo(prompt.image)],
      ["audio", yesNo(prompt.audio)],
      ["embedded context", yesNo(prompt.embeddedContext)],
    ]),

    section("MCP TRANSPORTS", [
      ["http", yesNo(mcp.http)],
      ["sse", yesNo(mcp.sse)],
      ["acp", yesNo((mcp as { acp?: unknown }).acp)],
    ]),

    section("AUTHENTICATION", [["logout", yesNo(caps.auth?.logout)]]) +
      `\n\n  Login methods:\n${describeAuthMethods(initResult.authMethods)}`,
  ];

  return blocks.join("\n\n");
}
