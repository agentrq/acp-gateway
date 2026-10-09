import { describe, it, expect } from "vitest";
import { BoundedMap, FifoQueue } from "../collections.js";

describe("BoundedMap", () => {
  it("rejects a capacity that could hold nothing", () => {
    expect(() => new BoundedMap(0)).toThrow(RangeError);
    expect(() => new BoundedMap(1.5)).toThrow(RangeError);
  });

  it("evicts the least recently written entry once full", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1).set("b", 2).set("c", 3);
    expect([...map.keys()]).toEqual(["b", "c"]);
  });

  it("treats rewriting a key as fresh use", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1).set("b", 2).set("a", 10).set("c", 3);
    expect([...map.entries()]).toEqual([
      ["a", 10],
      ["c", 3],
    ]);
  });

  it("does not count reads as use", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1).set("b", 2);
    map.get("a");
    map.set("c", 3);
    expect(map.has("a")).toBe(false);
  });

  it("keeps the rest of the Map interface", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    expect(map).toBeInstanceOf(Map);
    expect(map.delete("a")).toBe(true);
    expect(map.size).toBe(0);
  });
});

describe("FifoQueue", () => {
  it("returns undefined when empty", () => {
    const queue = new FifoQueue<number>();
    expect(queue.length).toBe(0);
    expect(queue.shift()).toBeUndefined();
  });

  it("hands items back in the order they arrived, across compactions", () => {
    const queue = new FifoQueue<number>();
    const out: number[] = [];
    for (let i = 0; i < 10; i++) queue.push(i);
    for (let i = 0; i < 7; i++) out.push(queue.shift()!);
    expect(queue.length).toBe(3);
    for (let i = 10; i < 15; i++) queue.push(i);
    while (queue.length > 0) out.push(queue.shift()!);
    expect(out).toEqual(Array.from({ length: 15 }, (_, i) => i));
    expect(queue.shift()).toBeUndefined();
  });

  it("is reusable after being drained", () => {
    const queue = new FifoQueue<string>();
    queue.push("a");
    expect(queue.shift()).toBe("a");
    queue.push("b");
    expect(queue.length).toBe(1);
    expect(queue.shift()).toBe("b");
  });

  it("drains a large backlog in order", () => {
    const queue = new FifoQueue<number>();
    const n = 200_000;
    for (let i = 0; i < n; i++) queue.push(i);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += queue.shift()!;
    expect(sum).toBe((n * (n - 1)) / 2);
  });
});
