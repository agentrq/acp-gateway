/**
 * How much the gateway says on the terminal.
 *
 * By default it says what it is asked to do — each incoming task, each
 * permission it is waiting on, how each turn ended — and anything that went
 * wrong. Everything else (connections, notifications, file reads and writes,
 * tool calls, the agent's own streamed answer) is the gateway's working, and
 * is only printed under `--verbose`.
 */

import type { Readable } from "node:stream";

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

/** How much of an agent's stderr is kept to explain a failure, in characters. */
export const AGENT_STDERR_TAIL_LENGTH = 8 * 1024;

// How many logins are waiting on an agent right now, and who is reading what
// the agents say meanwhile; see showingAgentStderr.
let loginsInFlight = 0;
const loginReaders = new Set<(text: string) => void>();

/**
 * Passes every agent's stderr straight through while `run` is in flight.
 *
 * A login is the one time the agent has something on stderr the human must
 * read: an agent that cannot open a browser where it runs — antigravity on a
 * headless machine, say — prints the URL to open there and nowhere else.
 * `onOutput`, when given, is handed the same text as it goes by, for a login
 * that needs to act on what the agent said.
 */
export async function showingAgentStderr<T>(
  run: () => Promise<T>,
  onOutput?: (text: string) => void,
): Promise<T> {
  loginsInFlight++;
  if (onOutput) loginReaders.add(onOutput);
  try {
    return await run();
  } finally {
    loginsInFlight--;
    if (onOutput) loginReaders.delete(onOutput);
  }
}

/**
 * Agents write a lot of their own logging to stderr. Under `--verbose`, or
 * while a login is waiting on the agent, it is passed straight through.
 * Otherwise only the end of it is kept, so that when the agent fails there is
 * still something to show for it.
 *
 * Returns a function that hands over what has been kept and forgets it, so
 * the same lines are never shown twice.
 */
export function followAgentStderr(stream: Readable | null | undefined): () => string {
  let tail = "";
  stream?.on("data", (chunk: Buffer | string) => {
    if (verbose || loginsInFlight > 0) {
      process.stderr.write(chunk);
      for (const read of loginReaders) read(chunk.toString());
      return;
    }
    tail = (tail + chunk.toString()).slice(-AGENT_STDERR_TAIL_LENGTH);
  });
  return () => {
    const kept = tail;
    tail = "";
    return kept;
  };
}
