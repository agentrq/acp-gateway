/**
 * mcpOAuth.ts
 *
 * Signs the gateway in to MCP servers that want an OAuth login, and hands the
 * agent the token.
 *
 * ACP gives a client nothing but fixed headers (http, sse) or env vars (stdio)
 * to pass along with each MCP server: an agent handed a server that wants a
 * login has no way to ask anyone for one. So the gateway does the login itself
 * — `--mcp-login <name>`, once, following the MCP authorization spec — keeps
 * the tokens on this machine, and adds `Authorization: Bearer` to the server's
 * headers in every session it opens.
 *
 * Tokens only ever go to the MCP server, as that header, and to its own
 * authorization server's token endpoint. They are never printed, and never
 * sent to AgentRQ.
 *
 * See https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { McpServerConfig } from "./config.js";
import { askOnTerminalUntil, redirectToDeliver, type AbortableAsker } from "./auth.js";
import { debug } from "./log.js";
import { pkg } from "./version.js";

/** What is kept for one MCP server, by its URL. */
export interface StoredMcpAuth {
  clientId: string;
  clientSecret?: string;
  /** How the client registered to authenticate at the token endpoint. */
  authMethod?: string;
  tokenEndpoint: string;
  /** The RFC 8707 resource the tokens were issued for. */
  resource?: string;
  accessToken: string;
  refreshToken?: string;
  /** When the access token expires, in ms since the epoch; unknown when absent. */
  expiresAt?: number;
}

export type TokenStore = Record<string, StoredMcpAuth>;

/** Where the endpoints of an MCP server's authorization server are. */
export interface OAuthServerInfo {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource?: string;
  scope?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  authMethod?: string;
}

/** A token is refreshed this long before it runs out. */
const REFRESH_MARGIN_MS = 60_000;
/** How long a login waits for the browser. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const CALLBACK_PATH = "/callback";

const defaultPrint = (line: string) => console.error(line);

/**
 * The tokens file: next to the user's other configuration rather than in a
 * cache, since losing it means signing in again.
 */
export function tokenStorePath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  const base =
    platform === "win32"
      ? env.APPDATA || path.join(homedir(), "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "acp-gateway", "mcp-oauth.json");
}

/** The saved logins; none when the file is missing or unreadable. */
export function readTokenStore(file: string): TokenStore {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Saves the logins where only this user can read them. */
export function writeTokenStore(file: string, store: TokenStore): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written whole and renamed into place, so a crash never leaves half a file,
  // and created 0600 so the tokens are never readable by anyone else.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function saveStored(file: string, url: string, entry: StoredMcpAuth | undefined): void {
  const store = readTokenStore(file);
  if (entry) store[url] = entry;
  else delete store[url];
  writeTokenStore(file, store);
}

/** The parameters of a `WWW-Authenticate` challenge. */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const params: Record<string, string> = {};
  for (const m of (header ?? "").matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g)) {
    params[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3];
  }
  return params;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export type ProbeResult =
  | { needsLogin: false }
  | { needsLogin: true; resourceMetadata?: string; scope?: string };

/**
 * Asks an MCP server whether it lets the gateway in as configured.
 *
 * Only a 401 counts as wanting a login: anything else — a 200, a 405 from a
 * server that wants a different method, a 500 — is a server the agent may as
 * well be handed as it is.
 */
