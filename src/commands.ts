/**
 * commands.ts
 *
 * Normalises the slash commands an ACP agent advertises into the shape agentrq
 * stores and offers in its composer.
 *
 * Agents announce them with the `available_commands_update` session
 * notification, at any point in a session and as often as they like — commands
 * appear as context makes them relevant and disappear when it does not. The
 * gateway used to drop the notification entirely, so a workspace never learned
 * that `/init`, `/compact` or `/review` existed.
 */

import type * as acp from "@agentclientprotocol/sdk";

/** The notification agentrq listens on for the agent's slash commands. */
export const COMMANDS_NOTIFICATION_METHOD =
  "notifications/claude/channel/commands";

/** One command the connected agent offers. */
export interface AgentCommand {
  /** Invoked as `/<name>` at the start of a prompt. */
  name: string;
  /** Human-readable description of what it does. */
  description: string;
  /** What to show where the command's argument goes, when it takes one. */
  hint?: string;
}

/**
 * The wire shape agentrq receives. Keys are snake_case to match the sibling
 * telemetry and permission notifications on the same channel; the REST surface
 * that eventually renders these is camelCase, and the mapping happens there.
 */
export interface CommandsPayload {
  task_id: string;
  session_id: string;
  commands: AgentCommand[];
}

/**
 * Turns an `available_commands_update` payload into the commands worth
 * offering.
 *
 * An entry with no usable name is dropped rather than repaired: the name is
 * what the human types and what the agent matches on, so a nameless command is
 * one nothing could ever invoke.
 *
 * Repeated names collapse to the last one, because a re-advertised list
 * supersedes what came before — an agent revising a description mid-session
 * means the new text, not two entries that shadow each other in whatever order
 * the menu happens to render.
 *
 * An empty result is meaningful and is returned as such. It is how an agent
 * says it has withdrawn its commands, and the workspace has to be able to take
 * the menu away again.
 */
export function normalizeCommands(
  commands?: readonly acp.AvailableCommand[] | null,
): AgentCommand[] {
  if (!Array.isArray(commands)) return [];

  const byName = new Map<string, AgentCommand>();
  for (const command of commands) {
    if (!command || typeof command !== "object") continue;

    const name = trimmed(command.name);
    if (!name) continue;

    const entry: AgentCommand = {
      name,
      description: trimmed(command.description) ?? "",
    };
    const hint = trimmed(command.input?.hint);
    if (hint) entry.hint = hint;

    byName.set(name, entry);
  }

  return [...byName.values()];
}

/** The value as a trimmed string, or undefined when there is nothing left. */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}
