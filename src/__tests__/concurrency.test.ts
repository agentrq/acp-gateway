import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_MAX_CONCURRENCY,
  MIN_MAX_CONCURRENCY,
  normalizeConcurrency,
} from "../concurrency.js";

describe("concurrency", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe("normalizeConcurrency", () => {
    it("takes a number the workspace could plausibly ask for", () => {
      expect(normalizeConcurrency(1)).toBe(1);
      expect(normalizeConcurrency(4)).toBe(4);
      expect(normalizeConcurrency(MAX_MAX_CONCURRENCY)).toBe(MAX_MAX_CONCURRENCY);
    });

    it("reads a number sent as a string, since this arrives as JSON from elsewhere", () => {
      expect(normalizeConcurrency("4")).toBe(4);
      expect(normalizeConcurrency("  8  ")).toBe(8);
    });

    it("truncates a fraction rather than rounding past what was asked for", () => {
      expect(normalizeConcurrency(4.9)).toBe(4);
      expect(normalizeConcurrency("2.5")).toBe(2);
    });

    it("clamps below the floor, so no value can stall the queue completely", () => {
      expect(normalizeConcurrency(0)).toBe(MIN_MAX_CONCURRENCY);
      expect(normalizeConcurrency(-7)).toBe(MIN_MAX_CONCURRENCY);
      expect(normalizeConcurrency(0.4)).toBe(MIN_MAX_CONCURRENCY);
    });

    it("clamps above the ceiling, so a mistyped limit cannot fork the machine", () => {
      expect(normalizeConcurrency(10_000)).toBe(MAX_MAX_CONCURRENCY);
      expect(normalizeConcurrency(MAX_MAX_CONCURRENCY + 1)).toBe(MAX_MAX_CONCURRENCY);
    });

    it("refuses anything that is not a number of tasks", () => {
      expect(normalizeConcurrency(undefined)).toBeUndefined();
      expect(normalizeConcurrency(null)).toBeUndefined();
      expect(normalizeConcurrency("many")).toBeUndefined();
      expect(normalizeConcurrency("")).toBeUndefined();
      expect(normalizeConcurrency(NaN)).toBeUndefined();
      expect(normalizeConcurrency(Infinity)).toBeUndefined();
      expect(normalizeConcurrency({})).toBeUndefined();
      expect(normalizeConcurrency(true)).toBeUndefined();
    });
  });
});
