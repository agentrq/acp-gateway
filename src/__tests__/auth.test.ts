import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { followAgentStderr } from "../log.js";
import {
  AUTH_REQUIRED_CODE,
  authMethodType,
  describeAuthMethods,
  findLoopbackRedirect,
  isAuthRequiredError,
  login,
  logout,
  pickAuthMethod,
  promptForAuthMethod,
  promptUrlElicitationOnTerminal,
  redirectToDeliver,
  relayLoopbackRedirect,
  runAuthMethod,
  runTerminalAuth,
  supportsLogout,
} from "../auth.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

const spawnMock = vi.mocked(spawn);
const createInterfaceMock = vi.mocked(createInterface);

const agentMethod: any = {
  id: "agent-login",
  name: "Agent login",
  description: "Sign in through the agent",
};
const terminalMethod: any = {
  type: "terminal",
  id: "cli-login",
  name: "CLI login",
  args: ["auth", "login"],
  env: { AUTH_MODE: "interactive" },
};

const launch = { command: "gemini", args: ["--acp"], env: { FROM_CONFIG: "1" } };

/** An `auth_required` refusal as the SDK surfaces it to the caller. */
function authRequiredError(): Error & { code: number } {
  return Object.assign(new Error("Authentication required: run login first"), {
    code: AUTH_REQUIRED_CODE,
  });
}

