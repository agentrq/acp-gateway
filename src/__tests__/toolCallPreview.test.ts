import { describe, it, expect } from "vitest";
import { describeToolCall, renderDiff, MAX_PREVIEW_CHARS } from "../toolCallPreview.js";

describe("renderDiff", () => {
  it("should show a new file as all additions", () => {
    const diff = renderDiff("/tmp/new.ts", null, "one\ntwo");

    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ /tmp/new.ts");
    expect(diff).toContain("+one");
    expect(diff).toContain("+two");
  });

  it("should show only the part of a file that changes", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "CHANGED", "f", "g", "h"].join("\n");

    const diff = renderDiff("/tmp/f.ts", before, after);

    expect(diff).toContain("-e");
    expect(diff).toContain("+CHANGED");
    // Unchanged lines outside the context window stay out of it.
    expect(diff).not.toContain(" a");
    expect(diff).toContain(" d");
  });

  it("should show an insertion with nothing removed", () => {
    const diff = renderDiff("/tmp/f.ts", "a\nb", "a\nnew\nb");

    expect(diff).toContain("+new");
    expect(diff.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(1); // the --- header
  });

  it("should say so when the texts are identical", () => {
    expect(renderDiff("/tmp/f.ts", "same", "same")).toContain("(no change)");
  });

  it("should count the changed lines in the hunk header", () => {
    const diff = renderDiff("/tmp/f.ts", "a\nb\nc", "a\nx\ny\nc");

    expect(diff).toContain("@@ -2,1 +2,2 @@");
  });
});

describe("describeToolCall", () => {
  it("should leave out everything the call did not supply", () => {
    expect(describeToolCall({})).toEqual({});
    expect(describeToolCall({ kind: null, locations: null, content: null })).toEqual({});
    expect(describeToolCall({ locations: [], content: [] })).toEqual({});
  });

  it("should report the tool's kind and the files it touches", () => {
    const preview = describeToolCall({
      kind: "edit",
      locations: [{ path: "/src/a.ts" }, { path: "/src/b.ts", line: 42 }] as any,
    });

    expect(preview.kind).toBe("edit");
    expect(preview.locations).toEqual(["/src/a.ts", "/src/b.ts:42"]);
  });

  it("should render the diff a human is being asked to approve", () => {
    const preview = describeToolCall({
      content: [
        { type: "diff", path: "/src/a.ts", oldText: "old", newText: "new" },
      ] as any,
    });

    expect(preview.contentPreview).toContain("-old");
    expect(preview.contentPreview).toContain("+new");
  });

  it("should render text, media and links without dropping them", () => {
    const preview = describeToolCall({
      content: [
        { type: "content", content: { type: "text", text: "about to run" } },
        { type: "content", content: { type: "image", mimeType: "image/png", data: "x" } },
        { type: "content", content: { type: "resource_link", uri: "file:///a" } },
        { type: "content", content: { type: "audio", mimeType: "audio/wav", data: "x" } },
        { type: "content", content: { type: "resource", resource: { uri: "file:///b" } } },
        { type: "terminal", terminalId: "term-1" },
      ] as any,
    });

    expect(preview.contentPreview).toContain("about to run");
    expect(preview.contentPreview).toContain("[image image/png]");
    expect(preview.contentPreview).toContain("[link file:///a]");
    expect(preview.contentPreview).toContain("[audio audio/wav]");
    expect(preview.contentPreview).toContain("[resource file:///b]");
    expect(preview.contentPreview).toContain("[terminal term-1]");
  });

  it("should skip blocks it has no rendering for", () => {
    const preview = describeToolCall({
      content: [
        { type: "something-new" },
        { type: "content", content: { type: "unknown-kind" } },
        { type: "content", content: { type: "text", text: "   " } },
      ] as any,
    });

    expect(preview.contentPreview).toBeUndefined();
  });

  it("should cap a preview so one edit cannot flood the chat", () => {
    const huge = "x".repeat(MAX_PREVIEW_CHARS * 2);
    const preview = describeToolCall({
      content: [{ type: "content", content: { type: "text", text: huge } }] as any,
    });

    expect(preview.contentPreview!.length).toBeLessThan(MAX_PREVIEW_CHARS + 100);
    expect(preview.contentPreview).toContain("truncated");
  });
});