export async function probeMcpServer(
  server: McpServerConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const init: RequestInit =
    server.type === "sse"
      ? { method: "GET", headers: { ...server.headers, accept: "text/event-stream" } }
      : {
          method: "POST",
          headers: {
            ...server.headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "acp-gateway", version: pkg.version },
            },
          }),
        };
  try {
    const res = await fetchImpl(server.url!, { ...init, signal: ctl.signal });
    if (res.status !== 401) return { needsLogin: false };
    const challenge = parseWwwAuthenticate(res.headers.get("www-authenticate"));
    return { needsLogin: true, resourceMetadata: challenge.resource_metadata, scope: challenge.scope };
  } finally {
    clearTimeout(timer);
    // An SSE stream stays open otherwise.
    ctl.abort();
  }
}

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<Json> {
  try {
    const body = await res.json();
    return body && typeof body === "object" ? (body as Json) : {};
  } catch {
    return {};
  }
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<Json | undefined> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    return res.ok ? await readJson(res) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Where RFC 8414 / OIDC put an authorization server's metadata, path-aware. */
function metadataUrls(issuer: URL): string[] {
  const p = issuer.pathname.replace(/\/+$/, "");
  const o = issuer.origin;
  return p
    ? [
        `${o}/.well-known/oauth-authorization-server${p}`,
        `${o}/.well-known/openid-configuration${p}`,
        `${o}${p}/.well-known/openid-configuration`,
      ]
    : [`${o}/.well-known/oauth-authorization-server`, `${o}/.well-known/openid-configuration`];
}

/**
 * Finds the authorization server behind an MCP server.
 *
 * The protected-resource metadata (RFC 9728) names it — from the 401's
 * challenge, or the well-known address. A server that publishes none is its
 * own authorization server, and one that publishes no metadata either gets the
 * endpoints the 2025-03-26 spec told clients to assume.
 */
export async function discoverOAuth(
  serverUrl: string,
  hint: { resourceMetadata?: string; scope?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthServerInfo> {
  const url = new URL(serverUrl);
  url.hash = "";
  const p = url.pathname.replace(/\/+$/, "");
  const prmUrls = hint.resourceMetadata
    ? [hint.resourceMetadata]
    : [
        ...(p ? [`${url.origin}/.well-known/oauth-protected-resource${p}`] : []),
        `${url.origin}/.well-known/oauth-protected-resource`,
      ];
  let prm: Json | undefined;
  for (const candidate of prmUrls) {
    prm = await getJson(candidate, fetchImpl);
    if (prm) break;
  }
  const servers = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers : [];
  const issuer = new URL(str(servers[0]) ?? url.origin);

  let meta: Json | undefined;
  for (const candidate of metadataUrls(issuer)) {
    const found = await getJson(candidate, fetchImpl);
    if (str(found?.authorization_endpoint) && str(found?.token_endpoint)) {
      meta = found;
      break;
    }
  }
  const methods = meta?.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new Error(`The authorization server at ${issuer.origin} does not support PKCE with S256, which MCP requires.`);
  }
  const fallback = (p: string) => new URL(p, issuer.origin).href;
  const scopes = Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(" ") : undefined;
  return {
    authorizationEndpoint: str(meta?.authorization_endpoint) ?? fallback("/authorize"),
    tokenEndpoint: str(meta?.token_endpoint) ?? fallback("/token"),
    registrationEndpoint: meta ? str(meta.registration_endpoint) : fallback("/register"),
    resource: str(prm?.resource) ?? url.href,
    scope: hint.scope ?? scopes,
  };
}

/** An OAuth error response in a sentence: status, code and description, never a token. */
function describeOAuthError(res: Response, body: Json): string {
  const error = str(body.error);
  const description = str(body.error_description);
  return `${res.status}${error ? ` ${error}` : ""}${description ? `: ${description}` : ""}`;
}

/** Registers the gateway as a public client (RFC 7591) for this login's redirect. */
export async function registerClient(
  info: OAuthServerInfo,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthClient> {
  if (!info.registrationEndpoint) {
    throw new Error(
      "The authorization server does not let clients register themselves (it has no registration_endpoint), " +
        "so acp-gateway cannot sign in to it. Configure a token in the server's headers in .mcp.json instead.",
    );
  }
  const res = await fetchImpl(info.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "acp-gateway",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(info.scope ? { scope: info.scope } : {}),
    }),
  });
  const body = await readJson(res);
  const clientId = str(body.client_id);
  if (!res.ok || !clientId) {
    throw new Error(`Registering acp-gateway with the authorization server failed: ${describeOAuthError(res, body)}`);
  }
  return { clientId, clientSecret: str(body.client_secret), authMethod: str(body.token_endpoint_auth_method) };
}

/** Calls the token endpoint, authenticating the client the way it registered. */
async function requestTokens(
  tokenEndpoint: string,
  client: OAuthClient,
  params: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<Json> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.clientSecret && client.authMethod === "client_secret_basic") {
    const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
  }
  const res = await fetchImpl(tokenEndpoint, { method: "POST", headers, body });
  const json = await readJson(res);
  if (!res.ok || !str(json.access_token)) {
    throw new Error(`The token endpoint refused: ${describeOAuthError(res, json)}`);
  }
  return json;
}

function toStored(
  tokens: Json,
  client: OAuthClient,
  tokenEndpoint: string,
  resource: string | undefined,
  now: number,
  previousRefresh?: string,
): StoredMcpAuth {
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    authMethod: client.authMethod,
    tokenEndpoint,
    resource,
    accessToken: tokens.access_token as string,
    // A server that does not rotate refresh tokens sends none back.
    refreshToken: str(tokens.refresh_token) ?? previousRefresh,
    expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
  };
}

