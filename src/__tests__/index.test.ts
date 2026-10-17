import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setVerbose } from "../log.js";
import { Writable, Readable } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";
import {
  AuthenticationFailed,
  createSessionWithAuth,
  isInteractiveTerminal,
  openAgentConnection,
  agentExitFailed,
  showAgentStderr,
  shouldPrintBanner,
  DEFAULT_MAX_CONCURRENCY,
  parseGatewayArgs,
  assertAgentRunnable,
  helpText,
  isRunnable,
  resolveOnPath,
  spawnTarget,
  needsShell,
  escapeCmdCommand,
  quoteForCmd,
  spawnArgsFor,
  terminateAgentProcess,
  printHelp,
  resolveAgentCommand,
  runListAgents,
  runAgentCommand,
  loadWorkspace,
  makeIsolatedDir,
  WORKSPACE_OPTIONAL_COMMANDS,
  CLOSE_SESSION_TIMEOUT_MS,
  supportsCloseSession,
  closeSession,
  nativeOptionsFor,
  startNativeMode,
  runGateway,
} from "../index.js";
import { AUTH_REQUIRED_CODE } from "../auth.js";
import type { McpServerConfig } from "../config.js";

/**
 * A stand-in for the workspace bridge.
 *
 * The ACP client registers a verdict listener on it as soon as it is built, so
 * a bare object is not enough — the real bridge is an EventEmitter.
 */
function fakeBridge(): any {
  const emitter: any = new EventEmitter();
  emitter.sendNotification = vi.fn().mockResolvedValue(undefined);
  emitter.callTool = vi.fn().mockResolvedValue({ isError: false, content: [] });
  return emitter;
}

// Real emitters so the agent-process lifecycle handlers can be exercised.
const { spawnedAgents } = vi.hoisted(() => ({ spawnedAgents: [] as any[] }));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { Writable, Readable, PassThrough } = await import("node:stream");
  return {
    spawn: vi.fn(() => {
      const child: any = new EventEmitter();
      child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
      child.stdout = new Readable({ read() { this.push(null); } });
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      spawnedAgents.push(child);
      return child;
    }),
  };
});

/** Lets a test make the next `session/new` fail, e.g. with auth_required. */
const { newSessionError, newSessionHangs } = vi.hoisted(() => ({
  newSessionError: { value: null as unknown },
  /** Lets a test make `session/new` never answer, like an agent gone quiet. */
  newSessionHangs: { value: false },
}));

vi.mock("@agentclientprotocol/sdk", async () => {
  const actual = await vi.importActual<typeof import("@agentclientprotocol/sdk")>("@agentclientprotocol/sdk");
  return {
    ...actual,
    ClientSideConnection: vi.fn().mockImplementation(function() {
      return {
        initialize: vi.fn().mockResolvedValue({ protocolVersion: "0.1.0" }),
        newSession: vi.fn().mockImplementation(async () => {
          if (newSessionHangs.value) return new Promise(() => {});
          if (newSessionError.value) throw newSessionError.value;
          return { sessionId: "test-sess-123" };
        }),
        prompt: vi.fn().mockResolvedValue({ stopReason: "complete" }),
      };
    }),
  };
});

