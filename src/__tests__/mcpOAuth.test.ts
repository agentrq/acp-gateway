import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { McpServerConfig } from "../config.js";
import {
  authorizeMcpServers,
  createPkce,
  discoverOAuth,
  mcpLogin,
  mcpLogout,
  needsLoginMessage,
  openLoopbackReceiver,
  parseWwwAuthenticate,
  probeMcpServer,
  readTokenStore,
  refreshStored,
  registerClient,
  tokenStorePath,
  writeTokenStore,
  type StoredMcpAuth,
} from "../mcpOAuth.js";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A local server standing in for an MCP server and its authorization server. */
async function fakeServer(routes: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      calls.push({ method: req.method!, path, headers: req.headers, body });
      const handler = routes[path];
      if (handler) handler(req, body, res);
      else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    calls,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_req, _body, res) => {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
};

let dir: string;
let store: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-oauth-test-"));
  store = join(dir, "nested", "mcp-oauth.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("tokenStorePath", () => {
  it("uses XDG_CONFIG_HOME, then ~/.config", () => {
    expect(tokenStorePath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "acp-gateway", "mcp-oauth.json"));
    expect(tokenStorePath({}, "linux")).toMatch(/\.config[\\/]acp-gateway[\\/]mcp-oauth\.json$/);
  });
  it("uses APPDATA on Windows", () => {
    expect(tokenStorePath({ APPDATA: "C:/A" }, "win32")).toBe(join("C:/A", "acp-gateway", "mcp-oauth.json"));
    expect(tokenStorePath({}, "win32")).toMatch(/AppData[\\/]Roaming[\\/]acp-gateway/);
  });
});

describe("token store", () => {
  it("is empty when the file is missing or unreadable", () => {
    expect(readTokenStore(store)).toEqual({});
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(readTokenStore(join(dir, "bad.json"))).toEqual({});
    writeFileSync(join(dir, "arr.json"), "[1]");
    expect(readTokenStore(join(dir, "arr.json"))).toEqual({});
  });

  it("writes a file only its owner can read", () => {
    const entry = { clientId: "c", tokenEndpoint: "https://t", accessToken: "a" };
    writeTokenStore(store, { "https://m/": entry });
    expect(readTokenStore(store)).toEqual({ "https://m/": entry });
    if (process.platform !== "win32") expect(statSync(store).mode & 0o777).toBe(0o600);
  });
});

describe("parseWwwAuthenticate", () => {
  it("reads quoted and bare parameters", () => {
    expect(
      parseWwwAuthenticate('Bearer realm="mcp", resource_metadata="https://h/.well-known/x", scope="a b", error=invalid_token'),
    ).toEqual({ realm: "mcp", resource_metadata: "https://h/.well-known/x", scope: "a b", error: "invalid_token" });
  });
  it("unescapes quoted strings and tolerates no header", () => {
    expect(parseWwwAuthenticate('Bearer realm="a\\"b"')).toEqual({ realm: 'a"b' });
    expect(parseWwwAuthenticate(null)).toEqual({});
  });
});

