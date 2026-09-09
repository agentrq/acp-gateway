import { describe, it, expect } from "vitest";
import {
  COMMANDS_NOTIFICATION_METHOD,
  normalizeCommands,
} from "../commands.js";

describe("normalizeCommands", () => {
  it("keeps the name, description and input hint of a full command", () => {
    const commands = normalizeCommands([
      {
        name: "web",
        description: "Search the web for information",
        input: { hint: "query to search for" },
      },
    ] as any);

    expect(commands).toEqual([
      {
        name: "web",
        description: "Search the web for information",
        hint: "query to search for",
      },
    ]);
  });

  it("omits the hint for a command that takes no argument", () => {
    const [command] = normalizeCommands([
      { name: "test", description: "Run tests for the current project" },
    ] as any);

    expect(command).toEqual({
      name: "test",
      description: "Run tests for the current project",
    });
    expect("hint" in command).toBe(false);
  });

  it("trims the surrounding whitespace an agent may send", () => {
    expect(
      normalizeCommands([
        { name: "  compact  ", description: "  Shorten the context  ", input: { hint: "  focus  " } },
      ] as any),
    ).toEqual([{ name: "compact", description: "Shorten the context", hint: "focus" }]);
  });

  it("drops an entry with no usable name, since nothing could invoke it", () => {
    expect(
      normalizeCommands([
        { name: "", description: "no name" },
        { name: "   ", description: "only spaces" },
        { description: "name missing entirely" },
        { name: 42, description: "name is not a string" },
        { name: "keep", description: "the only real one" },
      ] as any),
    ).toEqual([{ name: "keep", description: "the only real one" }]);
  });

  it("keeps a command whose description is missing or blank", () => {
    // The name is what gets invoked; a description is the agent's courtesy.
    expect(
      normalizeCommands([
        { name: "init" },
        { name: "review", description: "   " },
      ] as any),
    ).toEqual([
      { name: "init", description: "" },
      { name: "review", description: "" },
    ]);
  });

  it("ignores a hint that is missing, blank or not a string", () => {
    expect(
      normalizeCommands([
        { name: "a", description: "d", input: null },
        { name: "b", description: "d", input: {} },
        { name: "c", description: "d", input: { hint: "  " } },
        { name: "d", description: "d", input: { hint: 7 } },
      ] as any),
    ).toEqual([
      { name: "a", description: "d" },
      { name: "b", description: "d" },
      { name: "c", description: "d" },
      { name: "d", description: "d" },
    ]);
  });

  it("collapses a repeated name to the last one, because the new list supersedes", () => {
    expect(
      normalizeCommands([
        { name: "plan", description: "the old wording" },
        { name: "other", description: "unrelated" },
        { name: "plan", description: "the revised wording" },
      ] as any),
    ).toEqual([
      { name: "plan", description: "the revised wording" },
      { name: "other", description: "unrelated" },
    ]);
  });

  it("skips entries that are not objects at all", () => {
    expect(
      normalizeCommands([null, undefined, "compact", 3, { name: "real", description: "d" }] as any),
    ).toEqual([{ name: "real", description: "d" }]);
  });

  it("returns an empty list for an empty, missing or non-array payload", () => {
    // Empty is meaningful — it is how an agent withdraws its commands — and it
    // must not be confused with an error.
    expect(normalizeCommands([])).toEqual([]);
    expect(normalizeCommands(undefined)).toEqual([]);
    expect(normalizeCommands(null)).toEqual([]);
    expect(normalizeCommands({ name: "not an array" } as any)).toEqual([]);
  });

  it("publishes the channel the workspace listens on", () => {
    expect(COMMANDS_NOTIFICATION_METHOD).toBe(
      "notifications/claude/channel/commands",
    );
  });
});
