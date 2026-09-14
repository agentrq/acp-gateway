import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadMcpConfig, pickAgentrqServer } from "../config.js";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("node:fs");
vi.mock("node:path");

describe("config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loadMcpConfig", () => {
    it("should parse .mcp.json and return server configs", () => {
      vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        mcpServers: {
          "agentrq": {
            type: "http",
            url: "http://localhost:8080"
          }
        }
      }));

      const configs = loadMcpConfig("/dummy");
      expect(configs).toHaveLength(1);
      expect(configs[0]).toEqual({
        name: "agentrq",
        type: "http",
        url: "http://localhost:8080",
        args: undefined,
        command: undefined,
        env: undefined,
        headers: undefined,
      });
    });

    it("should pass an sse server through as its own transport", () => {
      vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        mcpServers: { "events": { type: "sse", url: "http://example.com/sse" } }
      }));

      expect(loadMcpConfig("/dummy")[0].type).toBe("sse");
    });

    it("should refuse a transport it cannot hand to an agent", () => {
      vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        mcpServers: { "odd": { type: "websocket", url: "ws://example.com" } }
      }));

      // Silently treating this as stdio produced a server with no command and
      // an agent that could not say what was wrong.
      expect(() => loadMcpConfig("/dummy")).toThrow(/transport "websocket"/);
      expect(() => loadMcpConfig("/dummy")).toThrow(/http, sse, stdio/);
    });

    it("should refuse an entry missing the field its transport needs", () => {
      vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        mcpServers: { "agentrq": { type: "http" } }
      }));
      expect(() => loadMcpConfig("/dummy")).toThrow(/is http but has no url/);

      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        mcpServers: { "local": { type: "stdio", args: ["x"] } }
      }));
      expect(() => loadMcpConfig("/dummy")).toThrow(/is stdio but has no command/);
    });

    it("should report a mistake in the file it found rather than looking further up", () => {
      vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        mcpServers: { "odd": { type: "websocket", url: "ws://example.com" } }
      }));

      expect(() => loadMcpConfig("/dummy")).not.toThrow(/Could not find/);
    });

    it("should keep looking when a candidate file cannot be read or parsed", () => {
      vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      vi.mocked(readFileSync)
        .mockImplementationOnce(() => { throw new Error("ENOENT"); })
        .mockReturnValueOnce("{ not json")
        .mockReturnValue(JSON.stringify({
          mcpServers: { "agentrq": { type: "http", url: "http://localhost:8080" } }
        }) as any);

      expect(loadMcpConfig("/dummy")[0].name).toBe("agentrq");
    });

    it("should handle missing mcpServers in JSON", () => {
      vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
      expect(() => loadMcpConfig("/dummy")).toThrow("Could not find .mcp.json");
    });

    it("should infer type based on url presence", () => {
      vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        mcpServers: {
          "http-server": { url: "http://example.com" },
          "stdio-server": { command: "node", args: ["server.js"] }
        }
      }));

      const configs = loadMcpConfig("/dummy");
      expect(configs).toHaveLength(2);
      expect(configs[0].type).toBe("http");
      expect(configs[1].type).toBe("stdio");
    });

    it("should throw error if no .mcp.json is found", () => {
      vi.mocked(readFileSync).mockImplementation(() => { throw new Error("not found"); });
      expect(() => loadMcpConfig("/dummy")).toThrow("Could not find .mcp.json");
    });

    describe("a config named with --mcp-json", () => {
      const missing = () => { throw new Error("ENOENT"); };
      const json = (servers: Record<string, unknown>) =>
        JSON.stringify({ mcpServers: servers });

      beforeEach(() => {
        vi.mocked(resolve).mockImplementation((...args: string[]) => args.join("/"));
      });

      it("reads it whatever the file is called", () => {
        // The name is a convention, not a requirement — someone keeping their
        // workspaces apart names the files after the workspaces.
        vi.mocked(readFileSync)
          .mockReturnValueOnce(json({ agentrq: { type: "http", url: "http://named" } }))
          .mockImplementation(missing);

        const configs = loadMcpConfig("/dummy", "/elsewhere/work-servers.json");

        expect(readFileSync).toHaveBeenCalledWith("/elsewhere/work-servers.json", "utf-8");
        expect(configs).toHaveLength(1);
        expect(configs[0].url).toBe("http://named");
      });

      it("reads it as well as the one near the working directory", () => {
        // "In addition to", not "instead of": the flag adds a workspace rather
        // than hiding whatever is in the directory.
        vi.mocked(readFileSync)
          .mockReturnValueOnce(json({ named: { type: "http", url: "http://named" } }))
          .mockReturnValueOnce(json({ nearby: { type: "http", url: "http://nearby" } }))
          .mockImplementation(missing);

        const configs = loadMcpConfig("/dummy", "/elsewhere/servers.json");

        expect(configs.map((c) => c.name)).toEqual(["named", "nearby"]);
      });

      it("lets the named file win where a name collides", () => {
        // It was pointed at deliberately; the other was merely nearby. This
        // also decides pickAgentrqServer's fallback in its favour.
        vi.mocked(readFileSync)
          .mockReturnValueOnce(json({ agentrq: { type: "http", url: "http://named" } }))
          .mockReturnValueOnce(json({
            agentrq: { type: "http", url: "http://nearby" },
            other: { type: "http", url: "http://other" },
          }))
          .mockImplementation(missing);

        const configs = loadMcpConfig("/dummy", "/elsewhere/servers.json");

        expect(configs).toHaveLength(2);
        expect(configs.find((c) => c.name === "agentrq")!.url).toBe("http://named");
        expect(pickAgentrqServer(configs).url).toBe("http://named");
      });

      it("refuses a path it cannot read rather than falling back to the directory", () => {
        // A mistyped path quietly becoming "whatever .mcp.json is lying around"
        // would not look like a failure — it would look like it worked, while
        // connecting the agent to the wrong workspace.
        vi.mocked(readFileSync)
          .mockImplementationOnce(missing)
          .mockReturnValue(json({ nearby: { type: "http", url: "http://nearby" } }) as any);

        expect(() => loadMcpConfig("/dummy", "/typo/servers.json")).toThrow(
          /Could not read the MCP config at \/typo\/servers\.json/,
        );
      });

      it("reports a read failure that was not thrown as an Error", () => {
        vi.mocked(readFileSync).mockImplementationOnce(() => { throw "permission denied"; });

        expect(() => loadMcpConfig("/dummy", "/elsewhere/servers.json")).toThrow(
          /Could not read the MCP config at \/elsewhere\/servers\.json: permission denied/,
        );
      });

      it("says when the named file is not JSON", () => {
        // Told apart from a missing file on purpose: the two send someone to
        // two different places.
        vi.mocked(readFileSync).mockReturnValueOnce("{ not json" as any);

        expect(() => loadMcpConfig("/dummy", "/elsewhere/servers.json")).toThrow(
          /is not valid JSON/,
        );
      });

      it("says when the named file defines no servers", () => {
        // Different from finding nothing anywhere: the file is right there.
        vi.mocked(readFileSync).mockReturnValueOnce(json({}) as any);

        expect(() => loadMcpConfig("/dummy", "/elsewhere/servers.json")).toThrow(
          /defines no MCP servers/,
        );
      });

      it("takes a directory to mean the .mcp.json inside it", () => {
        // Handing a flag the folder instead of the file is an easy slip and a
        // pointless way to fail.
        vi.mocked(statSync).mockReturnValueOnce({ isDirectory: () => true } as any);
        vi.mocked(readFileSync)
          .mockReturnValueOnce(json({ agentrq: { type: "http", url: "http://named" } }))
          .mockImplementation(missing);

        loadMcpConfig("/dummy", "/elsewhere");

        expect(readFileSync).toHaveBeenCalledWith("/elsewhere/.mcp.json", "utf-8");
      });

      it("does not need a config near the working directory at all", () => {
        // Pointing at a file is a complete answer on its own.
        vi.mocked(readFileSync)
          .mockReturnValueOnce(json({ agentrq: { type: "http", url: "http://named" } }))
          .mockImplementation(missing);

        expect(loadMcpConfig("/nowhere-useful", "/elsewhere/servers.json")).toHaveLength(1);
      });

      it("names the file it is complaining about", () => {
        // The message used to say ".mcp.json" regardless, which names nothing
        // when the file is called something else and there are two in play.
        vi.mocked(readFileSync)
          .mockReturnValueOnce(json({ odd: { type: "websocket", url: "ws://x" } }));

        expect(() => loadMcpConfig("/dummy", "/elsewhere/servers.json")).toThrow(
          /in \/elsewhere\/servers\.json has transport "websocket"/,
        );
      });
    });
  });

  describe("pickAgentrqServer", () => {
    it("should prefer server with agentrq in its name", () => {
      const servers = [
        { name: "other", type: "http", url: "http://other" },
        { name: "my-agentrq-server", type: "http", url: "http://agentrq" }
      ] as any;

      const picked = pickAgentrqServer(servers);
      expect(picked.name).toBe("my-agentrq-server");
    });

    it("should fall back to first HTTP server", () => {
      const servers = [
        { name: "other", type: "http", url: "http://other" }
      ] as any;

      const picked = pickAgentrqServer(servers);
      expect(picked.name).toBe("other");
    });

    it("should throw error if no HTTP server found", () => {
      const servers = [
        { name: "stdio-server", type: "stdio", command: "ls" }
      ] as any;

      expect(() => pickAgentrqServer(servers)).toThrow("No HTTP MCP server found");
    });
  });
});
