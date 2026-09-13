import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CONCURRENCY_NOTIFICATION_METHOD,
  MAX_MAX_CONCURRENCY,
  MIN_MAX_CONCURRENCY,
  SET_CONCURRENCY_NOTIFICATION_METHOD,
  normalizeConcurrency,
  sendConcurrencyNotification,
} from "../concurrency.js";

describe("concurrency", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe("notification methods", () => {
    it("sits on the same channel as the rest of the workspace directives", () => {
      expect(SET_CONCURRENCY_NOTIFICATION_METHOD).toBe(
        "notifications/claude/channel/set_concurrency",
      );
      expect(CONCURRENCY_NOTIFICATION_METHOD).toBe(
        "notifications/claude/channel/concurrency",
      );
    });
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

  describe("sendConcurrencyNotification", () => {
    it("reports the limit, the queue under it, and the range on offer", async () => {
      const bridge = { sendNotification: vi.fn().mockResolvedValue(undefined) };

      await sendConcurrencyNotification(bridge, {
        maxConcurrency: 4,
        active: 2,
        queued: 3,
      });

      expect(bridge.sendNotification).toHaveBeenCalledWith(
        CONCURRENCY_NOTIFICATION_METHOD,
        expect.objectContaining({
          maxConcurrency: 4,
          active: 2,
          queued: 3,
          min: MIN_MAX_CONCURRENCY,
          max: MAX_MAX_CONCURRENCY,
        }),
      );
    });

    it("spells every field one way, with no snake_case twin to keep in step", async () => {
      const bridge = { sendNotification: vi.fn().mockResolvedValue(undefined) };

      await sendConcurrencyNotification(bridge, {
        maxConcurrency: 4,
        active: 0,
        queued: 0,
      });

      expect(Object.keys(bridge.sendNotification.mock.calls[0][1]).sort()).toEqual([
        "active",
        "canSet",
        "max",
        "maxConcurrency",
        "min",
        "queued",
        "sessionId",
        "taskId",
      ]);
    });

    it("declares that it will act on being told to change, so old gateways stay read-only", async () => {
      const bridge = { sendNotification: vi.fn().mockResolvedValue(undefined) };

      await sendConcurrencyNotification(bridge, {
        maxConcurrency: 1,
        active: 0,
        queued: 0,
      });

      expect(bridge.sendNotification.mock.calls[0][1]).toMatchObject({ canSet: true });
    });

    it("sends empty task and session ids, which the workspace ignores", async () => {
      const bridge = { sendNotification: vi.fn().mockResolvedValue(undefined) };

      await sendConcurrencyNotification(bridge, {
        maxConcurrency: 2,
        active: 0,
        queued: 0,
      });

      expect(bridge.sendNotification.mock.calls[0][1]).toMatchObject({
        taskId: "",
        sessionId: "",
      });
    });

    it("never throws when the workspace cannot take the update", async () => {
      const bridge = {
        sendNotification: vi.fn().mockRejectedValue(new Error("socket closed")),
      };

      await expect(
        sendConcurrencyNotification(bridge, {
          maxConcurrency: 2,
          active: 1,
          queued: 0,
        }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        "[bridge] Failed to send concurrency notification:",
        expect.any(Error),
      );
    });
  });
});
