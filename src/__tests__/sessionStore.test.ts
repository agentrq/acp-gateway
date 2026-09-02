import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore, sessionStorePath } from "../sessionStore.js";

describe("sessionStorePath", () => {
  it("should keep different agents apart in the same workspace", () => {
    const gemini = sessionStorePath("gemini --acp", "https://ws.example", "/cache");
    const codex = sessionStorePath("codex --acp", "https://ws.example", "/cache");

    // A session id only means something to the agent that issued it.
    expect(gemini).not.toBe(codex);
  });

  it("should keep the same agent's workspaces apart", () => {
    expect(sessionStorePath("gemini", "https://a.example", "/cache")).not.toBe(
      sessionStorePath("gemini", "https://b.example", "/cache"),
    );
  });

  it("should be stable for the same agent and workspace", () => {
    expect(sessionStorePath("gemini", "https://a.example", "/cache")).toBe(
      sessionStorePath("gemini", "https://a.example", "/cache"),
    );
  });

  it("should put the file somewhere it belongs", () => {
    const file = sessionStorePath("gemini", "https://a.example", "/cache");

    expect(path.dirname(file)).toBe(path.join("/cache", "sessions"));
    expect(file.endsWith(".json")).toBe(true);
  });
});

describe("SessionStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "acp-sessions-"));
    file = path.join(dir, "nested", "sessions.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("should remember a session across instances", () => {
    new SessionStore(file).set("task-1", "sess-1");

    expect(new SessionStore(file).get("task-1")).toBe("sess-1");
  });

  it("should know nothing before anything has been stored", () => {
    expect(new SessionStore(file).get("task-1")).toBeUndefined();
  });

  it("should forget a session on request", () => {
    const store = new SessionStore(file);
    store.set("task-1", "sess-1");

    store.delete("task-1");

    expect(store.get("task-1")).toBeUndefined();
    expect(new SessionStore(file).get("task-1")).toBeUndefined();
  });

  it("should not rewrite the file for a session it already knows", () => {
    const store = new SessionStore(file);
    store.set("task-1", "sess-1");
    const before = readFileSync(file, "utf-8");

    store.set("task-1", "sess-1");
    store.delete("task-2");

    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("should start clean when the file cannot be understood", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ not json");

    // Losing this costs context on the next restart; refusing to start would
    // cost every task.
    expect(() => new SessionStore(file).get("task-1")).not.toThrow();
  });

  it("should carry on when the file cannot be written", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A path under a regular file can never be created.
    const blocked = path.join(dir, "blocker");
    writeFileSync(blocked, "");
    const store = new SessionStore(path.join(blocked, "sessions.json"));

    expect(() => store.set("task-1", "sess-1")).not.toThrow();
    expect(store.get("task-1")).toBe("sess-1");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