/** Swaps a saved refresh token for a new access token. */
export async function refreshStored(
  stored: StoredMcpAuth,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<StoredMcpAuth> {
  const tokens = await requestTokens(
    stored.tokenEndpoint,
    stored,
    { grant_type: "refresh_token", refresh_token: stored.refreshToken, resource: stored.resource },
    fetchImpl,
  );
  return toStored(tokens, stored, stored.tokenEndpoint, stored.resource, now(), stored.refreshToken);
}

export interface LoopbackReceiver {
  redirectUri: string;
  /** The redirect's query, from the browser or from a pasted address. */
  answer: Promise<URLSearchParams>;
  deliver: (params: URLSearchParams) => void;
  close: () => void;
}

/** Listens on 127.0.0.1 for the browser coming back from the sign-in. */
export async function openLoopbackReceiver(): Promise<LoopbackReceiver> {
  let deliver!: (params: URLSearchParams) => void;
  const answer = new Promise<URLSearchParams>((resolve) => (deliver = resolve));
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH || (!url.searchParams.has("code") && !url.searchParams.has("error"))) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" })
      .end("acp-gateway has the sign-in. You can close this tab.");
    deliver(url.searchParams);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    answer,
    deliver,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/**
 * Takes the address a browser on another computer ended up on, where the
 * loopback redirect cannot reach this machine. Same rules as an agent's own
 * login: the same host, port and path, carrying a code or an error.
 */
async function acceptPastedRedirect(
  receiver: LoopbackReceiver,
  signal: AbortSignal,
  ask: AbortableAsker,
  print: (line: string) => void,
): Promise<void> {
  const redirect = new URL(receiver.redirectUri);
  print(
    `[mcp] Signing in from a browser on another computer? Its last page, on ${redirect.host}, ` +
      `will not load there. Copy that page's address from the address bar and paste it here.`,
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    let answer: string;
    try {
      answer = await ask(`[mcp] Address the browser ended up on: `, signal);
    } catch {
      return;
    }
    const url = redirectToDeliver(answer, redirect);
    if (url) return receiver.deliver(url.searchParams);
    print(`[mcp] That is not an address on ${redirect.host}${redirect.pathname} with a code in it.`);
  }
}

export interface McpLoginDeps {
  fetch?: typeof fetch;
  storePath?: string;
  /** Whether someone is at the terminal to paste a redirect. */
  interactive?: boolean;
  ask?: AbortableAsker;
  print?: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
}

/** Runs the OAuth sign-in for one MCP server and saves its tokens. */
export async function mcpLogin(server: McpServerConfig, deps: McpLoginDeps = {}): Promise<void> {
  const {
    fetch: fetchImpl = fetch,
    storePath = tokenStorePath(),
    interactive = false,
    ask = askOnTerminalUntil,
    print = defaultPrint,
    now = Date.now,
    timeoutMs = LOGIN_TIMEOUT_MS,
  } = deps;
  if (server.type === "stdio" || !server.url) {
    throw new Error(`MCP server "${server.name}" runs as a local command; only http and sse servers have an OAuth login.`);
  }
  const probe = await probeMcpServer(server, fetchImpl);
  if (!probe.needsLogin) {
    print(`[mcp] MCP server "${server.name}" let acp-gateway in without a login; there is nothing to sign in to.`);
    return;
  }
  const info = await discoverOAuth(server.url, probe, fetchImpl);
  const receiver = await openLoopbackReceiver();
  const done = new AbortController();
  let pasting: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const client = await registerClient(info, receiver.redirectUri, fetchImpl);
    const { verifier, challenge } = createPkce();
    const state = randomBytes(16).toString("base64url");
    const auth = new URL(info.authorizationEndpoint);
    const query: Record<string, string | undefined> = {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: receiver.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: info.resource,
      scope: info.scope,
    };
    for (const [k, v] of Object.entries(query)) if (v !== undefined) auth.searchParams.set(k, v);

    print(`[mcp] Open this address in a browser to sign in to MCP server "${server.name}":\n\n  ${auth.href}\n`);
    if (interactive) pasting = acceptPastedRedirect(receiver, done.signal, ask, print);

    const timedOut = new Promise<never>((_r, reject) => {
      timer = setTimeout(
        () => reject(new Error(`No sign-in arrived within ${Math.round(timeoutMs / 1000)} s; run --mcp-login again.`)),
        timeoutMs,
      );
    });
    const params = await Promise.race([receiver.answer, timedOut]);
    if (params.get("state") !== state) {
      throw new Error("The sign-in came back with a different state than it was sent with; run --mcp-login again.");
    }
    const error = params.get("error");
    if (error) {
      const description = params.get("error_description");
      throw new Error(`The sign-in was refused: ${error}${description ? `: ${description}` : ""}`);
    }
    const tokens = await requestTokens(
      info.tokenEndpoint,
      client,
      {
        grant_type: "authorization_code",
        // Delivered only with a code or an error, and there was no error.
        code: params.get("code")!,
        redirect_uri: receiver.redirectUri,
        code_verifier: verifier,
        resource: info.resource,
      },
      fetchImpl,
    );
    saveStored(storePath, server.url, toStored(tokens, client, info.tokenEndpoint, info.resource, now()));
    print(`[mcp] Signed in to "${server.name}". acp-gateway hands the agent its token from now on.`);
  } finally {
    clearTimeout(timer);
    done.abort();
    await pasting;
    receiver.close();
  }
}

