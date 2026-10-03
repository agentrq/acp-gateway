/**
 * How much the gateway says on the terminal.
 *
 * By default it says what it is asked to do — each incoming task, each
 * permission it is waiting on, how each turn ended — and anything that went
 * wrong. Everything else (connections, notifications, file reads and writes,
 * tool calls, the agent's own streamed answer) is the gateway's working, and
 * is only printed under `--verbose`.
 */

let verbose = false;

export function setVerbose(on: boolean): void {
  verbose = on;
}

export function isVerbose(): boolean {
  return verbose;
}

/** Logs to stderr, but only under `--verbose`. */
export function debug(...args: unknown[]): void {
  if (verbose) console.error(...args);
}

/** Longest a task's text is shown when it is announced. */
export const TASK_PREVIEW_LENGTH = 200;

/**
 * One line saying what the gateway has been asked, for the default output.
 * The text is collapsed onto one line and cut short; the whole of it is in
 * the workspace for anyone who wants it.
 */
export function describeAsk(text: string, taskId?: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const preview =
    flat.length > TASK_PREVIEW_LENGTH
      ? `${flat.slice(0, TASK_PREVIEW_LENGTH - 1)}…`
      : flat;
  return `[task${taskId ? ` ${taskId}` : ""}] ${preview}`;
}

/** Says, by default, what the gateway has just been asked to do. */
export function announceTask(text: string, taskId?: string): void {
  console.error(`\n${describeAsk(text, taskId)}`);
}

/** Says, by default, how a task's turn ended. */
export function announceFinished(taskId: string | undefined, stopReason: string): void {
  console.error(`[task${taskId ? ` ${taskId}` : ""}] Finished: ${stopReason}`);
}
