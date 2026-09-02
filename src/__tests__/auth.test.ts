import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  AUTH_REQUIRED_CODE,
  authMethodType,
  describeAuthMethods,
  isAuthRequiredError,
  login,
  logout,
  pickAuthMethod,
  promptForAuthMethod,
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
