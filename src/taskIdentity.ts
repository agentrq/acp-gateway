/**
 * Task identity from MCP channel `meta` for ACP session switching (agentrq `chat_id`).
 */

/** Task identity from `notifications/claude/channel` `meta` (agentrq uses `chat_id`). */
export function extractTaskIdFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  if (typeof m.chat_id === "string" && m.chat_id.length > 0) return m.chat_id;
  return undefined;
}