describe("createPkce", () => {
  it("makes an S256 challenge of a base64url verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
});

describe("probeMcpServer", () => {
  it("POSTs an initialize to an http server and reads its 401 challenge", async () => {
    const s = await fakeServer({
      "/mcp": json(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://rm", scope="read"' }),
    });
    try {
      const result = await probeMcpServer({ name: "m", type: "http", url: `${s.base}/mcp`, headers: { "X-Key": "k" } });
      expect(result).toEqual({ needsLogin: true, resourceMetadata: "https://rm", scope: "read" });
      expect(s.calls[0].method).toBe("POST");
      expect(s.calls[0].headers["x-key"]).toBe("k");
      expect(JSON.parse(s.calls[0].body).method).toBe("initialize");
    } finally {
      await s.close();
    }
  });

  it("GETs an sse server and treats anything but 401 as no login needed", async () => {
    const s = await fakeServer({
      "/sse": (_req, _b, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n");
      },
    });
    try {
      expect(await probeMcpServer({ name: "m", type: "sse", url: `${s.base}/sse` })).toEqual({ needsLogin: false });
      expect(s.calls[0].method).toBe("GET");
      expect(s.calls[0].headers.accept).toBe("text/event-stream");
    } finally {
      await s.close();
    }
  });

  it("gives up on a server that does not answer in time", async () => {
    const hang = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    await expect(probeMcpServer({ name: "m", type: "http", url: "https://m/" }, hang as any, 5)).rejects.toThrow("aborted");
  });
});

describe("discoverOAuth", () => {
  it("follows the challenge's resource metadata to the authorization server", async () => {
    let base = "";
    const s = await fakeServer({
      "/rm": (q, b, res) =>
        json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/tenant`], scopes_supported: ["x", "y"] })(q, b, res),
      "/.well-known/oauth-authorization-server/tenant": json(404, {}),
      "/.well-known/openid-configuration/tenant": (q, b, res) =>
        json(200, {
          authorization_endpoint: `${base}/auth`,
          token_endpoint: `${base}/tok`,
          registration_endpoint: `${base}/reg`,
          code_challenge_methods_supported: ["S256"],
        })(q, b, res),
    });
    base = s.base;
    try {
      const info = await discoverOAuth(`${s.base}/mcp`, { resourceMetadata: `${s.base}/rm` });
      expect(info).toEqual({
        authorizationEndpoint: `${s.base}/auth`,
        tokenEndpoint: `${s.base}/tok`,
        registrationEndpoint: `${s.base}/reg`,
        resource: `${s.base}/mcp`,
        scope: "x y",
      });
    } finally {
      await s.close();
    }
  });

  it("finds the well-known documents itself and keeps the challenge's scope", async () => {
    const s = await fakeServer({
      "/.well-known/oauth-protected-resource": json(200, { authorization_servers: [] }),
      "/.well-known/oauth-authorization-server": json(200, { authorization_endpoint: "https://a/auth", token_endpoint: "https://a/tok" }),
    });
    try {
      const info = await discoverOAuth(`${s.base}/v1/mcp#frag`, { scope: "only" });
      expect(info).toEqual({
        authorizationEndpoint: "https://a/auth",
        tokenEndpoint: "https://a/tok",
        registrationEndpoint: undefined,
        resource: `${s.base}/v1/mcp`,
        scope: "only",
      });
      expect(s.calls.map((c) => c.path)).toEqual([
        "/.well-known/oauth-protected-resource/v1/mcp",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server",
      ]);
    } finally {
      await s.close();
    }
  });

  it("falls back to the default endpoints when nothing is published", async () => {
    const s = await fakeServer({ "/.well-known/openid-configuration": (_q, _b, res) => res.writeHead(200).end("not json") });
    try {
      const info = await discoverOAuth(`${s.base}/`);
      expect(info).toEqual({
        authorizationEndpoint: `${s.base}/authorize`,
        tokenEndpoint: `${s.base}/token`,
        registrationEndpoint: `${s.base}/register`,
        resource: `${s.base}/`,
        scope: undefined,
      });
    } finally {
      await s.close();
    }
  });

  it("survives unreachable metadata and refuses a server without S256", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await discoverOAuth("https://m/", {}, failing)).tokenEndpoint).toBe("https://m/token");

    const s = await fakeServer({
      "/.well-known/oauth-authorization-server": json(200, {
        authorization_endpoint: "https://a/auth",
        token_endpoint: "https://a/tok",
        code_challenge_methods_supported: ["plain"],
      }),
    });
    try {
      await expect(discoverOAuth(`${s.base}/`)).rejects.toThrow(/does not support PKCE with S256/);
    } finally {
      await s.close();
    }
  });
});

describe("registerClient", () => {
  it("registers a public client for the redirect", async () => {
    const s = await fakeServer({
      "/reg": json(201, { client_id: "cid", client_secret: "sec", token_endpoint_auth_method: "client_secret_basic" }),
    });
    try {
      const client = await registerClient(
        { authorizationEndpoint: "", tokenEndpoint: "", registrationEndpoint: `${s.base}/reg`, scope: "a" },
        "http://127.0.0.1:1/callback",
      );
      expect(client).toEqual({ clientId: "cid", clientSecret: "sec", authMethod: "client_secret_basic" });
      expect(JSON.parse(s.calls[0].body)).toMatchObject({
        client_name: "acp-gateway",
        redirect_uris: ["http://127.0.0.1:1/callback"],
        token_endpoint_auth_method: "none",
        scope: "a",
      });
    } finally {
      await s.close();
    }
  });

  it("explains a server without registration, or one that refuses it", async () => {
    await expect(registerClient({ authorizationEndpoint: "", tokenEndpoint: "" }, "r")).rejects.toThrow(
      /does not let clients register themselves/,
    );
    const s = await fakeServer({
      "/reg": json(400, { error: "invalid_redirect_uri", error_description: "no loopback" }),
      "/text": (_q, _b, res) => res.writeHead(500).end("boom"),
      "/null": json(201, null),
    });
    try {
      await expect(
        registerClient({ authorizationEndpoint: "", tokenEndpoint: "", registrationEndpoint: `${s.base}/reg` }, "r"),
      ).rejects.toThrow("Registering acp-gateway with the authorization server failed: 400 invalid_redirect_uri: no loopback");
      await expect(
        registerClient({ authorizationEndpoint: "", tokenEndpoint: "", registrationEndpoint: `${s.base}/text` }, "r"),
      ).rejects.toThrow("failed: 500");
      await expect(
        registerClient({ authorizationEndpoint: "", tokenEndpoint: "", registrationEndpoint: `${s.base}/null` }, "r"),
      ).rejects.toThrow("failed: 201");
    } finally {
      await s.close();
    }
  });
});

