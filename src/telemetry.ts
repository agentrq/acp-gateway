/**
 * telemetry.ts
 *
 * Renders the ACP session updates that carry no answer — the agent's
 * reasoning, its execution plan, its token and cost counters — into something
 * a human reading the workspace can act on.
 *
 * These updates used to be dropped on the floor, so the workspace saw the
 * final answer and the tool calls and nothing of how the agent got there.
 */

import type * as acp from "@agentclientprotocol/sdk";

/** The notification agentrq listens on for everything in this file. */
export const TELEMETRY_NOTIFICATION_METHOD =
  "notifications/claude/channel/telemetry";

/** Which kind of telemetry a notification carries. */
export type TelemetryKind = "thought" | "plan" | "usage";

/**
 * The wire shape agentrq receives. Keys are snake_case to match the sibling
 * `permission_request` and `cancel` notifications on the same channel.
 */
export interface TelemetryPayload {
  task_id: string;
  session_id: string;
  kind: TelemetryKind;
  /** Ready to show as-is, for anything that cannot read `data`. */
  text: string;
  /** The same telemetry structured, for a client that renders it properly. */
  data: Record<string, unknown>;
}

/**
 * The plan id a legacy `plan` update refers to.
 *
 * `plan_update` carries an id so an agent can run several plans at once; the
 * older `plan` update predates that and always means the session's single
 * plan. Giving it a fixed id puts both through one path — and keeps an agent
 * that sends both from opening a second plan alongside the first.
 */
export const DEFAULT_PLAN_ID = "default";

/** A plan in the one shape the rest of the gateway deals with. */
export type NormalizedPlan =
  | { planId: string; type: "items"; entries: acp.PlanEntry[] }
  | { planId: string; type: "file"; uri: string }
  | { planId: string; type: "markdown"; content: string };

/** How each plan entry status reads in the text fallback. */
const PLAN_STATUS_MARKERS: Record<string, string> = {
  completed: "✅",
  in_progress: "🔄",
  pending: "⬜",
};

/** Wraps the entries of a legacy `plan` update as a normal plan. */
export function planFromEntries(entries: acp.PlanEntry[]): NormalizedPlan {
  return { planId: DEFAULT_PLAN_ID, type: "items", entries };
}

/** Renders a plan as markdown, for clients that only show message text. */
export function formatPlan(plan: NormalizedPlan): string {
  switch (plan.type) {
    case "items":
      return plan.entries
        .map(
          (entry) =>
            `- ${PLAN_STATUS_MARKERS[entry.status] ?? PLAN_STATUS_MARKERS.pending} ${entry.content}`,
        )
        .join("\n");
    case "file":
      return `Plan: ${plan.uri}`;
    case "markdown":
      return plan.content;
  }
}

/** The structured form of a plan, with ACP's `_meta` left behind. */
export function planTelemetryData(
  plan: NormalizedPlan,
): Record<string, unknown> {
  const base = { planId: plan.planId, planType: plan.type };
  switch (plan.type) {
    case "items":
      return {
        ...base,
        entries: plan.entries.map((entry) => ({
          content: entry.content,
          priority: entry.priority,
          status: entry.status,
        })),
      };
    case "file":
      return { ...base, uri: plan.uri };
    case "markdown":
      return { ...base, content: plan.content };
  }
}

/** Thousands-separated, so six-figure token counts stay readable. */
function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

/**
 * Renders a cost with enough precision to be worth showing. Agent turns
 * routinely cost fractions of a cent, and `0.00 USD` says nothing.
 */
function formatCost(cost: acp.Cost): string {
  const amount =
    cost.amount !== 0 && Math.abs(cost.amount) < 0.01
      ? cost.amount.toFixed(4)
      : cost.amount.toFixed(2);
  return `${amount} ${cost.currency}`;
}

/** How much of the context window is in use, or undefined if unknowable. */
export function contextPercent(usage: acp.UsageUpdate): number | undefined {
  if (usage.size <= 0) return undefined;
  return Math.round((usage.used / usage.size) * 100);
}

/** Renders a usage snapshot as a single line, for clients that only show text. */
export function formatUsage(usage: acp.UsageUpdate): string {
  const percent = contextPercent(usage);
  let context = `Context ${formatTokens(usage.used)} / ${formatTokens(usage.size)} tokens`;
  if (percent !== undefined) context += ` (${percent}%)`;
  return usage.cost ? `${context} · ${formatCost(usage.cost)}` : context;
}

/** The structured form of a usage snapshot, with ACP's `_meta` left behind. */
export function usageTelemetryData(
  usage: acp.UsageUpdate,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    used: usage.used,
    size: usage.size,
  };
  const percent = contextPercent(usage);
  if (percent !== undefined) data.percent = percent;
  if (usage.cost) {
    data.cost = { amount: usage.cost.amount, currency: usage.cost.currency };
  }
  return data;
}
