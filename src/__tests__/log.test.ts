import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import {
  AGENT_STDERR_TAIL_LENGTH,
  debug,
  followAgentStderr,
  isVerbose,
  setVerbose,
  showingAgentStderr,
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
