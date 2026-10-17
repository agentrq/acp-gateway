import { describe, it, expect, vi, afterEach } from "vitest";
import { mapMcpServers } from "../mcpServers.js";
import { setVerbose } from "../log.js";
import type { McpServerConfig } from "../config.js";

describe("mapMcpServers", () => {
  afterEach(() => setVerbose(false));

  it("should correctly map HTTP servers with headers", () => {
    const configs: McpServerConfig[] = [{
      type: "http",
      name: "test-http",
      url: "http://localhost:8000",
      env: { Authorization: "Bearer env-token" },
      headers: { Authorization: "Bearer header-token", Custom: "Header" },
    }];
    expect(mapMcpServers(configs)).toEqual([{
      type: "http",
      name: "test-http",
      url: "http://localhost:8000",
      headers: [
        { name: "Authorization", value: "Bearer header-token" },
        { name: "Custom", value: "Header" },
      ],
    }]);
  });

  it("should default headers to empty for HTTP servers", () => {
    expect(mapMcpServers([{ type: "http", name: "h", url: "http://x" }])).toEqual([
      { type: "http", name: "h", url: "http://x", headers: [] },
    ]);
  });

  it("should map an sse server as its own transport", () => {
    expect(
      mapMcpServers([{ type: "sse", name: "events", url: "http://x/sse" }], { mcpCapabilities: { sse: true } } as any),
    ).toEqual([{ type: "sse", name: "events", url: "http://x/sse", headers: [] }]);
  });

  it("should leave out a transport the agent says it does not support", () => {
    setVerbose(true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const configs: McpServerConfig[] = [
      { type: "http", name: "remote", url: "http://localhost:8000" },
      { type: "stdio", name: "local", command: "npx" },
    ];

    // An agent may refuse the whole session/new rather than skip one entry.
    const result = mapMcpServers(configs, { mcpCapabilities: { http: false, sse: false } } as any);

    expect(result.map((s: any) => s.name)).toEqual(["local"]);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain('Not passing MCP server "remote"');
    errorSpy.mockRestore();
  });

  it("should still hand over a transport the agent never mentions", () => {
    const configs: McpServerConfig[] = [{ type: "http", name: "remote", url: "http://localhost:8000" }];

    // A terse agent is likelier than one that genuinely cannot reach HTTP,
    // and dropping this would take the workspace's own server away from it.
    expect(mapMcpServers(configs, {} as any).map((s: any) => s.name)).toEqual(["remote"]);
    expect(mapMcpServers(configs, { mcpCapabilities: { http: true } } as any).map((s: any) => s.name)).toEqual(["remote"]);
    expect(mapMcpServers(configs).map((s: any) => s.name)).toEqual(["remote"]);
  });

  it("should correctly map stdio servers", () => {
    expect(
      mapMcpServers([{ type: "stdio", name: "s", command: "npx", args: ["-y", "pkg"], env: { API_KEY: "secret" } }]),
    ).toEqual([{ name: "s", command: "npx", args: ["-y", "pkg"], env: [{ name: "API_KEY", value: "secret" }] }]);
  });

  it("should default args and env to empty for stdio servers", () => {
    expect(mapMcpServers([{ type: "stdio", name: "m", command: "echo" }])).toEqual([
      { name: "m", command: "echo", args: [], env: [] },
    ]);
  });
});
