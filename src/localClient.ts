/**
 * localClient.ts
 *
 * The ACP client the one-shot commands talk to the agent through: `--login`,
 * `--logout`, `--list-models`, `--agent-info` and `--list-auth-methods`.
 *
 * None of them runs a task, so there is nothing to approve and no file to read
 * or write. What they can be asked is to sign in, and a sign-in the agent sends
 * as a url elicitation is put to the person at this terminal.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { debug } from "./log.js";

/**
 * Asks a human at this terminal to visit a URL, resolving once they say they
 * are done (or once `signal` fires, when the agent stops needing an answer).
 *
 * Injected rather than imported so the client stays free of readline, and so
 * the gateway can leave it out when there is no terminal to ask at.
 */
export type UrlElicitationPrompt = (request: {
  message: string;
  url: string;
  signal: AbortSignal;
}) => Promise<acp.CreateElicitationResponse>;

/**
 * Renders a url-mode elicitation for someone reading a terminal.
 *
 * The URL goes on a line of its own: an agent's `message` carries the part
 * only a human can supply — codex-acp puts the one-time device code there —
 * and says nothing about where to type it, so a log of the message alone
 * leaves the reader with a code and nowhere to use it.
 */
export function formatUrlElicitation(message: string, url: string): string {
  return `\n[auth] ${message}\n[auth] Open this URL to continue:\n\n    ${url}\n`;
}

export interface LocalClientOptions {
  /** Left out when there is no terminal to ask at. */
  promptUrlElicitation?: UrlElicitationPrompt;
}

export class LocalACPClient implements acp.Client {
  // elicitationId → the terminal prompt still waiting on a human. Kept so an
  // `elicitation/complete` can close a prompt whose answer the agent has
  // stopped waiting for — a browser login that finished on its own, say.
  private pendingUrlElicitations = new Map<string, AbortController>();

  constructor(private readonly options: LocalClientOptions = {}) {}

  /** No task runs here, so no tool call has anyone to approve it. */
  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    debug(`[acp] Refusing permission request outside a task: ${params.toolCall?.title ?? ""}`);
    return { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    debug(`[acp] Session update: ${params.update.sessionUpdate}`);
  }

  /**
   * A url elicitation is always printed — the URL is the one thing the human
   * needs — and put to the terminal when there is one. A form has nobody to
   * fill it in, so it is cancelled.
   */
  async createElicitation(
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    if (params.mode !== "url") {
      console.error(`[acp] Cannot answer a "${params.mode}" elicitation here, cancelling: ${params.message}`);
      return { action: "cancel" };
    }
    const { url, elicitationId } = params as acp.ElicitationUrlMode;
    console.error(formatUrlElicitation(params.message, url));
    if (!this.options.promptUrlElicitation) return { action: "cancel" };

    const controller = new AbortController();
    if (elicitationId) this.pendingUrlElicitations.set(elicitationId, controller);
    try {
      return await this.options.promptUrlElicitation({
        message: params.message,
        url,
        signal: controller.signal,
      });
    } catch (err) {
      console.error(`[auth] Could not ask about the login at this terminal:`, err);
      return { action: "cancel" };
    } finally {
      if (elicitationId) this.pendingUrlElicitations.delete(elicitationId);
    }
  }

  /**
   * The agent finished the login on its own — codex-acp races the browser
   * against our answer — so the prompt nobody needs to answer is closed.
   */
  async completeElicitation(params: acp.CompleteElicitationNotification): Promise<void> {
    const waiting = this.pendingUrlElicitations.get(params.elicitationId);
    if (!waiting) return;
    console.error(`[auth] The agent reports this login as finished.`);
    waiting.abort();
  }

  /** Closes any terminal prompt still open, when the agent goes away. */
  dispose(): void {
    for (const controller of this.pendingUrlElicitations.values()) controller.abort();
    this.pendingUrlElicitations.clear();
  }
}
