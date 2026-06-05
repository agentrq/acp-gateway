import { describe, expect, it } from "vitest";
import {
  extractTaskIdFromMeta,
  extractTaskIdFromText,
} from "../taskIdentity.js";

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

describe("extractTaskIdFromText", () => {
  it("extracts from Task ID", () => {
    expect(extractTaskIdFromText("Task ID: 0amnlepEi1J")).toBe("0amnlepEi1J");
    expect(extractTaskIdFromText("task ID 0amnlepEi1J")).toBe("0amnlepEi1J");
    expect(extractTaskIdFromText("TASK ID: abc-123")).toBe("abc-123");
  });

  it("extracts from Response to task", () => {
    expect(extractTaskIdFromText("Response to task 0amnlepEi1J")).toBe(
      "0amnlepEi1J"
    );
    expect(extractTaskIdFromText("response to task: xyz_789")).toBe("xyz_789");
  });

  it("extracts from task keyword", () => {
    expect(extractTaskIdFromText("task 0amnlepEi1J")).toBe("0amnlepEi1J");
    expect(extractTaskIdFromText("Working on task abc")).toBe("abc");
  });

  it("extracts from ID: keyword and handles Next assigned task format", () => {
    expect(extractTaskIdFromText("Next assigned task:\nID: 0aleR6CbZBp\nTitle: Some Title")).toBe("0aleR6CbZBp");
    expect(extractTaskIdFromText("ID: 12345")).toBe("12345");
  });

  it("extracts from chat_id keyword", () => {
    expect(extractTaskIdFromText('<channel source="agentrq" chat_id="0aleR6CbZBp">')).toBe("0aleR6CbZBp");
    expect(extractTaskIdFromText('chat_id: "0aleR6CbZBp"')).toBe("0aleR6CbZBp");
    expect(extractTaskIdFromText("chat_id 0aleR6CbZBp")).toBe("0aleR6CbZBp");
  });

  it("returns undefined if no match", () => {
    expect(extractTaskIdFromText("Hello world")).toBeUndefined();
    expect(extractTaskIdFromText("")).toBeUndefined();
  });
});