/** Forgets the saved login for one MCP server. */
export function mcpLogout(
  server: McpServerConfig,
  deps: { storePath?: string; print?: (line: string) => void } = {},
): void {
  const { storePath = tokenStorePath(), print = defaultPrint } = deps;
  if (!server.url || !readTokenStore(storePath)[server.url]) {
    print(`[mcp] acp-gateway had no saved login for "${server.name}".`);
    return;
  }
  saveStored(storePath, server.url, undefined);
  print(`[mcp] Signed out of "${server.name}".`);
}

export function needsLoginMessage(name: string): string {
  return (
    `[mcp] MCP server "${name}" needs a login, so the agent will not get its tools. ` +
    `Sign in once with: acp-gateway --mcp-login ${name}`
  );
}

const hasAuthorization = (server: McpServerConfig) =>
  Object.keys(server.headers ?? {}).some((k) => k.toLowerCase() === "authorization");

export interface McpAuthDeps {
  fetch?: typeof fetch;
  storePath?: string;
  now?: () => number;
  print?: (line: string) => void;
  /** A server to leave alone: the AgentRQ one, which carries its own token. */
  skip?: string;
}

/**
 * Adds a saved login's token to each http/sse server that has one, and says
 * which servers want a login they have not had.
 *
 * The headers are set on the configs themselves, which every session the
 * bridge opens reads afresh, and a timer refreshes each token before it runs
 * out. A server that already has an Authorization header in .mcp.json keeps
 * it. Returns a function that stops the refreshing.
 */
export async function authorizeMcpServers(
  configs: McpServerConfig[],
  deps: McpAuthDeps = {},
): Promise<() => void> {
  const {
    fetch: fetchImpl = fetch,
    storePath = tokenStorePath(),
    now = Date.now,
    print = defaultPrint,
    skip,
  } = deps;
  const timers = new Set<NodeJS.Timeout>();

  const apply = (cfg: McpServerConfig, stored: StoredMcpAuth) => {
    cfg.headers = { ...cfg.headers, Authorization: `Bearer ${stored.accessToken}` };
  };

  const refresh = async (cfg: McpServerConfig, stored: StoredMcpAuth): Promise<StoredMcpAuth | undefined> => {
    if (!stored.refreshToken) {
      print(`[mcp] The login for MCP server "${cfg.name}" has expired. Sign in again with: acp-gateway --mcp-login ${cfg.name}`);
      return undefined;
    }
    try {
      const next = await refreshStored(stored, fetchImpl, now);
      saveStored(storePath, cfg.url!, next);
      debug(`[mcp] Refreshed the login for MCP server "${cfg.name}".`);
      return next;
    } catch (err) {
      print(
        `[mcp] Could not refresh the login for MCP server "${cfg.name}" (${(err as Error).message}). ` +
          `Sign in again with: acp-gateway --mcp-login ${cfg.name}`,
      );
      return undefined;
    }
  };

  const schedule = (cfg: McpServerConfig, stored: StoredMcpAuth) => {
    if (stored.expiresAt === undefined || !stored.refreshToken) return;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      const next = await refresh(cfg, stored);
      if (!next) return;
      apply(cfg, next);
      schedule(cfg, next);
    }, Math.max(stored.expiresAt - REFRESH_MARGIN_MS - now(), 1000));
    timer.unref();
    timers.add(timer);
  };

  const authorizeOne = async (cfg: McpServerConfig) => {
    let stored: StoredMcpAuth | undefined = readTokenStore(storePath)[cfg.url!];
    if (!stored) {
      let probe: ProbeResult;
      try {
        probe = await probeMcpServer(cfg, fetchImpl);
      } catch (err) {
        debug(`[mcp] Could not reach MCP server "${cfg.name}" to see whether it needs a login: ${(err as Error).message}`);
        return;
      }
      if (probe.needsLogin) print(needsLoginMessage(cfg.name));
      return;
    }
    if (stored.expiresAt !== undefined && stored.expiresAt - REFRESH_MARGIN_MS <= now()) {
      stored = await refresh(cfg, stored);
      if (!stored) return;
    }
    apply(cfg, stored);
    schedule(cfg, stored);
  };

  await Promise.all(
    configs
      .filter((c) => c.type !== "stdio" && c.url && c.name !== skip && !hasAuthorization(c))
      .map(authorizeOne),
  );
  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
