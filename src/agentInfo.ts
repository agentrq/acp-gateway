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

/** The notification agentrq listens on for which agent is behind the gateway. */
export const AGENT_NOTIFICATION_METHOD = "notifications/claude/channel/agent";

/**
 * The wire shape agentrq receives. snake_case to match the telemetry, models
 * and commands notifications on the same channel; the REST surface that
 * eventually renders this is camelCase, and the mapping happens there.
 */
export interface AgentPayload {
  task_id: string;
  session_id: string;
  name: string;
  title?: string;
  version?: string;
}

/**
 * Sends an agent's identity to the workspace.
 *
 * No task is required. The workspace keys this to the MCP connection it arrived
 * on and ignores the task and session ids entirely, so demanding one would only
 * guarantee silence at the moment it matters most — before any task has run,
 * which is exactly when someone is looking at the workspace wondering what is
 * attached to it.
 *
 * Never throws: this is a label for a human, and a workspace that cannot take
 * it right now must not cost the agent anything.
 */
export async function sendAgentIdentity(
  bridge: { sendNotification(method: string, params: unknown): Promise<unknown> },
  identity: AgentIdentity,
  scope: { taskId?: string; sessionId?: string } = {},
): Promise<void> {
  const payload: AgentPayload = {
    task_id: scope.taskId ?? "",
    session_id: scope.sessionId ?? "",
    name: identity.name,
    title: identity.title,
    version: identity.version,
  };
  try {
    await bridge.sendNotification(AGENT_NOTIFICATION_METHOD, payload);
    console.error(`[acp] Told the workspace it is talking to "${identity.name}"`);
  } catch (err) {
    console.error(`[acp] Failed to send agent notification:`, err);
  }
}

/** Who an agent says it is. */
export interface AgentIdentity {
  /** The agent's own name for itself, or how it was launched if it gave none. */
  name: string;
  /** A longer human-readable name, when it differs from the short one. */
  title?: string;
  version?: string;
}

/**
 * Who the agent is, from its `initialize` response.
 *
 * ACP leaves `agentInfo` optional, so an agent that says nothing about itself
 * is named by how it was launched instead. That is the only name available and
 * it is better than none — the workspace's "which agent is this" is otherwise
 * unanswerable.
 *
 * `title` is dropped when it merely repeats the name, so a caller rendering
 * both does not print the same word twice.
 */
export function agentIdentity(
  initResult: acp.InitializeResponse,
  launchedAs: string,
): AgentIdentity {
  const info = (initResult as { agentInfo?: { name?: string; title?: string; version?: string } })
    .agentInfo;

  const name = info?.name?.trim();
  if (!name) return { name: launchedAs };

  const identity: AgentIdentity = { name };
  const title = info?.title?.trim();
  if (title && title !== name) identity.title = title;
  const version = info?.version?.trim();
  if (version) identity.version = version;
  return identity;
}

/** The agent's own name for itself, falling back to how it was launched. */
function heading(
  initResult: acp.InitializeResponse,
  launchedAs: string,
): string {
  const { name, title, version } = agentIdentity(initResult, launchedAs);
  return `${name}${title ? ` — ${title}` : ""}${version ? ` ${version}` : ""}`;
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
