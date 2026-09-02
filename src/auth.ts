/**
 * auth.ts
 *
 * ACP authentication support: reading the login methods an agent advertises
 * during `initialize`, recognising the protocol's `auth_required` failure, and
 * running either kind of login on the user's behalf.
 *
 * See https://agentclientprotocol.com/protocol/v1/authentication
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type * as acp from "@agentclientprotocol/sdk";

/** JSON-RPC code ACP reserves for "the user must authenticate first". */
export const AUTH_REQUIRED_CODE = -32000;

/** The slice of the ACP connection the login and logout flows drive. */
export interface AuthConnection {
  authenticate(params: { methodId: string }): Promise<unknown>;
  logout(params: Record<string, never>): Promise<unknown>;
}

/** How to re-run the configured agent binary for a `terminal` login. */
export interface AgentLaunch {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
}

export type AuthMethodType = "agent" | "terminal";

/**
 * `type` discriminates the two kinds of auth method on the wire, and the
 * protocol treats a missing `type` as `agent`.
 */
export function authMethodType(method: acp.AuthMethod): AuthMethodType {
  return (method as { type?: string }).type === "terminal" ? "terminal" : "agent";
}

/** Renders the agent's login options as a numbered list for the terminal. */
export function describeAuthMethods(
  methods: readonly acp.AuthMethod[] | null | undefined,
): string {
  if (!methods?.length) {
    return "The agent advertises no authentication methods — no login is needed.";
  }
  return methods
    .map((m, i) => {
      const kind = authMethodType(m) === "terminal" ? " [terminal login]" : "";
      const description = m.description ? ` — ${m.description}` : "";
      return `  ${i + 1}. ${m.name} (${m.id})${kind}${description}`;
    })
    .join("\n");
}

/** Pulls `code`/`message` out of a JSON-RPC failure in either shape it arrives in. */
function errorParts(err: unknown): { code?: number; message: string } {
  if (!err || typeof err !== "object") return { message: "" };
  const candidate = err as { code?: unknown; message?: unknown; error?: unknown };
  const source =
    candidate.error && typeof candidate.error === "object"
      ? (candidate.error as { code?: unknown; message?: unknown })
      : candidate;
  return {
    code: typeof source.code === "number" ? source.code : undefined,
    message: typeof source.message === "string" ? source.message : "",
  };
}

/**
 * Tells an "authenticate first" refusal apart from any other failure.
 *
 * ACP carries `auth_required` on the reserved code -32000, which agents also
 * use for unrelated errors (a denied permission, for one), so the message has
 * to agree before we send the user through a login.
 */
export function isAuthRequiredError(err: unknown): boolean {
  const { code, message } = errorParts(err);
  return code === AUTH_REQUIRED_CODE && /auth/i.test(message);
}

export interface PickAuthMethodOptions {
  /** Method id the user named explicitly (`--auth-method`). */
  preferredId?: string;
  /** Whether this process can host an interactive `terminal` login. */
  allowTerminal?: boolean;
}

/**
 * Chooses the login method to run without asking anyone.
 *
 * An explicitly named id always wins. Otherwise `agent` methods come first:
 * the agent drives those itself, so they work in an unattended gateway, while
 * a `terminal` method needs a human at a TTY.
 */
export function pickAuthMethod(
  methods: readonly acp.AuthMethod[] | null | undefined,
  { preferredId, allowTerminal = false }: PickAuthMethodOptions = {},
): acp.AuthMethod | undefined {
  if (!methods?.length) return undefined;
  if (preferredId) return methods.find((m) => m.id === preferredId);
  return (
    methods.find((m) => authMethodType(m) === "agent") ??
    (allowTerminal ? methods.find((m) => authMethodType(m) === "terminal") : undefined)
  );
}

/** Reads one line from the user; replaceable in tests. */
export type Asker = (question: string) => Promise<string>;

/** Asks on stderr so the gateway's stdout stays free for its own output. */
async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Asks the user which login to use, the way an editor would on first run.
 *
 * A single method needs no question. An empty answer takes the first method,
 * and an unrecognised one re-asks rather than logging in with something the
 * user did not choose.
 */
