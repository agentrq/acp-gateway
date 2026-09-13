/**
 * concurrency.ts
 *
 * How many tasks the gateway will let prompt the agent at once, and how the
 * workspace changes that number while the gateway is running.
 *
 * `--max-concurrency` sets the number the gateway boots with. Everything here
 * exists because that was the only way to set it: raising the limit on a busy
 * gateway, or lowering it to drain one, meant restarting the process and
 * dropping every session it held.
 */

/** The notification the workspace sends to change the limit. */
export const SET_CONCURRENCY_NOTIFICATION_METHOD =
  "notifications/claude/channel/set_concurrency";

/** The notification the gateway reports the limit on. */
export const CONCURRENCY_NOTIFICATION_METHOD =
  "notifications/claude/channel/concurrency";

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

/** What the gateway reports about its own queue. */
export interface ConcurrencyState {
  maxConcurrency: number;
  active: number;
  queued: number;
}

/**
 * Reads a limit the workspace asked for, or returns undefined if it asked for
 * something that is not one.
 *
 * Accepts a number or a string, because the notification is JSON from another
 * service and "4" is the same intent as 4. A value that is out of range is
 * clamped rather than refused: the caller reports back the limit that actually
 * took effect, so a clamp is visible in the interface rather than silent, and
 * refusing would leave the workspace with no limit change at all when what it
 * asked for was merely too enthusiastic.
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

/**
 * Tells the workspace the limit in force, and what the queue is doing under it.
 *
 * Sent on connect, on reconnect, and after every set_concurrency — accepted or
 * not. That last case is the point: the workspace moved a control and is
 * waiting to see where it landed, so a rejected value has to be answered with
 * the real one rather than with silence, or the interface goes on showing a
 * limit the gateway never adopted.
 *
 * Never throws: this is an interface update, and a workspace that cannot take
 * it right now must not cost the agent anything.
 */
export async function sendConcurrencyNotification(
  bridge: { sendNotification(method: string, params: unknown): Promise<unknown> },
  state: ConcurrencyState,
): Promise<void> {
  // camelCase, and only camelCase. The older notifications on this channel
  // each carry a field twice because they gained a second spelling after
  // something was already reading the first; this pair has no such history and
  // no reason to acquire one.
  const payload = {
    // No task or session required, for the reason sendAgentIdentity records:
    // the workspace keys this to the MCP connection it arrived on, and the
    // moment a human most wants to see the limit is before any task has run.
    taskId: "",
    sessionId: "",
    maxConcurrency: state.maxConcurrency,
    active: state.active,
    queued: state.queued,
    min: MIN_MAX_CONCURRENCY,
    max: MAX_MAX_CONCURRENCY,
    // This gateway acts on a set_concurrency notification, and says so — the
    // same declaration the models notification makes, for the same reason.
    // Every gateway ever published could report a limit; the ones before this
    // release ignore being told to change it, and nothing else on the wire
    // distinguishes them.
    canSet: true,
  };
  try {
    await bridge.sendNotification(CONCURRENCY_NOTIFICATION_METHOD, payload);
    console.error(
      `[bridge] Told the workspace its concurrency limit is ${state.maxConcurrency} ` +
        `(${state.active} running, ${state.queued} queued)`,
    );
  } catch (err) {
    console.error("[bridge] Failed to send concurrency notification:", err);
  }
}
