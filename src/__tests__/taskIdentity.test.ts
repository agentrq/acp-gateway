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
  it("extracts from AgentRQ task push envelope [Task <id>]", () => {
    expect(extractTaskIdFromText("[Task 0k97F5bOQUb]\nDetails: do code review")).toBe("0k97F5bOQUb");
    expect(extractTaskIdFromText("[Task 0k97F5bOQUb] Fix the flake\nDetails")).toBe("0k97F5bOQUb");
  });

  it("extracts from AgentRQ reply envelope [Reply to task <id>]", () => {
    expect(extractTaskIdFromText("[Reply to task 0k97F5bOQUb] here is more info")).toBe("0k97F5bOQUb");
  });

  it("extracts from AgentRQ response envelope [Response to task <id>]", () => {
    expect(
      extractTaskIdFromText("[Response to task 0k97F5bOQUb] action=text: Please review again"),
    ).toBe("0k97F5bOQUb");
  });

  it("extracts from AgentRQ reassigned task envelope [Task reassigned to agent]", () => {
    expect(extractTaskIdFromText("[Task reassigned to agent] 0k97F5bOQUb")).toBe("0k97F5bOQUb");
  });

  it("extracts from AgentRQ hourly status check message", () => {
    expect(
      extractTaskIdFromText(
        "Status Check: You are currently working on task 0k97F5bOQUb. Please provide a brief status update",
      ),
    ).toBe("0k97F5bOQUb");
  });

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
