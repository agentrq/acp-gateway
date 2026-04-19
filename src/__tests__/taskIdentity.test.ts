import { describe, expect, it } from "vitest";
import { extractTaskIdFromMeta } from "../taskIdentity.js";

describe("extractTaskIdFromMeta", () => {
  it("returns undefined for non-objects", () => {
    expect(extractTaskIdFromMeta(undefined)).toBeUndefined();
    expect(extractTaskIdFromMeta(null)).toBeUndefined();
    expect(extractTaskIdFromMeta("x")).toBeUndefined();
  });

  it("reads only chat_id", () => {
    expect(extractTaskIdFromMeta({ chat_id: "chat-1" })).toBe("chat-1");
    expect(extractTaskIdFromMeta({ taskId: "a" })).toBeUndefined();
    expect(extractTaskIdFromMeta({ task_id: "b" })).toBeUndefined();
    expect(extractTaskIdFromMeta({ id: "c" })).toBeUndefined();
  });

  it("ignores empty chat_id", () => {
    expect(extractTaskIdFromMeta({ chat_id: "" })).toBeUndefined();
  });
});
