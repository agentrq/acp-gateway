import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import {
  AGENT_STDERR_TAIL_LENGTH,
  announceFinished,
  announceTask,
  debug,
  describeAsk,
  followAgentStderr,
  isVerbose,
  setVerbose,
  TASK_PREVIEW_LENGTH,
} from "../log.js";

describe("log", () => {
  let errorSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setVerbose(false);
    errorSpy.mockRestore();
  });

  describe("debug", () => {
    it("is quiet by default", () => {
      expect(isVerbose()).toBe(false);
      debug("[mcp] Received channel notification");
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("prints to stderr under --verbose", () => {
      setVerbose(true);
      expect(isVerbose()).toBe(true);
      debug("[acp] Writing file:", "/tmp/x");
      expect(errorSpy).toHaveBeenCalledWith("[acp] Writing file:", "/tmp/x");
    });

    it("goes quiet again when verbose is turned off", () => {
      setVerbose(true);
      setVerbose(false);
      debug("hidden");
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("describeAsk", () => {
    it("names the task and shows what was asked", () => {
      expect(describeAsk("Fix the login bug", "abc123")).toBe(
        "[task abc123] Fix the login bug",
      );
    });

    it("works without a task id", () => {
      expect(describeAsk("Fix the login bug")).toBe("[task] Fix the login bug");
    });

    it("collapses the text onto one line", () => {
      expect(describeAsk("  First line\n\n  second\tline  ", "t1")).toBe(
        "[task t1] First line second line",
      );
    });

    it("keeps text that is exactly the preview length whole", () => {
      const text = "a".repeat(TASK_PREVIEW_LENGTH);
      expect(describeAsk(text)).toBe(`[task] ${text}`);
    });

    it("cuts long text short with an ellipsis", () => {
      const text = "b".repeat(TASK_PREVIEW_LENGTH + 50);
      const line = describeAsk(text, "t2");
      const preview = line.slice("[task t2] ".length);
      expect(preview).toHaveLength(TASK_PREVIEW_LENGTH);
      expect(preview.endsWith("…")).toBe(true);
    });
  });
});

describe("announcements", () => {
  let errorSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("announces a task even when not verbose", () => {
    announceTask("Review the PR", "t9");
    expect(errorSpy).toHaveBeenCalledWith("\n[task t9] Review the PR");
  });

  it("announces how a task finished, with or without its id", () => {
    announceFinished("t9", "end_turn");
    announceFinished(undefined, "cancelled");
    expect(errorSpy).toHaveBeenCalledWith("[task t9] Finished: end_turn");
    expect(errorSpy).toHaveBeenCalledWith("[task] Finished: cancelled");
  });
});

describe("followAgentStderr", () => {
  afterEach(() => setVerbose(false));

  it("keeps only the end of what the agent wrote", () => {
    const stream = new PassThrough();
    const tail = followAgentStderr(stream);
    stream.emit("data", Buffer.from("x".repeat(AGENT_STDERR_TAIL_LENGTH)));
    stream.emit("data", "the end");
    const kept = tail();
    expect(kept).toHaveLength(AGENT_STDERR_TAIL_LENGTH);
    expect(kept.endsWith("the end")).toBe(true);
    // Handed over once, never twice.
    expect(tail()).toBe("");
  });

  it("passes it straight through under --verbose", () => {
    setVerbose(true);
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new PassThrough();
    const tail = followAgentStderr(stream);
    stream.emit("data", "I1002 hello\n");
    expect(writeSpy).toHaveBeenCalledWith("I1002 hello\n");
    expect(tail()).toBe("");
    writeSpy.mockRestore();
  });

  it("copes with an agent that has no stderr", () => {
    expect(followAgentStderr(undefined)()).toBe("");
    expect(followAgentStderr(null)()).toBe("");
  });
});