describe("index", () => {
  afterEach(() => setVerbose(false));
  describe("openAgentConnection", () => {
    beforeEach(() => {
      spawnedAgents.length = 0;
    });

    it("should pass clientInfo and the url elicitation capability in initialize handshake", async () => {
      const initSpy = vi.fn().mockResolvedValue({
        protocolVersion: "0.1.0",
      });
      vi.mocked(acp.ClientSideConnection).mockImplementationOnce(function () {
        return {
          initialize: initSpy,
        } as any;
      } as any);

      await openAgentConnection({
        acpCmdArgs: ["node", "agent.js"],
        label: "init-test",
      });

      expect(initSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          clientInfo: expect.objectContaining({
            name: "@agentrq/acp-gateway",
            version: expect.any(String),
          }),
          clientCapabilities: expect.objectContaining({
            elicitation: { url: {} },
          }),
        }),
      );
    });

    it("spawns an ordinary agent command directly", async () => {
      const { spawn } = await import("node:child_process");
      await openAgentConnection({
        acpCmdArgs: ["node", "agent.js"],
        label: "spawn-plain",
      });

      expect(vi.mocked(spawn)).toHaveBeenLastCalledWith(
        "node",
        ["agent.js"],
        expect.objectContaining({ shell: false }),
      );
    });

    it("resolves npx on Windows and spawns the batch file through a shell", async () => {
      // The whole reported failure in one test: the registry says "npx", the
      // machine has it as npx.cmd, and a batch file needs a shell to start.
      const { spawn } = await import("node:child_process");
      const dir = mkdtempSync(join(tmpdir(), "acp-gateway-path-"));
      writeFileSync(join(dir, "npx.cmd"), "");
      const platform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      vi.stubEnv("PATH", dir);
      vi.stubEnv("PATHEXT", ".EXE;.cmd");
      try {
        await openAgentConnection({
          acpCmdArgs: ["npx", "-y", "@zed-industries/codex-acp"],
            label: "spawn-windows",
        });
      } finally {
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        vi.unstubAllEnvs();
      }

      expect(vi.mocked(spawn)).toHaveBeenLastCalledWith(
        join(dir, "npx.cmd"),
        ['^"-y^"', '^"@zed-industries/codex-acp^"'],
        expect.objectContaining({ shell: true }),
      );
    });

    it("should report the agent's login methods and survive process failures", async () => {
      setVerbose(true);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(acp.ClientSideConnection).mockImplementationOnce(function () {
        return {
          initialize: vi.fn().mockResolvedValue({
            protocolVersion: "0.1.0",
            authMethods: [{ id: "agent-login", name: "Agent login" }],
          }),
        } as any;
      } as any);

      const agent = await openAgentConnection({
        acpCmdArgs: ["node", "agent.js"],
        label: "login",
      });
      const dispose = vi.spyOn(agent.acpClient, "dispose");

      expect(agent.initResult.authMethods).toHaveLength(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("Agent login (agent-login)");

      agent.process.emit("error", new Error("spawn failed"));
      agent.process.stdin.emit("error", new Error("EPIPE"));
      expect(dispose).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });
  });

  describe("agent output", () => {
    function mockInit() {
      vi.mocked(acp.ClientSideConnection).mockImplementationOnce(function () {
        return {
          initialize: vi.fn().mockResolvedValue({ protocolVersion: "0.1.0" }),
        } as any;
      } as any);
    }

    it("keeps the agent's own logging off the terminal while it runs", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      mockInit();
      const agent = await openAgentConnection({
        acpCmdArgs: ["node", "agent.js"],
        label: "list-models",
      });

      agent.process.stderr.write("I1002 Starting AGY ACP Server...\n");
      await new Promise((r) => setImmediate(r));
      agent.process.emit("exit", 0, null);

      expect(writeSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("shows the end of the agent's logging when it fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockInit();
      const agent = await openAgentConnection({
        acpCmdArgs: ["node", "agent.js"],
        label: "task t1",
      });

      agent.process.stderr.write("E1002 credentials missing\n");
      await new Promise((r) => setImmediate(r));
      agent.process.emit("exit", 2, null);

      const printed = errorSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("Agent process for task t1 exited (code=2, signal=null)");
      expect(printed).toContain("The agent's last output:\nE1002 credentials missing");
      errorSpy.mockRestore();
    });

    it("passes the agent's logging straight through under --verbose", async () => {
      setVerbose(true);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      mockInit();
      const agent = await openAgentConnection({
        acpCmdArgs: ["node", "agent.js"],
        label: "task t1",
      });

      agent.process.stderr.write("I1002 hello\n");
      await new Promise((r) => setImmediate(r));
      agent.process.emit("exit", 0, null);

      expect(writeSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("I1002 hello");
      expect(errorSpy).toHaveBeenCalledWith(
        "[acp] Agent process for task t1 exited (code=0, signal=null)",
      );
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("shows the agent's logging when it dies before the handshake", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let child: any;
      vi.mocked(acp.ClientSideConnection).mockImplementationOnce(function () {
        child = spawnedAgents[spawnedAgents.length - 1];
        return {
          initialize: vi.fn().mockImplementation(async () => {
            child.stderr.write("E1002 fatal: no credentials\n");
            await new Promise((r) => setImmediate(r));
            throw new Error("ACP connection closed");
          }),
        } as any;
      } as any);

      await expect(
        openAgentConnection({ acpCmdArgs: ["node", "agent.js"], label: "list-models" }),
      ).rejects.toThrow("ACP connection closed");
      expect(errorSpy).toHaveBeenCalledWith(
        "[acp] The agent's last output:\nE1002 fatal: no credentials",
      );

      // Already shown, so a later failed exit does not repeat it.
      errorSpy.mockClear();
      child.emit("exit", 1, null);
      expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("E1002");
      errorSpy.mockRestore();
    });

    it("tells a failed exit from a routine one", () => {
      expect(agentExitFailed(0, null)).toBe(false);
      expect(agentExitFailed(1, null)).toBe(true);
      expect(agentExitFailed(null, "SIGTERM")).toBe(false);
      expect(agentExitFailed(null, "SIGKILL")).toBe(false);
      expect(agentExitFailed(null, "SIGINT")).toBe(false);
      expect(agentExitFailed(null, "SIGSEGV")).toBe(true);
      expect(agentExitFailed(null, null)).toBe(false);
    });

    it("shows nothing when the failed agent said nothing", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      showAgentStderr("");
      showAgentStderr("  \n");
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("does not repeat the agent's logging under --verbose", () => {
      setVerbose(true);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      showAgentStderr("already printed");
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe("shouldPrintBanner", () => {
    it("prints the Starting line only for a gateway that keeps running", () => {
      expect(shouldPrintBanner({ command: "run", json: false, verbose: false })).toBe(true);
      expect(shouldPrintBanner({ command: "list-models", json: false, verbose: false })).toBe(false);
      expect(shouldPrintBanner({ command: "list-models", json: false, verbose: true })).toBe(true);
      expect(shouldPrintBanner({ command: "run", json: true, verbose: true })).toBe(false);
    });
  });

  describe("createSessionWithAuth", () => {
    const auth = {
      methods: [{ id: "agent-login", name: "Agent login" }] as any,
      launch: { command: "node", args: ["agent.js"] },
    };

    it("should start the session directly when no login is needed", async () => {
      const connection: any = {
        newSession: vi.fn().mockResolvedValue({ sessionId: "s1" }),
        authenticate: vi.fn(),
      };

      const result = await createSessionWithAuth(connection, {} as any, auth);

      expect(result.sessionId).toBe("s1");
      expect(connection.authenticate).not.toHaveBeenCalled();
    });

    it("should surface failures that are not about authentication", async () => {
      const connection: any = {
        newSession: vi.fn().mockRejectedValue(new Error("cwd does not exist")),
        authenticate: vi.fn(),
      };

      await expect(createSessionWithAuth(connection, {} as any, auth)).rejects.toThrow(
        "cwd does not exist",
      );
      expect(connection.authenticate).not.toHaveBeenCalled();
    });

    const authRequired = () =>
      Object.assign(new Error("Authentication required"), { code: AUTH_REQUIRED_CODE });

    it("should log in and retry when the agent refuses without a login", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const connection: any = {
        newSession: vi.fn().mockRejectedValueOnce(authRequired()).mockResolvedValue({ sessionId: "s2" }),
        authenticate: vi.fn().mockResolvedValue({}),
      };

      const result = await createSessionWithAuth(connection, {} as any, auth);

      expect(result.sessionId).toBe("s2");
      expect(connection.authenticate).toHaveBeenCalledWith({ methodId: "agent-login" });
      expect(errorSpy).toHaveBeenCalledWith(
        "[auth] Agent requires authentication before a session can start.",
      );
      errorSpy.mockRestore();
    });

    it("should report a login that does not help as an authentication failure", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const connection: any = {
        newSession: vi.fn().mockRejectedValue(authRequired()),
        authenticate: vi.fn().mockResolvedValue({}),
      };

      const failure = await createSessionWithAuth(connection, {} as any, auth).catch((e) => e);

      expect(failure).toBeInstanceOf(AuthenticationFailed);
      expect(failure).toMatchObject({ name: "AuthenticationFailed", hasLogin: true });
      expect(failure.message).toBe("Authentication required");
      errorSpy.mockRestore();
    });

    it("should say when the agent offers no login at all", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const connection: any = {
        newSession: vi.fn().mockRejectedValue(authRequired()),
        authenticate: vi.fn(),
      };

      const failure = await createSessionWithAuth(connection, {} as any, { ...auth, methods: [] }).catch(
        (e) => e,
      );

      expect(failure).toBeInstanceOf(AuthenticationFailed);
      expect(failure.hasLogin).toBe(false);
      errorSpy.mockRestore();
    });

    it("should describe a failure that is not an Error", () => {
      expect(new AuthenticationFailed("no").message).toBe("no");
    });
  });

  describe("parseGatewayArgs", () => {
    it("should default to bridging tasks with a concurrency of 1", () => {
      expect(parseGatewayArgs([])).toEqual({
        maxConcurrency: 1,
        permissionTimeoutMs: 30 * 60_000,
        command: "run",
        allowUnverifiedAgent: false,
        json: false,
        verbose: false,
        rest: [],
      });
    });

    it("should turn on verbose output with --verbose", () => {
      expect(parseGatewayArgs(["--verbose"]).verbose).toBe(true);
      expect(parseGatewayArgs(["--verbose", "gemini"]).rest).toEqual(["gemini"]);
    });

    it("should take the permission timeout in minutes", () => {
      expect(parseGatewayArgs(["--permission-timeout", "5"]).permissionTimeoutMs).toBe(300_000);
      // Zero is a deliberate "wait indefinitely", so it must not be ignored.
      expect(parseGatewayArgs(["--permission-timeout", "0"]).permissionTimeoutMs).toBe(0);
    });

    it("should keep the default when the timeout makes no sense", () => {
      expect(parseGatewayArgs(["--permission-timeout"]).permissionTimeoutMs).toBe(30 * 60_000);
      expect(parseGatewayArgs(["--permission-timeout", "soon"]).permissionTimeoutMs).toBe(
        30 * 60_000,
      );
      expect(parseGatewayArgs(["--permission-timeout", "-5"]).permissionTimeoutMs).toBe(
        30 * 60_000,
      );
    });

    it("should accept both spellings of the concurrency flag", () => {
      expect(parseGatewayArgs(["--max-concurrency", "4"]).maxConcurrency).toBe(4);
      expect(parseGatewayArgs(["--maxConcurrency", "8"]).maxConcurrency).toBe(8);
    });

    it("should refuse a concurrency of zero, which used to stall the queue forever", () => {
      // Accepted before, and then every task waited on a limit of 0 that no
      // completion could ever get under.
      expect(parseGatewayArgs(["--max-concurrency", "0"]).maxConcurrency).toBe(1);
      expect(parseGatewayArgs(["--max-concurrency", "-3"]).maxConcurrency).toBe(1);
    });

    it("should cap the concurrency flag at the same ceiling the workspace gets", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseGatewayArgs(["--max-concurrency", "10000"]).maxConcurrency).toBe(64);
      errorSpy.mockRestore();
    });

    it("should say so when it caps the flag, since nothing reports a flag back", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      errorSpy.mockClear();

      parseGatewayArgs(["--max-concurrency", "128"]);

      // An existing --max-concurrency 128 would otherwise quietly boot at 64.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--max-concurrency 128 is outside 1-64; using 64."),
      );
      errorSpy.mockRestore();
    });

    it("should not warn about a fraction, which is truncated rather than capped", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      errorSpy.mockClear();

      expect(parseGatewayArgs(["--max-concurrency", "4.9"]).maxConcurrency).toBe(4);

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("should leave a non-numeric token alone, since it is the agent command", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // `--max-concurrency claude` is the number left out, not a mistyped
      // number. Eating the token would leave the gateway nothing to run.
      expect(parseGatewayArgs(["--max-concurrency", "claude"])).toMatchObject({
        maxConcurrency: 1,
        rest: ["claude"],
      });

      errorSpy.mockRestore();
    });

    it("should consume a malformed concurrency value instead of leaving it to be run", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // `rest` is the agent command when no `--` was used, so a value left
      // behind here sent the gateway looking for an agent called "8x".
      expect(parseGatewayArgs(["--max-concurrency", "8x", "claude"])).toMatchObject({
        maxConcurrency: 1,
        rest: ["claude"],
      });
      expect(parseGatewayArgs(["--max-concurrency", "8x", "--", "claude"]).rest).toEqual([
        "--",
        "claude",
      ]);

      errorSpy.mockRestore();
    });

    it("should say why a malformed concurrency value was ignored", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      errorSpy.mockClear();

      parseGatewayArgs(["--max-concurrency", "8x"]);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--max-concurrency "8x" is not a number of tasks'),
      );
      errorSpy.mockRestore();
    });

    it("should stay silent when the flag simply has no value to read", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      errorSpy.mockClear();

      expect(parseGatewayArgs(["--max-concurrency", "--logout"])).toMatchObject({
        maxConcurrency: 1,
        command: "logout",
      });

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("should keep the default when the concurrency value is missing or not a number", () => {
      expect(parseGatewayArgs(["--max-concurrency"]).maxConcurrency).toBe(1);
      expect(parseGatewayArgs(["--max-concurrency", "many"]).maxConcurrency).toBe(1);
      expect(parseGatewayArgs(["--max-concurrency", "--logout"])).toMatchObject({
        maxConcurrency: 1,
        command: "logout",
      });
    });

    it("should read the preferred auth method", () => {
      expect(parseGatewayArgs(["--auth-method", "oauth"])).toMatchObject({
        maxConcurrency: 1,
        command: "run",
        authMethodId: "oauth",
      });
      expect(parseGatewayArgs(["--auth-method"]).authMethodId).toBeUndefined();
    });

    it("should recognise the auth commands", () => {
      expect(parseGatewayArgs(["--login"])).toMatchObject({ maxConcurrency: 1, command: "login" });
      expect(parseGatewayArgs(["--login", "oauth"])).toMatchObject({
        maxConcurrency: 1,
        command: "login",
        authMethodId: "oauth",
      });
      expect(parseGatewayArgs(["--logout"]).command).toBe("logout");
      expect(parseGatewayArgs(["--list-auth-methods"]).command).toBe("list-auth-methods");
    });

    it("should keep tokens it does not recognise as the agent command", () => {
      const options = parseGatewayArgs(["--debug", "--login"]);
      expect(options.command).toBe("login");
      expect(options.rest).toEqual(["--debug"]);
    });

    it("should collect an agent command given without a -- separator", () => {
      expect(parseGatewayArgs(["--max-concurrency", "4", "gemini", "--acp"])).toMatchObject({
        maxConcurrency: 4,
        rest: ["gemini", "--acp"],
      });
    });

    it("should read the registry options", () => {
      expect(parseGatewayArgs(["--agent", "gemini"])).toMatchObject({
        agentId: "gemini",
        command: "run",
      });
      expect(parseGatewayArgs(["--agent"]).agentId).toBeUndefined();
      expect(parseGatewayArgs(["--list-agents"]).command).toBe("list-agents");
      expect(parseGatewayArgs(["--allow-unverified-agent"]).allowUnverifiedAgent).toBe(true);
      expect(
        parseGatewayArgs(["--registry-url", "http://localhost/registry.json"]).registryUrl,
      ).toBe("http://localhost/registry.json");
      expect(parseGatewayArgs(["--registry-url"]).registryUrl).toBeUndefined();
    });

    it("should take a path to an MCP config", () => {
      expect(
        parseGatewayArgs(["--mcp-json", "/elsewhere/work-servers.json"]),
      ).toMatchObject({
        mcpJsonPath: "/elsewhere/work-servers.json",
        command: "run",
        rest: [],
      });

      // The path is consumed, so it cannot fall through into `rest` — which is
      // the agent command when no `--` was used.
      expect(
        parseGatewayArgs(["--mcp-json", "/elsewhere/servers.json", "gemini", "--acp"]).rest,
      ).toEqual(["gemini", "--acp"]);
    });

    it("should say so when --mcp-json is given no path", () => {
      // Ignoring it silently would start the gateway against whatever config
      // happened to be near the working directory — the very thing the flag
      // was typed to avoid.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(parseGatewayArgs(["--mcp-json"]).mcpJsonPath).toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--mcp-json provided without a path"),
      );
      errorSpy.mockRestore();
    });

    it("leaves --acp-url unset unless it is given", () => {
      expect(parseGatewayArgs(["--agent", "gemini"]).acpUrl).toBeUndefined();
    });

    it("still accepts --acp-version 1, from launch scripts written before v1 was the only mode", () => {
      expect(
        parseGatewayArgs(["--acp-version", "1", "--acp-url", "wss://x/api/acp/v1", "gemini"]),
      ).toMatchObject({ command: "run", acpUrl: "wss://x/api/acp/v1", rest: ["gemini"] });
    });

    it.each([["2"], ["3"], ["v1"], [undefined]])("refuses --acp-version %s", (value) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);

      expect(() => parseGatewayArgs(value ? ["--acp-version", value] : ["--acp-version"])).toThrow("exit");

      expect(errorSpy).toHaveBeenCalledWith("[acp-gateway] --acp-version must be 1, the only version supported");
      expect(exitSpy).toHaveBeenCalledWith(1);
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it("says so when --acp-url is given no URL", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(parseGatewayArgs(["--acp-url"]).acpUrl).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--acp-url provided without a URL"));
      errorSpy.mockRestore();
    });

    it("should recognise model options", () => {
      expect(parseGatewayArgs(["--list-models"])).toMatchObject({ command: "list-models" });
      expect(parseGatewayArgs(["--model", "claude-3-7-sonnet"])).toMatchObject({
        command: "run",
        modelId: "claude-3-7-sonnet",
      });
      expect(parseGatewayArgs(["--model"]).modelId).toBeUndefined();
    });

    it("should recognise both spellings of the help flag", () => {
      expect(parseGatewayArgs(["--help"]).command).toBe("help");
      expect(parseGatewayArgs(["-h"]).command).toBe("help");
    });
  });

  describe("isRunnable", () => {
    it("finds a command on PATH", () => {
      expect(isRunnable("node", { PATH: process.env.PATH }, process.platform)).toBe(true);
    });

    it("does not find one that is not there", () => {
      expect(isRunnable("acp-gateway-no-such-command", { PATH: process.env.PATH })).toBe(false);
      expect(isRunnable("node", { PATH: "" })).toBe(false);
      expect(isRunnable("node", {})).toBe(false);
    });

    it("checks a path directly rather than searching PATH", () => {
      expect(isRunnable(process.execPath, {})).toBe(true);
      expect(isRunnable("/no/such/agent", {})).toBe(false);
    });

    it("honours PATHEXT and backslashes on Windows", () => {
      // A bare name on Windows resolves through PATHEXT, so "npx" alone finds
      // nothing while "npx.cmd" would.
      expect(isRunnable("npx", { PATH: "C:\\tools", PATHEXT: ".EXE" }, "win32")).toBe(false);
      expect(isRunnable("C:\\nope\\agent.exe", {}, "win32")).toBe(false);
    });

    it("finds a Windows command that already carries its suffix", () => {
      // The registry launches npm agents as "npx.cmd"; appending PATHEXT to
      // that would only ever look for "npx.cmd.EXE" and friends.
      const dir = mkdtempSync(join(tmpdir(), "acp-gateway-path-"));
      writeFileSync(join(dir, "npx.cmd"), "");
      expect(isRunnable("npx.cmd", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32")).toBe(
        true,
      );
      expect(isRunnable("npx.cmd", { PATH: dir }, "win32")).toBe(true);
      // A suffix PATHEXT does not list is still a bare name to complete.
      expect(isRunnable("npx.cmd", { PATH: dir, PATHEXT: ".EXE" }, "win32")).toBe(false);
    });

    it("still completes a bare Windows name from PATHEXT", () => {
      const dir = mkdtempSync(join(tmpdir(), "acp-gateway-path-"));
      writeFileSync(join(dir, "agent.CMD"), "");
      expect(isRunnable("agent", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(true);
      expect(isRunnable("agent", { PATH: dir, PATHEXT: ".EXE" }, "win32")).toBe(false);
    });
  });

  describe("resolveOnPath", () => {
    it("returns the file a name resolves to", () => {
      const dir = mkdtempSync(join(tmpdir(), "acp-gateway-path-"));
      writeFileSync(join(dir, "npx.cmd"), "");
      expect(resolveOnPath("npx", { PATH: dir, PATHEXT: ".EXE;.cmd" }, "win32")).toBe(
        join(dir, "npx.cmd"),
      );
      expect(resolveOnPath("npx", { PATH: dir, PATHEXT: ".EXE" }, "win32")).toBeUndefined();
    });

    it("takes the first directory on PATH that has it", () => {
      const first = mkdtempSync(join(tmpdir(), "acp-gateway-path-"));
      const second = mkdtempSync(join(tmpdir(), "acp-gateway-path-"));
      writeFileSync(join(first, "agent.exe"), "");
      writeFileSync(join(second, "agent.exe"), "");
      expect(
        resolveOnPath("agent", { PATH: `${first};${second}`, PATHEXT: ".exe" }, "win32"),
      ).toBe(join(first, "agent.exe"));
    });
  });

  describe("spawnTarget", () => {
    it("leaves a command alone off Windows", () => {
      expect(spawnTarget("npx", { PATH: "/usr/bin" }, "darwin")).toBe("npx");
    });

    it("resolves the suffix a Windows runner is actually installed under", () => {
      // A stock npm install ships npx.cmd, a Volta install ships npx.exe, and
      // only one of those needs a shell to start.
      const batch = mkdtempSync(join(tmpdir(), "acp-gateway-path-"));
      writeFileSync(join(batch, "npx.cmd"), "");
      expect(spawnTarget("npx", { PATH: batch, PATHEXT: ".exe;.cmd" }, "win32")).toBe(
        join(batch, "npx.cmd"),
      );

      const shimmed = mkdtempSync(join(tmpdir(), "acp-gateway-path-"));
      writeFileSync(join(shimmed, "npx.exe"), "");
      const resolved = spawnTarget("npx", { PATH: shimmed, PATHEXT: ".exe;.cmd" }, "win32");
      expect(resolved).toBe(join(shimmed, "npx.exe"));
      expect(needsShell(resolved, "win32")).toBe(false);
    });

    it("falls back to the name when nothing on PATH matches", () => {
      expect(spawnTarget("npx", { PATH: "C:\\nowhere", PATHEXT: ".EXE" }, "win32")).toBe("npx");
      expect(spawnTarget("C:\\tools\\agent.cmd", { PATH: "" }, "win32")).toBe(
        "C:\\tools\\agent.cmd",
      );
    });
  });

  describe("needsShell", () => {
    it("asks for a shell only for Windows batch files", () => {
      expect(needsShell("npx.cmd", "win32")).toBe(true);
      expect(needsShell("C:\\tools\\Agent.BAT", "win32")).toBe(true);
      expect(needsShell("node.exe", "win32")).toBe(false);
      expect(needsShell("npx", "win32")).toBe(false);
    });

    it("never asks for one off Windows", () => {
      expect(needsShell("npx.cmd", "darwin")).toBe(false);
      expect(needsShell("npx", "linux")).toBe(false);
    });
  });

  describe("escapeCmdCommand", () => {
    it("leaves a plain program name alone", () => {
      expect(escapeCmdCommand("npx.cmd")).toBe("npx.cmd");
    });

    it("escapes what cmd.exe would otherwise act on", () => {
      // The space is escaped rather than quoted, so cmd.exe reads the whole
      // path as the program name.
      expect(escapeCmdCommand("C:\\Program Files\\nodejs\\npx.cmd")).toBe(
        "C:\\Program^ Files\\nodejs\\npx.cmd",
      );
      expect(escapeCmdCommand("a&b.cmd")).toBe("a^&b.cmd");
    });
  });

  describe("quoteForCmd", () => {
    it("quotes every argument for both parsers", () => {
      // Quoted for the agent's own argument parser, then escaped so cmd.exe
      // passes those quotes along instead of eating them.
      expect(quoteForCmd("-y")).toBe('^"-y^"');
      expect(quoteForCmd("@zed-industries/codex-acp")).toBe('^"@zed-industries/codex-acp^"');
      expect(quoteForCmd("")).toBe('^"^"');
    });

    it("neutralises whitespace and shell syntax", () => {
      expect(quoteForCmd("two words")).toBe('^"two^ words^"');
      expect(quoteForCmd("a&b|c")).toBe('^"a^&b^|c^"');
      expect(quoteForCmd("%PATH%")).toBe('^"^%PATH^%^"');
    });

    it("escapes twice for a wrapper that re-enters cmd.exe", () => {
      expect(quoteForCmd("a&b", true)).toBe('^^^"a^^^&b^^^"');
    });

    it("doubles the backslashes a quote would otherwise escape", () => {
      expect(quoteForCmd('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
      expect(quoteForCmd("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
      // A run of backslashes before a quote is doubled whole, then the quote
      // gets its own: two backslashes and a quote need five and a quote.
      expect(quoteForCmd('a\\\\"b')).toBe('^"a\\\\\\\\\\^"b^"');
    });

    it("stays fast on a long run of backslashes", () => {
      // The two regexes this replaced asked for a run of backslashes followed
      // by a quote, so a long run with no quote after it was re-tried from
      // every position in the run. 50k backslashes took long enough to matter;
      // counting the run once does not care.
      const run = "\\".repeat(50_000);

      const started = Date.now();
      const quoted = quoteForCmd(run);
      const elapsed = Date.now() - started;

      // Untouched, because nothing follows them but the closing quote — which
      // is exactly the case that doubles them.
      expect(quoted).toBe(`^"${"\\".repeat(100_000)}^"`);
      expect(elapsed).toBeLessThan(1_000);
    });
  });

  describe("spawnArgsFor", () => {
    it("passes the command through when no shell is involved", () => {
      expect(spawnArgsFor("npx", ["-y", "some pkg"], "darwin")).toEqual([
        "npx",
        ["-y", "some pkg"],
      ]);
      expect(spawnArgsFor("npx.cmd", ["-y", "codex-acp"], "linux")).toEqual([
        "npx.cmd",
        ["-y", "codex-acp"],
      ]);
    });

    it("escapes twice for an npm bin shim, which re-enters cmd.exe", () => {
      expect(
        spawnArgsFor("C:\\proj\\node_modules\\.bin\\my-agent.cmd", ["--flag"], "win32"),
      ).toEqual(["C:\\proj\\node_modules\\.bin\\my-agent.cmd", ['^^^"--flag^^^"']]);
    });

    it("escapes the command line a Windows shell would re-parse", () => {
      expect(
        spawnArgsFor("C:\\Program Files\\nodejs\\npx.cmd", ["-y", "codex-acp"], "win32"),
      ).toEqual([
        "C:\\Program^ Files\\nodejs\\npx.cmd",
        ['^"-y^"', '^"codex-acp^"'],
      ]);
    });
  });

  describe("terminateAgentProcess", () => {
    it("just kills the process off Windows", () => {
      const child = { pid: 42, kill: vi.fn() };
      const spawnImpl = vi.fn();
      terminateAgentProcess(child, "darwin", spawnImpl as any);
      expect(child.kill).toHaveBeenCalled();
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("kills the whole tree on Windows", () => {
      const killer: any = new EventEmitter();
      killer.unref = vi.fn();
      const spawnImpl = vi.fn(() => killer);
      const child = { pid: 4242, kill: vi.fn() };

      terminateAgentProcess(child, "win32", spawnImpl as any);

      expect(spawnImpl).toHaveBeenCalledWith(
        "taskkill",
        ["/pid", "4242", "/T", "/F"],
        { stdio: "ignore" },
      );
      expect(killer.unref).toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();

      // taskkill itself failing must not leave the agent running.
      killer.emit("error", new Error("not found"));
      expect(child.kill).toHaveBeenCalled();
    });

    it("falls back to a plain kill when the process has no pid", () => {
      const child = { kill: vi.fn() };
      const spawnImpl = vi.fn();
      terminateAgentProcess(child, "win32", spawnImpl as any);
      expect(child.kill).toHaveBeenCalled();
      expect(spawnImpl).not.toHaveBeenCalled();
    });

    it("does nothing when there is no process to end", () => {
      const spawnImpl = vi.fn();
      expect(() => terminateAgentProcess(undefined, "win32", spawnImpl as any)).not.toThrow();
      expect(spawnImpl).not.toHaveBeenCalled();
    });
  });

  describe("assertAgentRunnable", () => {
    it("accepts a command that exists", () => {
      expect(() => assertAgentRunnable("node", false)).not.toThrow();
    });

    it("suggests --agent when the command looks like a registry id", () => {
      expect(() => assertAgentRunnable("antigravity-acp", false)).toThrow(
        /run it with --agent antigravity-acp/,
      );
    });

    it("blames the registry when the id was already resolved", () => {
      expect(() => assertAgentRunnable("acp-gateway-no-such-runner", true)).toThrow(
        /The registry says to run it as "acp-gateway-no-such-runner", which is not installed/,
      );
    });
  });

  describe("runListAgents", () => {
    const registry = {
      version: "1.0.0",
      agents: [
        {
          id: "gemini",
          name: "Gemini CLI",
          version: "0.58.0",
          description: "Google's CLI",
          distribution: { npx: { package: "@google/gemini-cli", args: ["--acp"] } },
        },
      ],
    };

    it("should print every agent and how to run one", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => registry });

      await runListAgents(undefined, fetchImpl as any);

      const printed = logSpy.mock.calls.flat().join("\n");
      logSpy.mockRestore();
      expect(printed).toContain("ACP registry v1.0.0 — 1 agents");
      expect(printed).toContain("gemini");
      expect(printed).toContain("acp-gateway --agent <id>");
    });

    it("should read a registry the user pointed it at", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => registry });

      await runListAgents("http://localhost/registry.json", fetchImpl as any);
      logSpy.mockRestore();

      expect(fetchImpl).toHaveBeenCalledWith("http://localhost/registry.json");
    });

    it("should print a single JSON line and nothing else when asked for JSON", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => registry });

      await runListAgents(undefined, fetchImpl as any, true);

      // Exactly one console.log call: a caller parsing this as JSON must not
      // have to reassemble it out of several lines, or filter out the table
      // this mode exists to replace.
      const calls = logSpy.mock.calls;
      logSpy.mockRestore();
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0][0])).toEqual({
        agents: [{ id: "gemini", name: "Gemini CLI", runtimes: ["npx"] }],
      });
    });

    it("marks agents installing without a checksum with unverified: true in JSON output and omits the field otherwise", async () => {
      const fullRegistry = {
        version: "1.0.0",
        agents: [
          {
            id: "crow-cli",
            name: "crow-cli",
            version: "1.0.0",
            description: "Binary agent without checksum",
            distribution: {
              binary: {
                "darwin-aarch64": {
                  archive: "https://example.com/crow.tar.gz",
                  cmd: "./crow",
                },
              },
            },
          },
          {
            id: "opencode",
            name: "OpenCode",
            version: "1.0.0",
            description: "Binary agent with checksum",
            distribution: {
              binary: {
                "darwin-aarch64": {
                  archive: "https://example.com/opencode.tar.gz",
                  sha256: "a".repeat(64),
                  cmd: "./opencode",
                },
              },
            },
          },
          {
            id: "gemini",
            name: "Gemini CLI",
            version: "0.58.0",
            description: "npx agent",
            distribution: { npx: { package: "@google/gemini-cli" } },
          },
          {
            id: "fast-agent",
            name: "fast-agent",
            version: "1.0.0",
            description: "uvx agent",
            distribution: { uvx: { package: "fast-agent" } },
          },
          {
            id: "hybrid",
            name: "Hybrid",
            version: "1.0.0",
            description: "npx and binary agent without checksum",
            distribution: {
              npx: { package: "hybrid-cli" },
              binary: {
                "darwin-aarch64": {
                  archive: "https://example.com/hybrid.tar.gz",
                  cmd: "./hybrid",
                },
              },
            },
          },
          {
            id: "linux-only",
            name: "Linux Only",
            version: "1.0.0",
            description: "no build for darwin",
            distribution: {
              binary: {
                "linux-x86_64": {
                  archive: "https://example.com/linux.tar.gz",
                  cmd: "./linux",
                },
              },
            },
          },
        ],
      };

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => fullRegistry });

      await runListAgents(undefined, fetchImpl as any, true, "darwin-aarch64");

      const calls = logSpy.mock.calls;
      logSpy.mockRestore();
      expect(calls).toHaveLength(1);
      const parsed = JSON.parse(calls[0][0]);
      expect(parsed).toEqual({
        agents: [
          { id: "crow-cli", name: "crow-cli", runtimes: ["binary"], unverified: true },
          { id: "opencode", name: "OpenCode", runtimes: ["binary"] },
          { id: "gemini", name: "Gemini CLI", runtimes: ["npx"] },
          { id: "fast-agent", name: "fast-agent", runtimes: ["uvx"] },
          { id: "hybrid", name: "Hybrid", runtimes: ["npx", "binary"] },
          { id: "linux-only", name: "Linux Only", runtimes: [] },
        ],
      });

      expect(parsed.agents[0]).toHaveProperty("unverified", true);
      expect(parsed.agents[1]).not.toHaveProperty("unverified");
      expect(parsed.agents[2]).not.toHaveProperty("unverified");
      expect(parsed.agents[3]).not.toHaveProperty("unverified");
      expect(parsed.agents[4]).not.toHaveProperty("unverified");
      expect(parsed.agents[5]).not.toHaveProperty("unverified");
    });
  });

  describe("resolveAgentCommand", () => {
    const options = (overrides: Record<string, any> = {}) => ({
      maxConcurrency: 1,
      permissionTimeoutMs: 30 * 60_000,
      command: "run" as const,
      allowUnverifiedAgent: false,
      json: false,
      verbose: false,
      rest: [],
      ...overrides,
    });

    it("should use the command given after -- when no registry id was named", async () => {
      const fetchImpl = vi.fn();

      const resolved = await resolveAgentCommand(options(), ["gemini", "--acp"], fetchImpl as any);

      expect(resolved).toEqual({ command: ["gemini", "--acp"] });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("should resolve a registry id into the command that runs it", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          version: "1.0.0",
          agents: [
            {
              id: "gemini",
              name: "Gemini CLI",
              version: "0.58.0",
              description: "Google's CLI",
              distribution: {
                npx: { package: "@google/gemini-cli@0.58.0", args: ["--acp"], env: { K: "v" } },
              },
            },
          ],
        }),
      });

      const resolved = await resolveAgentCommand(
        options({ agentId: "gemini" }),
        [],
        fetchImpl as any,
      );
      errorSpy.mockRestore();

      expect(resolved.command[0]).toMatch(/^npx/);
      expect(resolved.command.slice(1)).toEqual(["-y", "@google/gemini-cli@0.58.0", "--acp"]);
      expect(resolved.env).toEqual({ K: "v" });
    });

    it("should surface a registry id that does not exist", async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "1.0.0", agents: [] }),
      });

      await expect(
        resolveAgentCommand(options({ agentId: "nope" }), [], fetchImpl as any),
      ).rejects.toThrow(/No agent "nope" in the ACP registry/);
    });
  });

  describe("loadWorkspace", () => {
    let errorSpy: any;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    /** A directory with no .mcp.json in it or in the three above it. */
    function emptyWorkspaceDir(): string {
      const root = mkdtempSync(join(tmpdir(), "acp-gw-noworkspace-"));
      const dir = join(root, "a", "b", "c", "d");
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    function writeMcpJson(dir: string, name = ".mcp.json"): string {
      const file = join(dir, name);
      writeFileSync(
        file,
        JSON.stringify({ mcpServers: { "agentrq-ws": { type: "http", url: "http://localhost:1/mcp" } } }),
      );
      return file;
    }

    it("should name the commands that only deal with the agent itself", () => {
      expect([...WORKSPACE_OPTIONAL_COMMANDS].sort()).toEqual(
        ["agent-info", "list-auth-methods", "list-models", "login", "logout"],
      );
    });

    it.each(["list-models", "agent-info", "list-auth-methods", "login", "logout"] as const)(
      "should let --%s run without a .mcp.json",
      (command) => {
        const config = loadWorkspace(command, undefined, emptyWorkspaceDir());

        expect(config).toEqual({ name: "none", type: "http", env: {} });
      },
    );

    it("should not read a .mcp.json that is there, when the command does not need it", () => {
      const dir = emptyWorkspaceDir();
      // Broken on purpose: had it been read, this would throw.
      writeFileSync(join(dir, ".mcp.json"), "{ not json");

      expect(loadWorkspace("list-models", undefined, dir).name).toBe("none");
    });

    it("should not read a config named with --mcp-json for a one-shot command either", () => {
      expect(loadWorkspace("login", "/nowhere/servers.json", emptyWorkspaceDir()).name).toBe("none");
    });

    it("should still require a .mcp.json to run the bridge", () => {
      expect(() => loadWorkspace("run", undefined, emptyWorkspaceDir())).toThrow(
        "Could not find .mcp.json",
      );
    });

    it("should report a --mcp-json path that is wrong", () => {
      expect(() =>
        loadWorkspace("run", "/nowhere/servers.json", emptyWorkspaceDir()),
      ).toThrow();
    });

    it("should pick the AgentRQ server from the workspace it finds", () => {
      const dir = emptyWorkspaceDir();
      writeMcpJson(dir);

      expect(loadWorkspace("run", undefined, dir).name).toBe("agentrq-ws");
    });

    it("should read a config named with --mcp-json", () => {
      const file = writeMcpJson(emptyWorkspaceDir(), "servers.json");

      expect(loadWorkspace("run", file, emptyWorkspaceDir()).url).toBe("http://localhost:1/mcp");
    });
  });

  describe("makeIsolatedDir", () => {
    it("should make an empty directory and remove it again", () => {
      const isolated = makeIsolatedDir();

      expect(existsSync(isolated.dir)).toBe(true);
      expect(isolated.dir.startsWith(tmpdir())).toBe(true);
      isolated.remove();
      expect(existsSync(isolated.dir)).toBe(false);
      // Removing twice, or after something else did, is harmless.
      expect(() => isolated.remove()).not.toThrow();
    });
  });

  describe("runAgentCommand", () => {
    const agentrqConfig: any = { env: {} };
    let logSpy: any;
    let errorSpy: any;

    function mockConnection(overrides: Record<string, any>, initResult: Record<string, any> = {}) {
      const connection: Record<string, any> = {
        initialize: vi.fn().mockResolvedValue({ protocolVersion: "0.1.0", ...initResult }),
        ...overrides,
      };
      vi.mocked(acp.ClientSideConnection).mockImplementationOnce(function () {
        return connection as any;
      } as any);
      return connection;
    }

    beforeEach(() => {
      spawnedAgents.length = 0;
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("should list the agent's login methods and shut the agent down again", async () => {
      mockConnection({}, {
        authMethods: [{ id: "agent-login", name: "Agent login" }],
        agentCapabilities: { auth: { logout: {} } },
      });

      await runAgentCommand("list-auth-methods", ["gemini", "--acp"], agentrqConfig.env);

      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("Agent login (agent-login)");
      expect(printed).toContain("--logout");
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should run --list-models in an empty directory of its own, and remove it after", async () => {
      // Run from the workspace's own directory, the agent would find the
      // workspace's .mcp.json there and connect to it as though it were the
      // workspace's agent.
      const { spawn } = await import("node:child_process");
      const newSession = vi.fn().mockResolvedValue({ sessionId: "m-sess", configOptions: [] });
      mockConnection({ newSession });

      await runAgentCommand("list-models", ["gemini", "--acp"], agentrqConfig.env);

      const sessionCwd = newSession.mock.calls[0][0].cwd;
      expect(sessionCwd).not.toBe(process.cwd());
      expect(sessionCwd.startsWith(tmpdir())).toBe(true);
      expect(newSession.mock.calls[0][0].mcpServers).toEqual([]);
      expect(vi.mocked(spawn)).toHaveBeenLastCalledWith(
        "gemini",
        ["--acp"],
        expect.objectContaining({ cwd: sessionCwd }),
      );
      expect(existsSync(sessionCwd)).toBe(false);
    });

    it("should remove the --list-models directory when the agent fails to start", async () => {
      const { spawn } = await import("node:child_process");
      mockConnection({ initialize: vi.fn().mockRejectedValue(new Error("boom")) });

      await expect(
        runAgentCommand("list-models", ["gemini", "--acp"], agentrqConfig.env),
      ).rejects.toThrow();

      const cwd = (vi.mocked(spawn).mock.calls.at(-1)![2] as any).cwd;
      expect(cwd.startsWith(tmpdir())).toBe(true);
      expect(existsSync(cwd)).toBe(false);
    });

    it("should leave the other commands running where the gateway runs", async () => {
      const { spawn } = await import("node:child_process");
      mockConnection({});

      await runAgentCommand("agent-info", ["gemini", "--acp"], agentrqConfig.env);

      expect(vi.mocked(spawn).mock.calls.at(-1)![2]).not.toHaveProperty("cwd");
    });

    it("should list models from configOptions and cleanly close session", async () => {
      mockConnection({
        newSession: vi.fn().mockResolvedValue({
          sessionId: "m-sess",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "claude-3-7-sonnet",
              options: [
                { value: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
                { value: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
              ],
            },
          ],
        }),
      });

      await runAgentCommand("list-models", ["gemini", "--acp"], agentrqConfig.env);

      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("Models supported by \"gemini --acp\":");
      expect(printed).toContain("claude-3-7-sonnet");
      expect(printed).toContain("Claude 3.7 Sonnet");
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should list models with no workspace behind it", async () => {
      mockConnection({
        newSession: vi.fn().mockResolvedValue({
          sessionId: "m-sess",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gemini-pro",
              options: [{ value: "gemini-pro", name: "Gemini Pro" }],
            },
          ],
        }),
      });

      await runAgentCommand(
        "list-models",
        ["gemini", "--acp"],
        {},
      );

      expect(logSpy.mock.calls.flat().join("\n")).toContain("gemini-pro");
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should print models as a single JSON line when asked for JSON", async () => {
      mockConnection({
        newSession: vi.fn().mockResolvedValue({
          sessionId: "m-sess",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "claude-3-7-sonnet",
              options: [
                {
                  value: "claude-3-7-sonnet",
                  name: "Claude 3.7 Sonnet",
                  description: "Balanced",
                },
                { value: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
              ],
            },
          ],
        }),
      });

      await runAgentCommand(
        "list-models",
        ["gemini", "--acp"],
        agentrqConfig.env,
        undefined,
        true,
      );

      // The most recent call, not the only one: logSpy is shared across this
      // describe's tests (recreated on the same already-mocked console.log,
      // which vitest hands back rather than a fresh spy each time), so
      // earlier tests' output is still in its history. Nothing this call logs
      // after its own JSON line, so the last entry is always this test's.
      const lastLog = logSpy.mock.calls.at(-1)?.[0];
      expect(JSON.parse(lastLog)).toEqual({
        agent: "gemini --acp",
        models: [
          {
            id: "claude-3-7-sonnet",
            name: "Claude 3.7 Sonnet",
            description: "Balanced",
            current: true,
          },
          { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku", description: "", current: false },
        ],
      });
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should report an empty JSON model list rather than the free-text fallback", async () => {
      mockConnection({
        newSession: vi.fn().mockResolvedValue({ sessionId: "m-sess", configOptions: [] }),
      });

      await runAgentCommand(
        "list-models",
        ["gemini", "--acp"],
        agentrqConfig.env,
        undefined,
        true,
      );

      const lastLog = logSpy.mock.calls.at(-1)?.[0];
      expect(JSON.parse(lastLog)).toEqual({ agent: "gemini --acp", models: [] });
    });

    it("should list models from unstable_listProviders fallback", async () => {
      mockConnection({
        newSession: vi.fn().mockResolvedValue({ sessionId: "m-sess", configOptions: [] }),
        unstable_listProviders: vi.fn().mockResolvedValue({
          providers: [
            {
              providerId: "anthropic",
              supported: ["claude-sonnet"],
            },
          ],
        }),
      }, {
        agentCapabilities: { providers: true },
      });

      await runAgentCommand("list-models", ["gemini", "--acp"], agentrqConfig.env);

      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("Configurable providers for \"gemini --acp\":");
      expect(printed).toContain("claude-sonnet");
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should report when agent advertises no models", async () => {
      mockConnection({
        newSession: vi.fn().mockResolvedValue({ sessionId: "m-sess", configOptions: [] }),
      });

      await runAgentCommand("list-models", ["gemini", "--acp"], agentrqConfig.env);

      const printed = logSpy.mock.calls.flat().join("\n");
      expect(printed).toContain("No configurable models advertised by \"gemini --acp\".");
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should print what the agent says it supports", async () => {
      mockConnection({}, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          mcpCapabilities: { http: true },
        },
      });

      await runAgentCommand("agent-info", ["gemini", "--acp"], agentrqConfig.env);

      const printed = String(logSpy.mock.calls.at(-1)[0]);
      expect(printed).toContain("gemini --acp");
      expect(printed).toContain("ACP protocol version 1");
      expect(printed).toContain("session/resume  yes");
      expect(printed).toContain("session/close   no");
      expect(printed).toContain("http  yes");
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });

    it("should report agents that advertise no login", async () => {
      mockConnection({});

      await runAgentCommand("list-auth-methods", ["gemini", "--acp"], agentrqConfig.env);

      expect(logSpy.mock.calls.flat().join("\n")).toContain("no authentication methods");
    });

    it("should log out", async () => {
      const connection = mockConnection({ logout: vi.fn().mockResolvedValue({}) }, {
        agentCapabilities: { auth: { logout: {} } },
      });

      await runAgentCommand("logout", ["gemini", "--acp"], agentrqConfig.env);

      expect(connection.logout).toHaveBeenCalledWith({});
    });

    it("should log in with the method the user named", async () => {
      const connection = mockConnection({ authenticate: vi.fn().mockResolvedValue({}) }, {
        authMethods: [
          { id: "agent-login", name: "Agent login" },
          { id: "oauth", name: "OAuth" },
        ],
      });

      await runAgentCommand("login", ["gemini", "--acp"], agentrqConfig.env, "oauth");

      expect(connection.authenticate).toHaveBeenCalledWith({ methodId: "oauth" });
    });

    it("should still shut the agent down when the login fails", async () => {
      mockConnection({ authenticate: vi.fn() }, {
        authMethods: [{ id: "agent-login", name: "Agent login" }],
      });

      await expect(
        runAgentCommand("login", ["gemini", "--acp"], agentrqConfig.env, "missing"),
      ).rejects.toThrow(/Unknown authentication method/);
      expect(spawnedAgents[0].kill).toHaveBeenCalled();
    });
  });

  describe("nativeOptionsFor", () => {
    const agentrq: McpServerConfig = {
      name: "agentrq",
      type: "http",
      url: "https://4hro0x9eslxd.mcp.agentrq.com/?token=t",
      env: { A: "1" },
    };

    it("derives the endpoint and passes every option through as a header value", () => {
      const options = parseGatewayArgs([
        "--acp-version", "1", "--agent", "codex-acp", "--model", "m", "--effort", "high", "--max-concurrency", "4",
        "--permission-timeout", "5", "--auth-method", "chatgpt",
      ]);
      expect(nativeOptionsFor(options, ["npx", "codex-acp"], agentrq, "/work")).toEqual({
        acpCmdArgs: ["npx", "codex-acp"],
        env: { A: "1" },
        endpoint: "wss://4hro0x9eslxd.mcp.agentrq.com/api/acp/v1",
        token: "t",
        agentId: "codex-acp",
        modelId: "m",
        effort: "high",
        maxConcurrency: 4,
        permissionTimeoutMinutes: 5,
        authMethodId: "chatgpt",
        cwd: "/work",
      });
    });

    it("parses --effort and warns when missing a value", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const optsWithVal = parseGatewayArgs(["--effort", "medium"]);
      expect(optsWithVal.effort).toBe("medium");

      const optsNoVal = parseGatewayArgs(["--effort", "--verbose"]);
      expect(optsNoVal.effort).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[acp] Warning: --effort provided without a level; ignoring.",
      );
      consoleSpy.mockRestore();
    });

    it("names a command-line agent by its basename and honours --acp-url", () => {
      const options = parseGatewayArgs(["--acp-url", "ws://other/x"]);
      const native = nativeOptionsFor(options, ["/opt/bin/gemini", "--acp"], agentrq);
      expect(native).toMatchObject({ agentId: "gemini", endpoint: "ws://other/x", cwd: process.cwd() });
    });

    it("needs the workspace token", () => {
      const options = parseGatewayArgs(["--acp-version", "1"]);
      expect(nativeOptionsFor(options, ["a"], { ...agentrq, url: "https://h/" })).toBe(
        "acp-gateway needs the workspace token from .mcp.json",
      );
    });

    it("needs a URL, from .mcp.json or --acp-url", () => {
      const options = parseGatewayArgs(["--acp-version", "1"]);
      expect(
        nativeOptionsFor(options, ["a"], { name: "x", type: "http", headers: { Authorization: "Bearer t" } }),
      ).toMatch(/needs the AgentRQ URL/);
    });

    it("explains a URL it cannot read", () => {
      const options = parseGatewayArgs(["--acp-version", "1"]);
      expect(
        nativeOptionsFor(options, ["a"], { name: "x", type: "http", url: "not a url", headers: { Authorization: "Bearer t" } }),
      ).toMatch(/cannot work out the AgentRQ endpoint from "not a url"; pass --acp-url/);
    });

    it("starts native mode with those options", async () => {
      const run = vi.fn(async () => {});
      const exit = vi.fn();
      await startNativeMode(parseGatewayArgs(["--acp-version", "1"]), ["a"], agentrq, run, exit);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "wss://4hro0x9eslxd.mcp.agentrq.com/api/acp/v1", token: "t" }));
      expect(exit).not.toHaveBeenCalled();
    });

    it("says why native mode cannot start and exits 1", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const run = vi.fn(async () => {});
      const exit = vi.fn();
      await startNativeMode(parseGatewayArgs(["--acp-version", "1"]), ["a"], { name: "x", type: "http", url: "https://h/" }, run, exit);
      expect(errorSpy).toHaveBeenCalledWith("[acp-gateway] acp-gateway needs the workspace token from .mcp.json");
      expect(exit).toHaveBeenCalledWith(1);
      expect(run).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("always connects to the ACP v1 endpoint", () => {
      const options = parseGatewayArgs([]);
      expect(nativeOptionsFor(options, [], agentrq)).toMatchObject({
        endpoint: "wss://4hro0x9eslxd.mcp.agentrq.com/api/acp/v1",
        agentId: "",
      });
    });
  });

  describe("runGateway", () => {
    let errorSpy: any;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    /** A workspace directory whose .mcp.json names an AgentRQ server. */
    function workspaceDir(): string {
      const dir = join(mkdtempSync(join(tmpdir(), "acp-gw-run-")), "a", "b", "c", "d");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: { agentrq: { type: "http", url: "https://h.mcp.agentrq.com/?token=t", env: { A: "1" } } },
        }),
      );
      return dir;
    }

    function deps(over: Record<string, any> = {}) {
      return {
        resolve: vi.fn(async () => ({ command: [process.execPath, "agent.js"] })),
        agentCommand: vi.fn(async () => {}),
        bridge: vi.fn(async () => {}),
        exit: vi.fn(),
        startDir: workspaceDir(),
        ...over,
      };
    }

    it("bridges the agent to the workspace's ACP endpoint for run", async () => {
      const d = deps();
      const options = parseGatewayArgs([]);

      await runGateway(options, ["agent"], d);

      expect(d.resolve).toHaveBeenCalledWith(options, ["agent"]);
      expect(d.bridge).toHaveBeenCalledWith(
        options,
        [process.execPath, "agent.js"],
        expect.objectContaining({ name: "agentrq", env: { A: "1" } }),
      );
      expect(d.agentCommand).not.toHaveBeenCalled();
      expect(d.exit).not.toHaveBeenCalled();
    });

    it("adds the registry entry's env to the agent's", async () => {
      const d = deps({
        resolve: vi.fn(async () => ({ command: [process.execPath], env: { B: "2" } })),
      });

      await runGateway(parseGatewayArgs(["--agent", "x"]), [], d);

      expect((d.bridge.mock.calls[0] as any[])[2].env).toEqual({ A: "1", B: "2" });
    });

    it("runs a one-shot command without a workspace and exits 0", async () => {
      const d = deps({ startDir: tmpdir() });

      await runGateway(parseGatewayArgs(["--login", "oauth", "--json"]), ["agent"], d);

      expect(d.agentCommand).toHaveBeenCalledWith(
        "login",
        [process.execPath, "agent.js"],
        {},
        "oauth",
        true,
      );
      expect(d.bridge).not.toHaveBeenCalled();
      expect(d.exit).toHaveBeenCalledWith(0);
    });

    it("says why it cannot run, without a stack trace, and exits 1", async () => {
      const root = mkdtempSync(join(tmpdir(), "acp-gw-noworkspace-"));
      const dir = join(root, "a", "b", "c", "d");
      mkdirSync(dir, { recursive: true });
      const d = deps({ startDir: dir });

      await runGateway(parseGatewayArgs([]), ["agent"], d);

      expect(errorSpy.mock.calls[0][0]).toMatch(/^\[acp-gateway\] Could not find \.mcp\.json/);
      expect(d.exit).toHaveBeenCalledWith(1);
      expect(d.bridge).not.toHaveBeenCalled();
    });

    it("refuses an agent command that is not installed", async () => {
      const d = deps({
        resolve: vi.fn(async () => ({ command: ["definitely-not-an-agent-xyz"] })),
      });

      await runGateway(parseGatewayArgs([]), ["definitely-not-an-agent-xyz"], d);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Agent command "definitely-not-an-agent-xyz" was not found'),
      );
      expect(d.exit).toHaveBeenCalledWith(1);
    });

    it("reports a failure that is not an Error as it is", async () => {
      const d = deps({ resolve: vi.fn(async () => Promise.reject("registry down")) });

      await runGateway(parseGatewayArgs([]), [], d);

      expect(errorSpy).toHaveBeenCalledWith("[acp-gateway] registry down");
      expect(d.exit).toHaveBeenCalledWith(1);
    });
  });

  describe("helpText", () => {
    it("should explain every option the parser accepts", () => {
      const text = helpText("9.9.9");

      // Every documented flag must be one parseGatewayArgs actually handles,
      // and every flag it handles must be documented.
      const documented = [...text.matchAll(/^\s{2}(--[a-z-]+|-h)/gm)].map((m) => m[1]);
      expect(new Set(documented)).toEqual(
        new Set([
          "--agent",
          "--list-agents",
          "--agent-info",
          "--allow-unverified-agent",
          "--registry-url",
          "--list-models",
          "--json",
          "--model",
          "--effort",
          "--list-auth-methods",
          "--login",
          "--logout",
          "--auth-method",
          "--max-concurrency",
          "--permission-timeout",
          "--mcp-json",
          "--acp-url",
          "--verbose",
          "--help",
        ]),
      );
    });

    it("should name the version and show how to run an agent both ways", () => {
      const text = helpText("9.9.9");

      expect(text).toContain("acp-gateway 9.9.9");
      expect(text).toContain("acp-gateway --agent gemini");
      expect(text).toContain("acp-gateway -- gemini --acp");
      expect(text).toContain(".mcp.json");
    });

    it("should say why an unverified agent is not installed by default", () => {
      expect(helpText()).toMatch(/no way to tell what was downloaded/);
    });

    it("should document the default concurrency of 1", () => {
      expect(helpText()).toContain("Defaults to 1.");
    });

    it("should document the concurrency range and that agentrq can change it", () => {
      expect(helpText()).toContain("1 to 64.");
      expect(helpText()).toContain("agentrq can change it while running.");
    });
  });

  describe("printHelp", () => {
    it("should print the help text", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      printHelp();
      const printed = logSpy.mock.calls.flat().join("\n");
      logSpy.mockRestore();

      expect(printed).toContain("USAGE");
      expect(printed).toContain("--list-agents");
    });
  });

  describe("isInteractiveTerminal", () => {
    it("should be true only when both stdin and stderr are a TTY", () => {
      const original = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
      try {
        process.stdin.isTTY = true;
        process.stderr.isTTY = true;
        expect(isInteractiveTerminal()).toBe(true);

        process.stderr.isTTY = false;
        expect(isInteractiveTerminal()).toBe(false);
      } finally {
        process.stdin.isTTY = original.stdin;
        process.stderr.isTTY = original.stderr;
      }
    });
  });

  describe("session lifecycle and clean close", () => {
    describe("supportsCloseSession", () => {
      it("returns true when close is an object {}", () => {
        expect(
          supportsCloseSession({
            sessionCapabilities: { close: {} },
          } as any),
        ).toBe(true);
      });

      it("returns true when close is boolean true", () => {
        expect(
          supportsCloseSession({
            sessionCapabilities: { close: true as any },
          } as any),
        ).toBe(true);
      });

      it("returns false when close is false", () => {
        expect(
          supportsCloseSession({
            sessionCapabilities: { close: false as any },
          } as any),
        ).toBe(false);
      });

      it("returns false when close is null or undefined", () => {
        expect(
          supportsCloseSession({
            sessionCapabilities: { close: null },
          } as any),
        ).toBe(false);
        expect(
          supportsCloseSession({
            sessionCapabilities: {},
          } as any),
        ).toBe(false);
      });

      it("returns false when sessionCapabilities or agentCapabilities is missing", () => {
        expect(supportsCloseSession({} as any)).toBe(false);
        expect(supportsCloseSession(null)).toBe(false);
        expect(supportsCloseSession(undefined)).toBe(false);
      });
    });

    describe("closeSession", () => {
      let errorSpy: any;
      beforeEach(() => {
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      });
      afterEach(() => {
        errorSpy.mockRestore();
      });

      it("sends closeSession if supported, and kills process", async () => {
        const cancelTurn = vi.fn().mockResolvedValue(undefined);
        const closeSessionRpc = vi.fn().mockResolvedValue({});
        const kill = vi.fn();

        const session: any = {
          sessionId: "sess-1",
          acpClient: { cancelTurn },
          connection: { closeSession: closeSessionRpc },
          initResult: { agentCapabilities: { sessionCapabilities: { close: {} } } },
          process: { kill },
        };

        await closeSession(session);

        expect(closeSessionRpc).toHaveBeenCalledWith({ sessionId: "sess-1" });
        expect(kill).toHaveBeenCalled();
      });

      it("does not call closeSession RPC if not supported by agent", async () => {
        const cancelTurn = vi.fn().mockResolvedValue(undefined);
        const closeSessionRpc = vi.fn().mockResolvedValue({});
        const kill = vi.fn();

        const session: any = {
          sessionId: "sess-no-close",
          acpClient: { cancelTurn },
          connection: { closeSession: closeSessionRpc },
          initResult: { agentCapabilities: { sessionCapabilities: {} } },
          process: { kill },
        };

        await closeSession(session);

        expect(closeSessionRpc).not.toHaveBeenCalled();
        expect(kill).toHaveBeenCalled();
      });

      it("handles error during closeSession RPC gracefully", async () => {
        const cancelTurn = vi.fn().mockResolvedValue(undefined);
        const closeSessionRpc = vi.fn().mockRejectedValue(new Error("close RPC failed"));
        const kill = vi.fn();

        const session: any = {
          sessionId: "sess-err-close",
          acpClient: { cancelTurn },
          connection: { closeSession: closeSessionRpc },
          initResult: { agentCapabilities: { sessionCapabilities: { close: {} } } },
          process: { kill },
        };

        await closeSession(session);

        expect(closeSessionRpc).toHaveBeenCalledWith({ sessionId: "sess-err-close" });
        expect(kill).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Failed to cleanly close session sess-err-close"),
          expect.any(Error),
        );
      });

      it("times out if closeSession RPC hangs", async () => {
        const cancelTurn = vi.fn().mockResolvedValue(undefined);
        const closeSessionRpc = vi.fn().mockImplementation(() => new Promise(() => {}));
        const kill = vi.fn();

        const session: any = {
          sessionId: "sess-hang",
          acpClient: { cancelTurn },
          connection: { closeSession: closeSessionRpc },
          initResult: { agentCapabilities: { sessionCapabilities: { close: {} } } },
          process: { kill },
        };

        await closeSession(session, 10);

        expect(kill).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("session/close for sess-hang did not complete in 10ms"),
        );
      });

      it("handles missing or throwing process.kill gracefully", async () => {
        const cancelTurn = vi.fn().mockResolvedValue(undefined);
        const session: any = {
          sessionId: "sess-no-proc",
          acpClient: { cancelTurn },
          connection: {},
          initResult: {},
          process: {
            kill: vi.fn().mockImplementation(() => {
              throw new Error("process already dead");
            }),
          },
        };

        await expect(closeSession(session)).resolves.not.toThrow();
      });
    });
  });
});
