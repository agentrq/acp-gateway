import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../config.js";
import { helpText, main, parseGatewayArgs, runMcpCommand, startNativeMode } from "../index.js";

let root: string;
let workspace: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-cli-test-"));
  // Deep enough that no .mcp.json above the temp dir is found.
  workspace = join(root, "a", "b", "c", "d");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "agentrq-workspace": { type: "http", url: "https://agentrq/mcp", headers: { Authorization: "Bearer t" } },
        docs: { type: "http", url: "https://docs/mcp" },
      },
    }),
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseGatewayArgs: MCP login flags", () => {
  it("reads --mcp-login and --mcp-logout with the server's name", () => {
    expect(parseGatewayArgs(["--mcp-login", "docs"])).toMatchObject({ command: "mcp-login", mcpServerName: "docs" });
    expect(parseGatewayArgs(["--mcp-logout", "docs"])).toMatchObject({ command: "mcp-logout", mcpServerName: "docs" });
    const bare = parseGatewayArgs(["--mcp-login", "--verbose"]);
    expect(bare).toMatchObject({ command: "mcp-login", verbose: true });
    expect(bare.mcpServerName).toBeUndefined();
  });
});

describe("runMcpCommand", () => {
  it("signs in to the named server, saying whether someone is at the terminal", async () => {
    const login = vi.fn(async () => {});
    await runMcpCommand(parseGatewayArgs(["--mcp-login", "docs"]), workspace, { login });
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ name: "docs", url: "https://docs/mcp" }),
      { interactive: expect.any(Boolean) },
    );
  });

  it("signs out of the named server", async () => {
    const logout = vi.fn();
    await runMcpCommand(parseGatewayArgs(["--mcp-logout", "docs"]), workspace, { logout });
    expect(logout).toHaveBeenCalledWith(expect.objectContaining({ name: "docs" }));
  });

  it("needs a server name, and one .mcp.json has", async () => {
    await expect(runMcpCommand(parseGatewayArgs(["--mcp-login"]), workspace)).rejects.toThrow(
      "--mcp-login needs the name of a server in .mcp.json, e.g. --mcp-login <name>",
    );
    await expect(runMcpCommand(parseGatewayArgs(["--mcp-logout", "nope"]), workspace)).rejects.toThrow(
      'There is no MCP server named "nope" in .mcp.json. It has: agentrq-workspace, docs.',
    );
  });

  it("signs out for real through the default token store", async () => {
    const xdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = root;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runMcpCommand(parseGatewayArgs(["--mcp-logout", "docs"]), workspace);
      expect(errorSpy).toHaveBeenCalledWith('[mcp] acp-gateway had no saved login for "docs".');
    } finally {
      if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = xdg;
    }
  });
});

describe("startNativeMode: MCP logins", () => {
  it("hands every .mcp.json server to the authorizer, skipping the AgentRQ one, before running", async () => {
    const order: string[] = [];
    const authorize = vi.fn(async () => {
      order.push("authorize");
      return () => {};
    });
    const run = vi.fn(async () => {
      order.push("run");
    });
    const agentrq: McpServerConfig = {
      name: "agentrq-workspace",
      type: "http",
      url: "https://4hro0x9eslxd.mcp.agentrq.com/mcp",
      headers: { Authorization: "Bearer t" },
    };
    const docs: McpServerConfig = { name: "docs", type: "http", url: "https://docs/mcp" };
    await startNativeMode(parseGatewayArgs([]), ["a"], { configs: [agentrq, docs], agentrqConfig: agentrq }, run, vi.fn(), authorize);
    expect(authorize).toHaveBeenCalledWith([agentrq, docs], { skip: "agentrq-workspace" });
    expect(order).toEqual(["authorize", "run"]);
  });
});

describe("main", () => {
  const deps = () => ({
    exit: vi.fn(),
    listAgents: vi.fn(async () => {}),
    gateway: vi.fn(async () => {}),
    mcpCommand: vi.fn(async () => {}),
  });

  it("prints help and exits 0 for --help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();
    await main(["--help"], d);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/--mcp-login <name>/));
    expect(d.exit).toHaveBeenCalledWith(0);
    expect(d.gateway).not.toHaveBeenCalled();
  });

  it("lists agents without an agent or workspace", async () => {
    const d = deps();
    await main(["--list-agents", "--json"], d);
    expect(d.listAgents).toHaveBeenCalledWith(undefined, undefined, true);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("runs --mcp-login without an agent, exiting 0, or 1 with the reason", async () => {
    const d = deps();
    await main(["--mcp-login", "docs"], d);
    expect(d.mcpCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "mcp-login", mcpServerName: "docs" }));
    expect(d.exit).toHaveBeenCalledWith(0);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = deps();
    failing.mcpCommand.mockRejectedValueOnce(new Error("no such server"));
    await main(["--mcp-logout", "x"], failing);
    expect(error).toHaveBeenCalledWith("[acp-gateway] no such server");
    expect(failing.exit).toHaveBeenCalledWith(1);

    const odd = deps();
    odd.mcpCommand.mockRejectedValueOnce("plain");
    await main(["--mcp-logout", "x"], odd);
    expect(error).toHaveBeenCalledWith("[acp-gateway] plain");
  });

  it("shows help and exits 1 with nothing to run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();
    await main([], d);
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.gateway).not.toHaveBeenCalled();
  });

  it("hands an agent command to the gateway, with or without --", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const d = deps();
    await main(["--verbose", "--", "gemini", "--acp"], d);
    expect(d.gateway).toHaveBeenCalledWith(expect.objectContaining({ verbose: true }), ["gemini", "--acp"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Starting \[acp-gateway\]/));

    await main(["--agent", "gemini", "--json", "--list-models"], d);
    expect(d.gateway).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "gemini" }), []);
    expect(d.exit).not.toHaveBeenCalled();
  });
});

describe("helpText", () => {
  it("documents the MCP login flags", () => {
    const text = helpText("1.0.0");
    expect(text).toMatch(/--mcp-login <name>/);
    expect(text).toMatch(/--mcp-logout <name>/);
  });
});