describe("openLoopbackReceiver", () => {
  it("takes the browser's redirect and ignores anything else", async () => {
    const receiver = await openLoopbackReceiver();
    try {
      expect(receiver.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect((await fetch(receiver.redirectUri.replace("/callback", "/favicon.ico"))).status).toBe(404);
      expect((await fetch(receiver.redirectUri)).status).toBe(404);
      const res = await fetch(`${receiver.redirectUri}?code=abc&state=s`);
      expect(await res.text()).toMatch(/You can close this tab/);
      expect((await receiver.answer).get("code")).toBe("abc");
    } finally {
      receiver.close();
    }
  });
});

describe("refreshStored", () => {
  const base: StoredMcpAuth = {
    clientId: "cid",
    tokenEndpoint: "",
    resource: "https://m/",
    accessToken: "old",
    refreshToken: "r1",
    expiresAt: 0,
  };

  it("swaps the refresh token for a new access token, keeping the refresh token when none is returned", async () => {
    const s = await fakeServer({ "/tok": json(200, { access_token: "new", expires_in: 60 }) });
    try {
      const next = await refreshStored({ ...base, tokenEndpoint: `${s.base}/tok` }, fetch, () => 1000);
      expect(next).toMatchObject({ accessToken: "new", refreshToken: "r1", expiresAt: 61_000 });
      const form = new URLSearchParams(s.calls[0].body);
      expect(Object.fromEntries(form)).toEqual({
        grant_type: "refresh_token",
        refresh_token: "r1",
        resource: "https://m/",
        client_id: "cid",
      });
    } finally {
      await s.close();
    }
  });

  it("authenticates a confidential client as it registered", async () => {
    const s = await fakeServer({ "/tok": json(200, { access_token: "new", refresh_token: "r2" }) });
    try {
      const basic = await refreshStored(
        { ...base, tokenEndpoint: `${s.base}/tok`, clientSecret: "sec", authMethod: "client_secret_basic" },
        fetch,
        () => 0,
      );
      expect(basic).toMatchObject({ refreshToken: "r2", expiresAt: undefined });
      expect(s.calls[0].headers.authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
      expect(new URLSearchParams(s.calls[0].body).has("client_id")).toBe(false);

      await refreshStored({ ...base, tokenEndpoint: `${s.base}/tok`, clientSecret: "sec" }, fetch, () => 0);
      expect(new URLSearchParams(s.calls[1].body).get("client_secret")).toBe("sec");
    } finally {
      await s.close();
    }
  });

  it("says why the token endpoint refused, without the tokens", async () => {
    const s = await fakeServer({ "/tok": json(400, { error: "invalid_grant" }) });
    try {
      await expect(refreshStored({ ...base, tokenEndpoint: `${s.base}/tok` }, fetch, () => 0)).rejects.toThrow(
        "The token endpoint refused: 400 invalid_grant",
      );
    } finally {
      await s.close();
    }
  });
});

/** An MCP server that wants a login, with everything a full sign-in needs. */
async function oauthServer({ scopes }: { scopes?: string[] } = { scopes: ["mcp"] }) {
  let base = "";
  const s = await fakeServer({
    "/mcp": (_q, _b, res) => {
      res
        .writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
        .end();
    },
    "/.well-known/oauth-protected-resource/mcp": (_q, _b, res) =>
      json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: scopes })(_q, _b, res),
    "/.well-known/oauth-authorization-server": (_q, _b, res) =>
      json(200, {
        authorization_endpoint: `${base}/authorize?tenant=1`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        code_challenge_methods_supported: ["S256"],
      })(_q, _b, res),
    "/register": json(201, { client_id: "cid" }),
    "/token": json(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }),
  });
  base = s.base;
  return s;
}