describe("auth", () => {
  let errorSpy: any;
  let logSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  describe("authMethodType", () => {
    it("treats a missing type as the agent-driven default", () => {
      expect(authMethodType(agentMethod)).toBe("agent");
      expect(authMethodType({ ...agentMethod, type: "agent" } as any)).toBe("agent");
    });

    it("recognises terminal methods", () => {
      expect(authMethodType(terminalMethod)).toBe("terminal");
    });
  });

  describe("describeAuthMethods", () => {
    it("says so when the agent needs no login", () => {
      expect(describeAuthMethods([])).toMatch(/no authentication methods/);
      expect(describeAuthMethods(undefined)).toMatch(/no authentication methods/);
      expect(describeAuthMethods(null)).toMatch(/no authentication methods/);
    });

    it("numbers the methods and marks terminal ones", () => {
      const text = describeAuthMethods([agentMethod, terminalMethod]);
      expect(text).toContain("1. Agent login (agent-login) — Sign in through the agent");
      expect(text).toContain("2. CLI login (cli-login) [terminal login]");
    });
  });

  describe("isAuthRequiredError", () => {
    it("recognises the protocol's auth_required refusal", () => {
      expect(isAuthRequiredError(authRequiredError())).toBe(true);
    });

    it("reads the error out of a nested JSON-RPC envelope", () => {
      expect(
        isAuthRequiredError({
          error: { code: AUTH_REQUIRED_CODE, message: "auth_required" },
        }),
      ).toBe(true);
    });

    it("reads the top level when `error` is not an envelope", () => {
      expect(
        isAuthRequiredError({
          error: "auth_required",
          code: AUTH_REQUIRED_CODE,
          message: "Authentication required",
        }),
      ).toBe(true);
    });

    it("ignores other failures that share the -32000 code", () => {
      expect(
        isAuthRequiredError(
          Object.assign(new Error("permission failed"), { code: AUTH_REQUIRED_CODE }),
        ),
      ).toBe(false);
    });

    it("ignores errors with a different code or no shape at all", () => {
      expect(
        isAuthRequiredError(Object.assign(new Error("Authentication required"), { code: -32603 })),
      ).toBe(false);
      expect(isAuthRequiredError({ code: AUTH_REQUIRED_CODE })).toBe(false);
      expect(isAuthRequiredError(new Error("Authentication required"))).toBe(false);
      expect(isAuthRequiredError("nope")).toBe(false);
      expect(isAuthRequiredError(null)).toBe(false);
    });
  });

  describe("pickAuthMethod", () => {
    it("returns nothing when the agent advertises no methods", () => {
      expect(pickAuthMethod([])).toBeUndefined();
      expect(pickAuthMethod(undefined)).toBeUndefined();
    });

    it("honours an explicitly named method, terminal included", () => {
      expect(pickAuthMethod([agentMethod, terminalMethod], { preferredId: "cli-login" })).toBe(
        terminalMethod,
      );
    });

    it("returns nothing when the named method is not advertised", () => {
      expect(pickAuthMethod([agentMethod], { preferredId: "missing" })).toBeUndefined();
    });

    it("prefers agent-driven methods, which need no human", () => {
      expect(pickAuthMethod([terminalMethod, agentMethod])).toBe(agentMethod);
    });

    it("falls back to a terminal method only when a terminal is available", () => {
      expect(pickAuthMethod([terminalMethod])).toBeUndefined();
      expect(pickAuthMethod([terminalMethod], { allowTerminal: true })).toBe(terminalMethod);
    });
  });

  describe("promptForAuthMethod", () => {
    it("returns nothing when there is nothing to choose from", async () => {
      expect(await promptForAuthMethod([], vi.fn())).toBeUndefined();
    });

    it("does not ask when the agent offers a single method", async () => {
      const ask = vi.fn();
      expect(await promptForAuthMethod([agentMethod], ask)).toBe(agentMethod);
      expect(ask).not.toHaveBeenCalled();
    });

    it("takes the first method when the user just hits enter", async () => {
      const ask = vi.fn().mockResolvedValue("  ");
      expect(await promptForAuthMethod([agentMethod, terminalMethod], ask)).toBe(agentMethod);
    });

    it("accepts a selection by number", async () => {
      const ask = vi.fn().mockResolvedValue("2");
      expect(await promptForAuthMethod([agentMethod, terminalMethod], ask)).toBe(terminalMethod);
    });

    it("accepts a selection by method id", async () => {
      const ask = vi.fn().mockResolvedValue("cli-login");
      expect(await promptForAuthMethod([agentMethod, terminalMethod], ask)).toBe(terminalMethod);
    });

    it("re-asks after an answer that matches nothing", async () => {
      const ask = vi.fn().mockResolvedValueOnce("99").mockResolvedValueOnce("1");
      expect(await promptForAuthMethod([agentMethod, terminalMethod], ask)).toBe(agentMethod);
      expect(ask).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith('[auth] "99" is not one of the listed methods.');
    });

    it("gives up after three unusable answers", async () => {
      const ask = vi.fn().mockResolvedValue("nonsense");
      expect(await promptForAuthMethod([agentMethod, terminalMethod], ask)).toBeUndefined();
      expect(ask).toHaveBeenCalledTimes(3);
    });

    it("asks on the terminal when no asker is supplied", async () => {
      const close = vi.fn();
      createInterfaceMock.mockReturnValue({
        question: vi.fn().mockResolvedValue("2"),
        close,
      } as any);

      expect(await promptForAuthMethod([agentMethod, terminalMethod])).toBe(terminalMethod);
      expect(createInterfaceMock).toHaveBeenCalledWith({
        input: process.stdin,
        output: process.stderr,
      });
      expect(close).toHaveBeenCalled();
    });
  });

  describe("promptUrlElicitationOnTerminal", () => {
    const request = {
      message: "Sign in and enter code ABCD",
      url: "https://auth.openai.com/codex/device",
    };

    it("accepts once the human says they are done", async () => {
      const close = vi.fn();
      const question = vi.fn().mockResolvedValue("");
      createInterfaceMock.mockReturnValue({ question, close } as any);

      const signal = new AbortController().signal;
      await expect(promptUrlElicitationOnTerminal({ ...request, signal })).resolves.toEqual({
        action: "accept",
      });
      expect(createInterfaceMock).toHaveBeenCalledWith({
        input: process.stdin,
        output: process.stderr,
      });
      expect(question).toHaveBeenCalledWith(expect.stringContaining("Press Enter"), { signal });
      expect(close).toHaveBeenCalled();
    });

    it("cancels, without closing over a refusal, when the wait is aborted", async () => {
      const close = vi.fn();
      createInterfaceMock.mockReturnValue({
        question: vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })),
        close,
      } as any);

      const signal = new AbortController().signal;
      await expect(promptUrlElicitationOnTerminal({ ...request, signal })).resolves.toEqual({
        action: "cancel",
      });
      expect(close).toHaveBeenCalled();
    });
  });

  describe("runTerminalAuth", () => {
    it("re-runs the agent invocation with the method's args and env", async () => {
      const child = new EventEmitter();
      spawnMock.mockReturnValue(child as any);

      const pending = runTerminalAuth(terminalMethod, launch);
      child.emit("exit", 0, null);
      await expect(pending).resolves.toBeUndefined();

      expect(spawnMock).toHaveBeenCalledWith(
        "gemini",
        ["--acp", "auth", "login"],
        expect.objectContaining({
          stdio: "inherit",
          env: expect.objectContaining({ FROM_CONFIG: "1", AUTH_MODE: "interactive" }),
        }),
      );
    });

    it("passes no extra args or env when the method declares none", async () => {
      const child = new EventEmitter();
      spawnMock.mockReturnValue(child as any);

      const pending = runTerminalAuth({ ...agentMethod, type: "terminal" } as any, {
        command: "gemini",
        args: ["--acp"],
      });
      child.emit("exit", 0, null);
      await pending;

      expect(spawnMock).toHaveBeenCalledWith("gemini", ["--acp"], expect.anything());
    });

    it("fails when the login process exits non-zero", async () => {
      const child = new EventEmitter();
      spawnMock.mockReturnValue(child as any);

      const pending = runTerminalAuth(terminalMethod, launch);
      child.emit("exit", 1, null);
      await expect(pending).rejects.toThrow(/Terminal login "cli-login" failed \(code=1/);
    });

    it("fails when the login process cannot start", async () => {
      const child = new EventEmitter();
      spawnMock.mockReturnValue(child as any);

      const pending = runTerminalAuth(terminalMethod, launch);
      child.emit("error", new Error("ENOENT"));
      await expect(pending).rejects.toThrow(/failed to start: ENOENT/);
    });
  });

  describe("runAuthMethod", () => {
    it("asks the agent to authenticate for agent-driven methods", async () => {
      const connection = { authenticate: vi.fn().mockResolvedValue({}), logout: vi.fn() };
      await runAuthMethod(connection, agentMethod, launch);
      expect(connection.authenticate).toHaveBeenCalledWith({ methodId: "agent-login" });
    });

    it("shows what the agent prints while it waits for the login", async () => {
      // antigravity on a headless machine prints its login URL to stderr and
      // nowhere else, then holds `authenticate` open until the browser is done.
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stderr = new PassThrough();
      const tail = followAgentStderr(stderr);
      const connection = {
        authenticate: vi.fn(async () => {
          stderr.emit("data", "Open the following link to authenticate: https://example.test\n");
          return {};
        }),
        logout: vi.fn(),
      };
      await runAuthMethod(connection, agentMethod, launch);
      expect(writeSpy).toHaveBeenCalledWith(
        "Open the following link to authenticate: https://example.test\n",
      );
      expect(tail()).toBe("");
      writeSpy.mockRestore();
    });

    it("never sends a terminal method to authenticate", async () => {
      const child = new EventEmitter();
      spawnMock.mockReturnValue(child as any);
      const connection = { authenticate: vi.fn(), logout: vi.fn() };

      const pending = runAuthMethod(connection, terminalMethod, launch);
      child.emit("exit", 0, null);
      await pending;

      expect(connection.authenticate).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalled();
    });
  });

  describe("loopback redirects", () => {
    // What antigravity prints on stderr for its Google sign-in.
    const signInLine = (port: number) =>
      "Open the following link to authenticate the ACP server: " +
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc" +
      `&redirect_uri=http%3A%2F%2F127.0.0.1%3A${port}%2F&scope=email&state=xyz\n`;
    const browserAddress = (port: number) =>
      `http://127.0.0.1:${port}/?state=xyz&iss=https://accounts.google.com&code=4/0AX-yz&scope=email`;

    /** A stand-in for the agent's one-shot redirect server. */
    async function agentServer(): Promise<{
      port: number;
      received: Promise<string>;
      close: () => Promise<void>;
    }> {
      let receive!: (url: string) => void;
      const received = new Promise<string>((resolve) => (receive = resolve));
      const server = createServer((req, res) => {
        receive(req.url ?? "");
        res.writeHead(302, { Location: "http://127.0.0.1:1/picker" }).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      return {
        port,
        received,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }

    describe("findLoopbackRedirect", () => {
      it("finds the agent's redirect server in its sign-in URL", () => {
        expect(findLoopbackRedirect(signInLine(37207))?.href).toBe("http://127.0.0.1:37207/");
        expect(
          findLoopbackRedirect("go to https://x.test/auth?redirect_uri=http://localhost:9/cb now")
            ?.href,
        ).toBe("http://localhost:9/cb");
        expect(
          findLoopbackRedirect("https://x.test/auth?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A9%2F")
            ?.host,
        ).toBe("[::1]:9");
      });

      it("ignores URLs that do not come back to this machine", () => {
        expect(findLoopbackRedirect("nothing to open here")).toBeUndefined();
        expect(findLoopbackRedirect("https://x.test/device")).toBeUndefined();
        expect(findLoopbackRedirect("https://x.test/a?redirect_uri=not%20a%20url")).toBeUndefined();
        expect(
          findLoopbackRedirect("https://x.test/a?redirect_uri=https%3A%2F%2Fapp.test%2Fcb"),
        ).toBeUndefined();
        expect(
          findLoopbackRedirect("https://x.test/a?redirect_uri=https%3A%2F%2F127.0.0.1%3A9%2F"),
        ).toBeUndefined();
      });
    });

    describe("redirectToDeliver", () => {
      const redirect = new URL("http://127.0.0.1:37207/");

      it("takes the provider's answer from the pasted address", () => {
        expect(redirectToDeliver(`  ${browserAddress(37207)}\n`, redirect)?.href).toBe(
          browserAddress(37207),
        );
        expect(redirectToDeliver("?state=xyz&code=abc", redirect)?.href).toBe(
          "http://127.0.0.1:37207/?state=xyz&code=abc",
        );
        expect(redirectToDeliver("http://127.0.0.1:37207?error=access_denied", redirect)?.href).toBe(
          "http://127.0.0.1:37207/?error=access_denied",
        );
      });

      it("turns away anything that is not the agent's redirect", () => {
        expect(redirectToDeliver("", redirect)).toBeUndefined();
        expect(redirectToDeliver("http://[", redirect)).toBeUndefined();
        expect(redirectToDeliver(browserAddress(1234), redirect)).toBeUndefined();
        expect(redirectToDeliver("http://127.0.0.1:37207/other?code=abc", redirect)).toBeUndefined();
        expect(redirectToDeliver("http://evil.test:37207/?code=abc", redirect)).toBeUndefined();
        expect(redirectToDeliver("http://127.0.0.1:37207/?state=xyz", redirect)).toBeUndefined();
      });
    });

    describe("relayLoopbackRedirect", () => {
      it("re-asks for a wrong address, then hands the right one to the agent", async () => {
        const agent = await agentServer();
        try {
          const ask = vi
            .fn()
            .mockResolvedValueOnce(`http://127.0.0.1:${agent.port}/?state=xyz`)
            .mockResolvedValueOnce(browserAddress(agent.port));
          const signal = new AbortController().signal;
          await relayLoopbackRedirect(new URL(`http://127.0.0.1:${agent.port}/`), signal, ask);

          const pasted = new URL(browserAddress(agent.port));
          expect(await agent.received).toBe(pasted.pathname + pasted.search);
          expect(ask).toHaveBeenCalledTimes(2);
          expect(ask).toHaveBeenCalledWith(expect.stringContaining("Address the browser"), signal);
          expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("with a code in it"));
          expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Handed the sign-in"));
        } finally {
          await agent.close();
        }
      });

      it("says so when the agent is no longer listening", async () => {
        const agent = await agentServer();
        await agent.close();
        await relayLoopbackRedirect(
          new URL(`http://127.0.0.1:${agent.port}/`),
          new AbortController().signal,
          vi.fn().mockResolvedValue(browserAddress(agent.port)),
        );
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not reach the agent"));
      });

      it("gives up after three wrong addresses", async () => {
        const ask = vi.fn().mockResolvedValue("nonsense");
        await relayLoopbackRedirect(
          new URL("http://127.0.0.1:9/"),
          new AbortController().signal,
          ask,
        );
        expect(ask).toHaveBeenCalledTimes(3);
      });

      it("stops asking once the login finishes by itself", async () => {
        const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const done = new AbortController();
        const ask = vi.fn((_q: string, signal: AbortSignal) => {
          done.abort();
          return Promise.reject(signal.reason);
        });
        await relayLoopbackRedirect(new URL("http://127.0.0.1:9/"), done.signal, ask);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(writeSpy).toHaveBeenCalledWith("\n");

        // stdin closing ends it too, without the line break.
        writeSpy.mockClear();
        await relayLoopbackRedirect(
          new URL("http://127.0.0.1:9/"),
          new AbortController().signal,
          vi.fn().mockRejectedValue(new Error("closed")),
        );
        expect(writeSpy).not.toHaveBeenCalled();
        writeSpy.mockRestore();
      });

      it("asks on the terminal by default", async () => {
        const close = vi.fn();
        const question = vi.fn().mockResolvedValue("nonsense");
        createInterfaceMock.mockReturnValue({ question, close } as any);
        const signal = new AbortController().signal;

        await relayLoopbackRedirect(new URL("http://127.0.0.1:9/"), signal);
        expect(createInterfaceMock).toHaveBeenCalledWith({
          input: process.stdin,
          output: process.stderr,
        });
        expect(question).toHaveBeenCalledWith(expect.stringContaining("Address the browser"), {
          signal,
        });
        expect(close).toHaveBeenCalledTimes(3);
      });
    });

    describe("runAuthMethod", () => {
      let writeSpy: any;
      beforeEach(() => {
        writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      });
      afterEach(() => writeSpy.mockRestore());

      it("finishes a browser login from another computer with the pasted address", async () => {
        const agent = await agentServer();
        try {
          const stderr = new PassThrough();
          followAgentStderr(stderr);
          const connection = {
            authenticate: vi.fn(async () => {
              // Split mid-URL, the way a pipe can deliver it.
              const line = signInLine(agent.port);
              stderr.emit("data", line.slice(0, 120));
              stderr.emit("data", line.slice(120));
              stderr.emit("data", "I1010 still waiting for the browser\n");
              // The agent's login ends once its server has had the redirect.
              await agent.received;
              return {};
            }),
            logout: vi.fn(),
          };
          const askUntil = vi.fn().mockResolvedValue(browserAddress(agent.port));

          await runAuthMethod(connection, agentMethod, launch, { interactive: true, askUntil });
          expect(askUntil).toHaveBeenCalledTimes(1);
          expect(await agent.received).toContain("code=4/0AX-yz");
          expect(writeSpy).toHaveBeenCalledWith(signInLine(agent.port).slice(0, 120));
        } finally {
          await agent.close();
        }
      });

      it("stops asking when the browser reached the agent by itself", async () => {
        const stderr = new PassThrough();
        followAgentStderr(stderr);
        let markAsked!: () => void;
        const asked = new Promise<void>((resolve) => (markAsked = resolve));
        const askUntil = vi.fn(
          (_q: string, signal: AbortSignal) =>
            new Promise<string>((_resolve, reject) => {
              markAsked();
              signal.addEventListener("abort", () => reject(signal.reason));
            }),
        );
        const connection = {
          authenticate: vi.fn(async () => {
            stderr.emit("data", signInLine(37207));
            await asked;
            return {};
          }),
          logout: vi.fn(),
        };
        await runAuthMethod(connection, agentMethod, launch, { interactive: true, askUntil });
        expect(askUntil).toHaveBeenCalledTimes(1);
      });

      it("does not ask with nobody at the terminal", async () => {
        const stderr = new PassThrough();
        followAgentStderr(stderr);
        const askUntil = vi.fn();
        const connection = {
          authenticate: vi.fn(async () => {
            stderr.emit("data", signInLine(37207));
            return {};
          }),
          logout: vi.fn(),
        };
        await runAuthMethod(connection, agentMethod, launch, { askUntil });
        expect(askUntil).not.toHaveBeenCalled();
        expect(writeSpy).toHaveBeenCalledWith(signInLine(37207));
      });
    });
  });

  describe("login", () => {
    const connection = () => ({ authenticate: vi.fn().mockResolvedValue({}), logout: vi.fn() });

    it("does nothing when the agent advertises no login", async () => {
      const conn = connection();
      expect(await login({ connection: conn, methods: [], launch })).toBeUndefined();
      expect(conn.authenticate).not.toHaveBeenCalled();
    });

    it("logs in with the method the user named", async () => {
      const conn = connection();
      const used = await login({
        connection: conn,
        methods: [agentMethod, { ...agentMethod, id: "other", name: "Other" }],
        launch,
        preferredId: "other",
      });
      expect(used?.id).toBe("other");
      expect(conn.authenticate).toHaveBeenCalledWith({ methodId: "other" });
    });

    it("rejects a method the agent does not advertise", async () => {
      await expect(
        login({ connection: connection(), methods: [agentMethod], launch, preferredId: "nope" }),
      ).rejects.toThrow(/Unknown authentication method "nope"/);
    });

    it("picks an agent-driven method when running unattended", async () => {
      const conn = connection();
      const used = await login({ connection: conn, methods: [terminalMethod, agentMethod], launch });
      expect(used).toBe(agentMethod);
    });

    it("asks the user which method to use when a terminal is available", async () => {
      const conn = connection();
      const ask = vi.fn().mockResolvedValue("1");
      const used = await login({
        connection: conn,
        methods: [agentMethod, terminalMethod],
        launch,
        interactive: true,
        ask,
      });
      expect(used).toBe(agentMethod);
      expect(ask).toHaveBeenCalled();
    });

    it("fails when only a terminal login is offered and no terminal is available", async () => {
      await expect(
        login({ connection: connection(), methods: [terminalMethod], launch }),
      ).rejects.toThrow(/No usable authentication method/);
    });

    it("fails when the user does not choose a method", async () => {
      await expect(
        login({
          connection: connection(),
          methods: [agentMethod, terminalMethod],
          launch,
          interactive: true,
          ask: vi.fn().mockResolvedValue("nonsense"),
        }),
      ).rejects.toThrow(/No usable authentication method/);
    });
  });

  describe("supportsLogout", () => {
    it("is true only when the agent advertises the capability", () => {
      expect(supportsLogout({ auth: { logout: {} } } as any)).toBe(true);
      expect(supportsLogout({ auth: { logout: null } } as any)).toBe(false);
      expect(supportsLogout({ auth: {} } as any)).toBe(false);
      expect(supportsLogout({} as any)).toBe(false);
      expect(supportsLogout(undefined)).toBe(false);
    });
  });

  describe("logout", () => {
    it("skips agents that do not implement logout", async () => {
      const conn = { authenticate: vi.fn(), logout: vi.fn() };
      expect(await logout(conn, {} as any)).toBe(false);
      expect(conn.logout).not.toHaveBeenCalled();
    });

    it("ends the authenticated state when supported", async () => {
      const conn = { authenticate: vi.fn(), logout: vi.fn().mockResolvedValue({}) };
      expect(await logout(conn, { auth: { logout: {} } } as any)).toBe(true);
      expect(conn.logout).toHaveBeenCalledWith({});
    });
  });
});
