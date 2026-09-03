import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLAN_ID,
  TELEMETRY_NOTIFICATION_METHOD,
  contextPercent,
  formatPlan,
  formatUsage,
  planFromEntries,
  planTelemetryData,
  usageTelemetryData,
  type NormalizedPlan,
} from "../telemetry.js";

describe("telemetry", () => {
  it("sends on the same channel as the other gateway notifications", () => {
    expect(TELEMETRY_NOTIFICATION_METHOD).toBe(
      "notifications/claude/channel/telemetry",
    );
  });

  describe("planFromEntries", () => {
    it("gives a legacy plan update the same shape as an ID-keyed one", () => {
      const plan = planFromEntries([
        { content: "Read the config", priority: "high", status: "completed" },
      ]);
      expect(plan).toEqual({
        planId: DEFAULT_PLAN_ID,
        type: "items",
        entries: [
          { content: "Read the config", priority: "high", status: "completed" },
        ],
      });
    });
  });

  describe("formatPlan", () => {
    it("renders each entry with a marker for its status", () => {
      const plan = planFromEntries([
        { content: "Read the config", priority: "high", status: "completed" },
        { content: "Wire the channel", priority: "medium", status: "in_progress" },
        { content: "Add tests", priority: "low", status: "pending" },
      ]);
      expect(formatPlan(plan)).toBe(
        "- ✅ Read the config\n- 🔄 Wire the channel\n- ⬜ Add tests",
      );
    });

    it("falls back to the pending marker for a status it does not know", () => {
      const plan = planFromEntries([
        { content: "Something new", priority: "low", status: "blocked" as any },
      ]);
      expect(formatPlan(plan)).toBe("- ⬜ Something new");
    });

    it("renders an empty plan as empty text", () => {
      expect(formatPlan(planFromEntries([]))).toBe("");
    });

    it("renders a file-backed plan as its URI", () => {
      const plan: NormalizedPlan = {
        planId: "p1",
        type: "file",
        uri: "file:///tmp/plan.md",
      };
      expect(formatPlan(plan)).toBe("Plan: file:///tmp/plan.md");
    });

    it("passes a markdown plan through unchanged", () => {
      const plan: NormalizedPlan = {
        planId: "p1",
        type: "markdown",
        content: "## Steps\n1. Do it",
      };
      expect(formatPlan(plan)).toBe("## Steps\n1. Do it");
    });
  });

  describe("planTelemetryData", () => {
    it("keeps the fields a client renders and drops ACP's _meta", () => {
      const plan = planFromEntries([
        {
          content: "Read the config",
          priority: "high",
          status: "completed",
          _meta: { internal: true },
        },
      ]);
      expect(planTelemetryData(plan)).toEqual({
        planId: DEFAULT_PLAN_ID,
        planType: "items",
        entries: [
          { content: "Read the config", priority: "high", status: "completed" },
        ],
      });
    });

    it("carries the URI of a file-backed plan", () => {
      expect(
        planTelemetryData({
          planId: "p1",
          type: "file",
          uri: "file:///tmp/plan.md",
        }),
      ).toEqual({ planId: "p1", planType: "file", uri: "file:///tmp/plan.md" });
    });

    it("carries the body of a markdown plan", () => {
      expect(
        planTelemetryData({ planId: "p1", type: "markdown", content: "# Plan" }),
      ).toEqual({ planId: "p1", planType: "markdown", content: "# Plan" });
    });
  });

  describe("contextPercent", () => {
    it("reports how much of the context window is in use", () => {
      expect(contextPercent({ used: 50_000, size: 200_000 })).toBe(25);
    });

    it("is unknowable when the agent reports no window size", () => {
      expect(contextPercent({ used: 10, size: 0 })).toBeUndefined();
      expect(contextPercent({ used: 10, size: -1 })).toBeUndefined();
    });
  });

  describe("formatUsage", () => {
    it("renders counts with separators and a percentage", () => {
      expect(formatUsage({ used: 12_345, size: 200_000 })).toBe(
        "Context 12,345 / 200,000 tokens (6%)",
      );
    });

    it("omits the percentage when there is no window size to divide by", () => {
      expect(formatUsage({ used: 12_345, size: 0 })).toBe(
        "Context 12,345 / 0 tokens",
      );
    });

    it("appends the cost when the agent reports one", () => {
      expect(
        formatUsage({
          used: 1_000,
          size: 200_000,
          cost: { amount: 0.42, currency: "USD" },
        }),
      ).toBe("Context 1,000 / 200,000 tokens (1%) · 0.42 USD");
    });

    it("keeps sub-cent costs from rounding away to nothing", () => {
      expect(
        formatUsage({
          used: 1,
          size: 100,
          cost: { amount: 0.0023, currency: "USD" },
        }),
      ).toBe("Context 1 / 100 tokens (1%) · 0.0023 USD");
    });

    it("renders a zero cost plainly rather than at four decimals", () => {
      expect(
        formatUsage({
          used: 1,
          size: 100,
          cost: { amount: 0, currency: "EUR" },
        }),
      ).toBe("Context 1 / 100 tokens (1%) · 0.00 EUR");
    });
  });

  describe("usageTelemetryData", () => {
    it("carries the counts and the percentage", () => {
      expect(usageTelemetryData({ used: 50_000, size: 200_000 })).toEqual({
        used: 50_000,
        size: 200_000,
        percent: 25,
      });
    });

    it("omits the percentage when there is no window size", () => {
      expect(usageTelemetryData({ used: 10, size: 0 })).toEqual({
        used: 10,
        size: 0,
      });
    });

    it("keeps the cost and drops ACP's _meta", () => {
      expect(
        usageTelemetryData({
          used: 10,
          size: 100,
          cost: { amount: 1.5, currency: "USD", _meta: { internal: true } },
        }),
      ).toEqual({
        used: 10,
        size: 100,
        percent: 10,
        cost: { amount: 1.5, currency: "USD" },
      });
    });
  });
});
