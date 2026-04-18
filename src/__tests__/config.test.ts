import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadMcpConfig, pickAgentrqServer } from "../config.js";
import { readFileSync } from "node:fs";
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
      });
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
