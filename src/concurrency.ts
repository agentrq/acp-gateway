/**
 * concurrency.ts
 *
 * How many tasks the gateway lets prompt the agent at once. `--max-concurrency`
 * sets the number the bridge starts on and hands to AgentRQ, which can change
 * it while running.
 */

/** Below this the queue would hold every task forever and run none of them. */
export const MIN_MAX_CONCURRENCY = 1;

/**
 * A ceiling on what the workspace may ask for.
 *
 * Every concurrent task spawns its own ACP session, and an agent session is a
 * child process — so this is the difference between a mistyped limit costing a
 * slow gateway and costing the machine it runs on.
 */
export const MAX_MAX_CONCURRENCY = 64;

/**
 * Reads a limit, or returns undefined if the value is not one.
 *
 * Accepts a number or a string: "4" is the same intent as 4. A value that is
 * out of range is clamped rather than refused, and the caller says so.
 */
export function normalizeConcurrency(value: unknown): number | undefined {
  // An empty string is refused rather than read: `Number("")` is 0, which would
  // otherwise clamp up to the floor and look like a deliberate request for 1.
  const text = typeof value === "string" ? value.trim() : undefined;
  if (typeof value === "string" && text === "") return undefined;
  const parsed = text !== undefined ? Number(text) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return undefined;
  // Truncated, not rounded: 4.9 workers means 4 can run, and rounding up would
  // hand back a limit higher than the one that was asked for.
  const whole = Math.trunc(parsed);
  if (whole < MIN_MAX_CONCURRENCY) return MIN_MAX_CONCURRENCY;
  if (whole > MAX_MAX_CONCURRENCY) return MAX_MAX_CONCURRENCY;
  return whole;
}
