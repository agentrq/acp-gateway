/**
 * Task identity from MCP channel `meta` for ACP session switching (agentrq `chat_id`).
 */

/**
 * Patterns used to extract taskId from text content.
 *
 * Ordered from most specific agentrq channel notification envelope
 * ([Task ...], [Reply to task ...], [Response to task ...], [Task reassigned to agent] ...)
 * to generic task/ID patterns.
 */
const TASK_ID_PATTERNS: readonly RegExp[] = [
  /\[Task\s+([a-zA-Z0-9_-]+)\]/i,
  /\[Reply to task\s+([a-zA-Z0-9_-]+)\]/i,
  /\[Response to task\s+([a-zA-Z0-9_-]+)\]/i,
  /\[Task reassigned to agent\]\s+([a-zA-Z0-9_-]+)/i,
  /Task ID[: \t]+([a-zA-Z0-9_-]+)/i,
  /Response to task[: \t]+([a-zA-Z0-9_-]+)/i,
  /working on task\s+([a-zA-Z0-9_-]+)/i,
  /\bID[: \t]+([a-zA-Z0-9_-]+)/,
  /\bchat_id[":=\s]+([a-zA-Z0-9_-]+)/i,
  /task[: \t]+([a-zA-Z0-9_-]+)/i,
];

/** Task identity from `notifications/claude/channel` `meta` (agentrq uses `chat_id`). */
export function extractTaskIdFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  if (typeof m.chat_id === "string" && m.chat_id.length > 0) return m.chat_id;
  return undefined;
}

/** Try to extract taskId from text content as a fallback. */
export function extractTaskIdFromText(text: string): string | undefined {
  for (const pattern of TASK_ID_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }
  return undefined;
}
