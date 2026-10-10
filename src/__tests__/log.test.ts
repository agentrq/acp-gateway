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
  showingAgentStderr,
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

  it("passes it straight through while a login is waiting on the agent", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new PassThrough();
    const tail = followAgentStderr(stream);
    const result = await showingAgentStderr(async () => {
      stream.emit("data", "Open the following link: https://example.test/auth\n");
      return "logged in";
    });
    expect(result).toBe("logged in");
    expect(writeSpy).toHaveBeenCalledWith("Open the following link: https://example.test/auth\n");
    expect(tail()).toBe("");

    // Back to keeping it quietly once the login is over, failed or not.
    await expect(
      showingAgentStderr(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    writeSpy.mockClear();
    stream.emit("data", "I1002 after\n");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(tail()).toBe("I1002 after\n");
    writeSpy.mockRestore();
  });

  it("hands what the agent says during a login to whoever asked to read it", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new PassThrough();
    followAgentStderr(stream);
    const read = vi.fn();
    await showingAgentStderr(async () => {
      stream.emit("data", Buffer.from("Open the following link: https://example.test/auth\n"));
    }, read);
    expect(read).toHaveBeenCalledWith("Open the following link: https://example.test/auth\n");

    // Not after the login, and not for a login that did not ask.
    read.mockClear();
    stream.emit("data", "I1002 after\n");
    await showingAgentStderr(async () => {
      stream.emit("data", "I1002 another login\n");
    });
    expect(read).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("copes with an agent that has no stderr", () => {
    expect(followAgentStderr(undefined)()).toBe("");
    expect(followAgentStderr(null)()).toBe("");
  });
});