export async function promptForAuthMethod(
  methods: readonly acp.AuthMethod[],
  ask: Asker = askOnTerminal,
): Promise<acp.AuthMethod | undefined> {
  if (!methods.length) return undefined;
  if (methods.length === 1) return methods[0];

  console.error(`\n[auth] The agent requires a login. Available methods:\n${describeAuthMethods(methods)}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await ask(`[auth] Choose a method [1-${methods.length}, default 1]: `)).trim();
    if (!answer) return methods[0];

    const byIndex = Number(answer);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= methods.length) {
      return methods[byIndex - 1];
    }
    const byId = methods.find((m) => m.id === answer);
    if (byId) return byId;

    console.error(`[auth] "${answer}" is not one of the listed methods.`);
  }
  return undefined;
}

/**
 * Runs a `terminal` login by re-launching the configured agent interactively.
 *
 * The protocol has the client reproduce its own agent invocation with the
 * method's extra args and env, hand the process the user's terminal, and read
 * success off the exit status.
 */
export async function runTerminalAuth(
  method: acp.AuthMethod,
  launch: AgentLaunch,
): Promise<void> {
  const extra = (method as { args?: string[] }).args ?? [];
  const extraEnv = (method as { env?: Record<string, string> }).env ?? {};
  const args = [...launch.args, ...extra];

  console.error(
    `[auth] Running terminal login: ${launch.command} ${args.join(" ")}\n` +
      `[auth] Complete the login in your terminal; the gateway resumes when it exits.`,
  );

  const child = spawn(launch.command, args, {
    stdio: "inherit",
    env: { ...process.env, ...launch.env, ...extraEnv } as NodeJS.ProcessEnv,
  });

  await new Promise<void>((resolve, reject) => {
    child.on("error", (err: Error) =>
      reject(new Error(`Terminal login "${method.id}" failed to start: ${err.message}`)),
    );
    child.on("exit", (code: number | null, signal: string | null) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `Terminal login "${method.id}" failed (code=${code}, signal=${signal}).`,
        ),
      );
    });
  });
}

/** Runs whichever kind of login the chosen method calls for. */
export async function runAuthMethod(
  connection: AuthConnection,
  method: acp.AuthMethod,
  launch: AgentLaunch,
): Promise<void> {
  if (authMethodType(method) === "terminal") {
    await runTerminalAuth(method, launch);
  } else {
    // A `terminal` method must never reach `authenticate` — the agent does not
    // implement one for it.
    await connection.authenticate({ methodId: method.id });
  }
  console.error(`[auth] Logged in with "${method.name}" (${method.id}).`);
}

export interface LoginOptions {
  connection: AuthConnection;
  methods: readonly acp.AuthMethod[] | null | undefined;
  launch: AgentLaunch;
  /** Method id the user named explicitly (`--auth-method`, `--login <id>`). */
  preferredId?: string;
  /** Whether a human is present to answer a prompt and finish a terminal login. */
  interactive?: boolean;
  ask?: Asker;
}

/**
 * Logs in: picks a method — asking the user when one is there to ask — and
 * runs it. Returns the method used, or undefined when the agent advertises no
 * login at all.
 */
export async function login({
  connection,
  methods,
  launch,
  preferredId,
  interactive = false,
  ask,
}: LoginOptions): Promise<acp.AuthMethod | undefined> {
  if (!methods?.length) {
    console.error("[auth] The agent advertises no authentication methods; nothing to log in to.");
    return undefined;
  }

  let method = pickAuthMethod(methods, { preferredId, allowTerminal: interactive });
  if (preferredId && !method) {
    throw new Error(
      `Unknown authentication method "${preferredId}". Available:\n${describeAuthMethods(methods)}`,
    );
  }
  if (!preferredId && interactive) {
    method = await promptForAuthMethod(methods, ask);
  }
  if (!method) {
    throw new Error(
      `No usable authentication method. Available:\n${describeAuthMethods(methods)}\n` +
        `Terminal logins need an interactive terminal; re-run acp-gateway from one, ` +
        `or pass --auth-method <id>.`,
    );
  }

  await runAuthMethod(connection, method, launch);
  return method;
}

/** Whether the agent said it implements `logout` during `initialize`. */
export function supportsLogout(
  agentCapabilities: acp.InitializeResponse["agentCapabilities"] | null | undefined,
): boolean {
  const auth = (agentCapabilities as { auth?: { logout?: unknown } } | null | undefined)?.auth;
  return auth?.logout !== undefined && auth?.logout !== null;
}

/** Ends the agent's authenticated state, if it implements logout. */
export async function logout(
  connection: AuthConnection,
  agentCapabilities: acp.InitializeResponse["agentCapabilities"] | null | undefined,
): Promise<boolean> {
  if (!supportsLogout(agentCapabilities)) {
    console.error("[auth] The agent does not support logout.");
    return false;
  }
  await connection.logout({});
  console.error("[auth] Logged out.");
  return true;
}
