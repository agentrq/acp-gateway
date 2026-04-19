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

/** Try to extract taskId from text content as a fallback. */
export function extractTaskIdFromText(text: string): string | undefined {
  // Try to match "Task ID: <id>" or "Response to task <id>" or just "task <id>"
  const patterns = [
    /Task ID[:\s]+([a-zA-Z0-9_-]+)/i,
    /Response to task[:\s]+([a-zA-Z0-9_-]+)/i,
    /task[:\s]+([a-zA-Z0-9_-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }
  return undefined;
}
