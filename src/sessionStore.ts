/**
 * sessionStore.ts
 *
 * Remembers which ACP session belongs to which task, across restarts.
 *
 * A session lives inside the agent, not here, and agents that advertise
 * `session/resume` or `session/load` can pick one up again later. Without a
 * note of which session was which, a gateway restart loses that: the human
 * replies "yes, go ahead" and the agent has no idea what "it" refers to.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { defaultCacheDir } from "./agentInstall.js";

interface StoredSessions {
  /** taskId → the ACP session that was serving it. */
  sessions: Record<string, string>;
}

/**
 * Where one gateway's sessions are remembered.
 *
 * A session id only means something to the agent that issued it, in the
 * workspace it was created for, so the file is keyed by both. Pointing a
 * different agent at the same workspace starts from scratch rather than
 * offering it session ids it has never heard of.
 */
export function sessionStorePath(
  agentCommand: string,
  workspaceUrl: string,
  cacheDir: string = path.dirname(defaultCacheDir()),
): string {
  const key = createHash("sha256").update(`${agentCommand}\n${workspaceUrl}`).digest("hex");
  return path.join(cacheDir, "sessions", `${key.slice(0, 16)}.json`);
}

/** Remembers task → session pairs, on disk, best-effort. */
export class SessionStore {
  private sessions: Record<string, string>;

  constructor(private filePath: string) {
    this.sessions = SessionStore.read(filePath);
  }

  private static read(filePath: string): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as StoredSessions;
      return parsed.sessions ?? {};
    } catch {
      // No file yet, or one that cannot be read. Either way there is nothing to
      // recover, which is exactly the state before this existed.
      return {};
    }
  }

  /** The session that was serving this task before, if one is remembered. */
  get(taskId: string): string | undefined {
    return this.sessions[taskId];
  }

  set(taskId: string, sessionId: string): void {
    if (this.sessions[taskId] === sessionId) return;
    this.sessions[taskId] = sessionId;
    this.persist();
  }

  delete(taskId: string): void {
    if (!(taskId in this.sessions)) return;
    delete this.sessions[taskId];
    this.persist();
  }

  /**
   * Writes the file, and shrugs if it cannot.
   *
   * Losing this costs a conversation's context on the next restart; failing
   * the task over it would cost the task.
   */
  private persist(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ sessions: this.sessions }, null, 2));
    } catch (err) {
      console.error(`[acp] Could not remember sessions in ${this.filePath}:`, err);
    }
  }
}