/** Plays the browser: follows the printed URL to the redirect, as a provider would. */
function browserFrom(lines: string[], extra: Record<string, string> = {}) {
  const printed = lines.join("\n").match(/https?:\/\/\S+authorize\S+/)![0];
  const auth = new URL(printed);
  const back = new URL(auth.searchParams.get("redirect_uri")!);
  back.searchParams.set("code", "the-code");
  back.searchParams.set("state", auth.searchParams.get("state")!);
  for (const [k, v] of Object.entries(extra)) back.searchParams.set(k, v);
  return { auth, back };
}

describe("mcpLogin", () => {
  it("signs in through the browser's loopback redirect and saves the tokens", async () => {
    const s = await oauthServer();
    const lines: string[] = [];
    let auth: URL | undefined;
    const print = (line: string) => {
      lines.push(line);
      if (/authorize/.test(line)) {
        const b = browserFrom(lines);
        auth = b.auth;
        void fetch(b.back);
      }
    };
    try {
      const server: McpServerConfig = { name: "docs", type: "http", url: `${s.base}/mcp` };
      await mcpLogin(server, { storePath: store, print, interactive: false, now: () => 5 });

      expect(auth!.searchParams.get("tenant")).toBe("1");
      expect(Object.fromEntries(auth!.searchParams)).toMatchObject({
        response_type: "code",
        client_id: "cid",
        code_challenge_method: "S256",
        resource: `${s.base}/mcp`,
        scope: "mcp",
      });
      const tokenCall = s.calls.find((c) => c.path === "/token")!;
      const form = new URLSearchParams(tokenCall.body);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("the-code");
      expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(
        auth!.searchParams.get("code_challenge"),
      );
      expect(readTokenStore(store)[`${s.base}/mcp`]).toEqual({
        clientId: "cid",
        clientSecret: undefined,
        authMethod: undefined,
        tokenEndpoint: `${s.base}/token`,
        resource: `${s.base}/mcp`,
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 5 + 3600_000,
      });
      expect(lines.join("\n")).not.toContain("at\"");
      expect(lines.at(-1)).toMatch(/Signed in to "docs"/);
    } finally {
      await s.close();
    }
  });

  it("takes the address pasted from a browser on another computer", async () => {
    const s = await oauthServer({});
    const lines: string[] = [];
    const answers: string[] = [];
    const ask = vi.fn(async (_q: string, signal: AbortSignal) => {
      const next = answers.shift();
      if (next !== undefined) return next;
      return new Promise<string>((_r, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const print = (line: string) => {
      lines.push(line);
      if (/authorize/.test(line)) {
        const { back } = browserFrom(lines);
        answers.push("not a url at all ::", `http://127.0.0.1:1/elsewhere?code=x`, back.href);
      }
    };
    try {
      await mcpLogin({ name: "docs", type: "http", url: `${s.base}/mcp` }, { storePath: store, print, ask, interactive: true });
      expect(readTokenStore(store)[`${s.base}/mcp`].accessToken).toBe("at");
      expect(lines.join("\n")).not.toMatch(/[?&]scope=/);
      expect(lines.filter((l) => /That is not an address/.test(l))).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("stops asking once the browser on this machine finishes, and after three bad answers", async () => {
    const s = await oauthServer();
    const lines: string[] = [];
    const ask = vi.fn(async () => "nope");
    const print = (line: string) => {
      lines.push(line);
      if (/authorize/.test(line)) setTimeout(() => void fetch(browserFrom(lines).back), 20);
    };
    try {
      await mcpLogin({ name: "docs", type: "http", url: `${s.base}/mcp` }, { storePath: store, print, ask, interactive: true });
      expect(ask).toHaveBeenCalledTimes(3);
    } finally {
      await s.close();
    }
  });

  it("stops waiting for a pasted address when the browser here finishes first", async () => {
    const s = await oauthServer();
    const lines: string[] = [];
    let aborted = false;
    const ask = vi.fn(
      (_q: string, signal: AbortSignal) =>
        new Promise<string>((_r, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }),
        ),
    );
    const print = (line: string) => {
      lines.push(line);
      if (/authorize/.test(line)) setTimeout(() => void fetch(browserFrom(lines).back), 20);
    };
    try {
      await mcpLogin({ name: "docs", type: "http", url: `${s.base}/mcp` }, { storePath: store, print, ask, interactive: true });
      expect(aborted).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("refuses a redirect with the wrong state, or a refusal from the provider", async () => {
    const s = await oauthServer();
    try {
      for (const [extra, message] of [
        [{ state: "forged" }, /different state/],
        [{ error: "access_denied", error_description: "nope" }, /The sign-in was refused: access_denied: nope/],
        [{ error: "access_denied" }, /The sign-in was refused: access_denied$/],
      ] as const) {
        const lines: string[] = [];
        const print = (line: string) => {
          lines.push(line);
          if (/authorize/.test(line)) void fetch(browserFrom(lines, extra).back);
        };
        await expect(
          mcpLogin({ name: "docs", type: "http", url: `${s.base}/mcp` }, { storePath: store, print, interactive: false }),
        ).rejects.toThrow(message);
      }
      expect(existsSync(store)).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("times out when nobody signs in", async () => {
    const s = await oauthServer();
    try {
      await expect(
        mcpLogin({ name: "docs", type: "http", url: `${s.base}/mcp` }, { storePath: store, print: () => {}, interactive: false, timeoutMs: 10 }),
      ).rejects.toThrow(/No sign-in arrived within/);
    } finally {
      await s.close();
    }
  });

  it("has nothing to do for a server that lets it in, or one run as a command", async () => {
    const s = await fakeServer({ "/mcp": json(200, {}) });
    const print = vi.fn();
    try {
      await mcpLogin({ name: "open", type: "http", url: `${s.base}/mcp` }, { storePath: store, print });
      expect(print).toHaveBeenCalledWith(expect.stringMatching(/"open" let acp-gateway in without a login/));
      await expect(mcpLogin({ name: "local", type: "stdio", command: "x" }, { storePath: store, print })).rejects.toThrow(
        /runs as a local command/,
      );
    } finally {
      await s.close();
    }
  });

  it("prints to stderr by default", async () => {
    const s = await fakeServer({ "/mcp": json(200, {}) });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mcpLogin({ name: "open", type: "http", url: `${s.base}/mcp` }, { storePath: store });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/without a login/));
    } finally {
      errorSpy.mockRestore();
      await s.close();
    }
  });
});

describe("mcpLogout", () => {
  it("forgets a saved login, and says when there was none", () => {
    const print = vi.fn();
    const server: McpServerConfig = { name: "docs", type: "http", url: "https://m/" };
    writeTokenStore(store, { "https://m/": { clientId: "c", tokenEndpoint: "t", accessToken: "a" }, "https://o/": { clientId: "c", tokenEndpoint: "t", accessToken: "b" } });
    mcpLogout(server, { storePath: store, print });
    expect(Object.keys(readTokenStore(store))).toEqual(["https://o/"]);
    expect(print).toHaveBeenLastCalledWith(expect.stringMatching(/Signed out of "docs"/));
    mcpLogout(server, { storePath: store, print });
    expect(print).toHaveBeenLastCalledWith(expect.stringMatching(/had no saved login for "docs"/));
    mcpLogout({ name: "local", type: "stdio", command: "x" }, { storePath: store, print });
    expect(print).toHaveBeenLastCalledWith(expect.stringMatching(/had no saved login for "local"/));
  });
});

describe("authorizeMcpServers", () => {
  const entry = (over: Partial<StoredMcpAuth> = {}): StoredMcpAuth => ({
    clientId: "cid",
    tokenEndpoint: "https://as/token",
    accessToken: "at",
    ...over,
  });
  const tokenFetch = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("hands over a saved token, leaving stdio, the AgentRQ server and servers with their own Authorization alone", async () => {
    writeTokenStore(store, {
      "https://m/": entry(),
      "https://own/": entry(),
      "https://agentrq/": entry(),
    });
    const configs: McpServerConfig[] = [
      { name: "m", type: "http", url: "https://m/", headers: { "X-A": "1" } },
      { name: "own", type: "sse", url: "https://own/", headers: { authorization: "Bearer mine" } },
      { name: "agentrq-workspace", type: "http", url: "https://agentrq/" },
      { name: "local", type: "stdio", command: "x" },
    ];
    const fetchImpl = vi.fn();
    const stop = await authorizeMcpServers(configs, { storePath: store, fetch: fetchImpl as any, skip: "agentrq-workspace", now: () => 0 });
    stop();
    expect(configs[0].headers).toEqual({ "X-A": "1", Authorization: "Bearer at" });
    expect(configs[1].headers).toEqual({ authorization: "Bearer mine" });
    expect(configs[2].headers).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("warns about a server that needs a login, and stays quiet about one it cannot reach", async () => {
    const print = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("down")) throw new TypeError("fetch failed");
      if (url.includes("open")) return new Response("{}", { status: 200 });
      return new Response("", { status: 401 });
    });
    const configs: McpServerConfig[] = [
      { name: "locked", type: "http", url: "https://locked/" },
      { name: "open", type: "http", url: "https://open/" },
      { name: "down", type: "http", url: "https://down/" },
    ];
    await authorizeMcpServers(configs, { storePath: store, fetch: fetchImpl as any, print });
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith(needsLoginMessage("locked"));
    expect(needsLoginMessage("locked")).toMatch(/acp-gateway --mcp-login locked/);
    expect(configs.every((c) => c.headers === undefined)).toBe(true);
  });

  it("refreshes a token about to expire before handing it over, and saves it", async () => {
    writeTokenStore(store, { "https://m/": entry({ refreshToken: "rt", expiresAt: 30_000 }) });
    const configs: McpServerConfig[] = [{ name: "m", type: "http", url: "https://m/" }];
    const fetchImpl = tokenFetch({ access_token: "fresh", expires_in: 3600 });
    const stop = await authorizeMcpServers(configs, { storePath: store, fetch: fetchImpl as any, now: () => 0 });
    stop();
    expect(configs[0].headers).toEqual({ Authorization: "Bearer fresh" });
    expect(readTokenStore(store)["https://m/"]).toMatchObject({ accessToken: "fresh", refreshToken: "rt", expiresAt: 3600_000 });
  });

  it("asks for a new login when an expired token cannot be refreshed", async () => {
    const print = vi.fn();
    writeTokenStore(store, {
      "https://norefresh/": entry({ expiresAt: 1 }),
      "https://refused/": entry({ refreshToken: "rt", expiresAt: 1 }),
    });
    const configs: McpServerConfig[] = [
      { name: "norefresh", type: "http", url: "https://norefresh/" },
      { name: "refused", type: "http", url: "https://refused/" },
    ];
    await authorizeMcpServers(configs, { storePath: store, fetch: tokenFetch({ error: "invalid_grant" }, 400) as any, now: () => 0, print });
    expect(print).toHaveBeenCalledWith(expect.stringMatching(/login for MCP server "norefresh" has expired.*--mcp-login norefresh/));
    expect(print).toHaveBeenCalledWith(
      expect.stringMatching(/Could not refresh the login for MCP server "refused" \(The token endpoint refused: 400 invalid_grant\).*--mcp-login refused/),
    );
    expect(configs.every((c) => c.headers === undefined)).toBe(true);
  });

  it("keeps the token fresh while the gateway runs", async () => {
    vi.useFakeTimers();
    let clock = 0;
    writeTokenStore(store, { "https://m/": entry({ refreshToken: "rt", expiresAt: 600_000 }) });
    const configs: McpServerConfig[] = [{ name: "m", type: "http", url: "https://m/" }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "second", expires_in: 600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const print = vi.fn();
    const stop = await authorizeMcpServers(configs, { storePath: store, fetch: fetchImpl, now: () => clock, print });
    expect(configs[0].headers).toEqual({ Authorization: "Bearer at" });

    clock = 540_000;
    await vi.advanceTimersByTimeAsync(540_000);
    expect(configs[0].headers).toEqual({ Authorization: "Bearer second" });

    clock = 1_080_000;
    await vi.advanceTimersByTimeAsync(540_000);
    expect(print).toHaveBeenCalledWith(expect.stringMatching(/Could not refresh the login for MCP server "m"/));
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("does not schedule a refresh it could not make, and stop cancels the one it did", async () => {
    vi.useFakeTimers();
    writeTokenStore(store, {
      "https://a/": entry({ expiresAt: 10_000_000 }),
      "https://b/": entry({ refreshToken: "rt" }),
      "https://c/": entry({ refreshToken: "rt", expiresAt: 10_000_000 }),
    });
    const configs: McpServerConfig[] = ["a", "b", "c"].map((n) => ({ name: n, type: "http", url: `https://${n}/` }));
    const stop = await authorizeMcpServers(configs, { storePath: store, fetch: vi.fn(), now: () => 0 });
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the default store, fetch, clock and printer when given none", async () => {
    const xdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      const stop = await authorizeMcpServers([]);
      stop();
    } finally {
      if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = xdg;
    }
  });
});
