/**
 * toolCallPreview.ts
 *
 * Renders what a tool call is about to do, for the human being asked to
 * approve it.
 *
 * ACP already tells the client this — a permission request carries the tool's
 * kind, the files it touches, and its content, including diffs of the exact
 * edits. Forwarding only the raw input meant people were approving file edits
 * without being shown the change.
 */

import * as acp from "@agentclientprotocol/sdk";

/**
 * How much of a preview to send. A permission card is something to read at a
 * glance, and the whole payload travels through a chat message.
 */
export const MAX_PREVIEW_CHARS = 4000;

/** Lines of unchanged context kept either side of a change. */
const CONTEXT_LINES = 3;

function truncate(text: string): string {
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_PREVIEW_CHARS)}\n… truncated, ${text.length - MAX_PREVIEW_CHARS} more characters`;
}

/**
 * Renders an edit as a diff.
 *
 * The changed region is found by trimming the common prefix and suffix rather
 * than by a full longest-common-subsequence pass: it is a fraction of the code,
 * costs nothing on large files, and gives the same answer for the single-region
 * edits that make up nearly every tool call. Several scattered edits in one file
 * collapse into a single wider block — less tight, never wrong.
 */
export function renderDiff(path: string, oldText: string | null | undefined, newText: string): string {
  if (oldText == null) {
    const lines = newText.split("\n");
    return [`--- /dev/null`, `+++ ${path}`, ...lines.map((l) => `+${l}`)].join("\n");
  }

  const before = oldText.split("\n");
  const after = newText.split("\n");

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }

  if (start === before.length && before.length === after.length) {
    return `--- ${path}\n+++ ${path}\n(no change)`;
  }

  const contextStart = Math.max(0, start - CONTEXT_LINES);
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  const leading = before.slice(contextStart, start);
  const trailing = before.slice(before.length - end, before.length - end + CONTEXT_LINES);

  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...leading.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...trailing.map((l) => ` ${l}`),
  ].join("\n");
}

/** Renders one ACP content block as something readable in a chat message. */
function renderBlock(block: acp.ToolCallContent): string | undefined {
  switch (block.type) {
    case "diff":
      return renderDiff(block.path, block.oldText, block.newText);
    case "terminal":
      return `[terminal ${block.terminalId}]`;
    case "content":
      return renderContentBlock(block.content);
    default:
      return undefined;
  }
}

function renderContentBlock(content: acp.ContentBlock | undefined): string | undefined {
  if (!content) return undefined;
  switch (content.type) {
    case "text":
      return content.text;
    case "image":
      return `[image${content.mimeType ? ` ${content.mimeType}` : ""}]`;
    case "audio":
      return `[audio${content.mimeType ? ` ${content.mimeType}` : ""}]`;
    case "resource_link":
      return `[link ${content.uri}]`;
    case "resource":
      return `[resource ${(content.resource as { uri?: string })?.uri ?? ""}]`.trim();
    default:
      return undefined;
  }
}

/** What a permission card should show beyond the tool's name and raw input. */
export interface ToolCallPreview {
  /** ACP's category for the tool: read, edit, delete, execute, … */
  kind?: string;
  /** The files the call says it will touch. */
  locations?: string[];
  /** Diffs and output, rendered for reading. */
  contentPreview?: string;
}

/**
 * Pulls out everything about a tool call worth showing a human, leaving out
 * whatever the call did not supply.
 */
export function describeToolCall(toolCall: {
  kind?: string | null;
  locations?: acp.ToolCallLocation[] | null;
  content?: acp.ToolCallContent[] | null;
}): ToolCallPreview {
  const preview: ToolCallPreview = {};

  if (toolCall.kind) preview.kind = toolCall.kind;

  const locations = toolCall.locations
    ?.map((l) => (l.line ? `${l.path}:${l.line}` : l.path))
    .filter(Boolean);
  if (locations?.length) preview.locations = locations;

  const rendered = toolCall.content
    ?.map(renderBlock)
    .filter((block): block is string => Boolean(block && block.trim()));
  if (rendered?.length) preview.contentPreview = truncate(rendered.join("\n\n"));

  return preview;
}
