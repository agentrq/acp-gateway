import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_REGISTRY_URL,
  availableKinds,
  describeAgents,
  fetchRegistry,
  findAgent,
  hostPlatformTarget,
  packageLaunchSpec,
  selectBinaryTarget,
  type Registry,
  type RegistryAgent,
} from "../registry.js";

const gemini: RegistryAgent = {
  id: "gemini",
  name: "Gemini CLI",
  version: "0.58.0",
  description: "Google's official CLI for Gemini",
  distribution: {
    npx: { package: "@google/gemini-cli@0.58.0", args: ["--acp"] },
  },
};

const antigravity: RegistryAgent = {
  id: "antigravity-acp",
  name: "Google Antigravity",
  version: "1.0.0",
  description: "Google's AI coding agent",
  distribution: {
    binary: {
      "darwin-aarch64": {
        archive: "https://dl.google.com/agy/darwin-arm64.zip",
        cmd: "./agy_acp_server.par",
      },
      "linux-x86_64": {
        archive: "https://dl.google.com/agy/linux-x86_64.zip",
        sha256: "a".repeat(64),
        cmd: "./agy_acp_server.par",
        args: ["--uid="],
      },
    },
  },
};

const fastAgent: RegistryAgent = {
  id: "fast-agent",
  name: "fast-agent",
  version: "1.0.0",
  description: "A Python agent",
  distribution: { uvx: { package: "fast-agent-mcp", args: ["serve"] } },
};

const registry: Registry = {
  version: "1.0.0",
  agents: [gemini, antigravity, fastAgent],
};

function jsonResponse(body: unknown, init: Partial<Response> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    ...init,
  } as Response;
}

describe("registry", () => {
  describe("hostPlatformTarget", () => {
    it("maps Node's platform and arch onto the registry's identifiers", () => {
      expect(hostPlatformTarget("darwin", "arm64")).toBe("darwin-aarch64");
      expect(hostPlatformTarget("darwin", "x64")).toBe("darwin-x86_64");
      expect(hostPlatformTarget("linux", "arm64")).toBe("linux-aarch64");
      expect(hostPlatformTarget("linux", "x64")).toBe("linux-x86_64");
      expect(hostPlatformTarget("win32", "x64")).toBe("windows-x86_64");
      expect(hostPlatformTarget("win32", "arm64")).toBe("windows-aarch64");
    });

    it("returns nothing for platforms the registry does not publish for", () => {
      expect(hostPlatformTarget("freebsd", "x64")).toBeUndefined();
      expect(hostPlatformTarget("linux", "ppc64")).toBeUndefined();
    });

    it("describes the machine it is running on by default", () => {
      // Every platform this package supports is one the registry publishes for.
      expect(hostPlatformTarget()).toMatch(/^(darwin|linux|windows)-(aarch64|x86_64)$/);
    });
  });

  describe("fetchRegistry", () => {
    it("fetches the published index by default", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(registry));

      expect(await fetchRegistry(undefined, fetchImpl as any)).toEqual(registry);
      expect(fetchImpl).toHaveBeenCalledWith(DEFAULT_REGISTRY_URL);
    });

    it("accepts a different registry so a local copy can be used", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(registry));

      await fetchRegistry("http://localhost:9000/registry.json", fetchImpl as any);

      expect(fetchImpl).toHaveBeenCalledWith("http://localhost:9000/registry.json");
    });

    it("reports a failed request", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });

      await expect(fetchRegistry(DEFAULT_REGISTRY_URL, fetchImpl as any)).rejects.toThrow(
        /404 Not Found/,
      );
    });

    it("rejects a response that is not a registry index", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ nope: true }));

      await expect(fetchRegistry(DEFAULT_REGISTRY_URL, fetchImpl as any)).rejects.toThrow(
        /did not return an ACP registry index/,
      );
    });
  });

  describe("findAgent", () => {
    it("finds an agent by id", () => {
      expect(findAgent(registry, "gemini")).toBe(gemini);
    });

    it("returns nothing for an unknown id", () => {
      expect(findAgent(registry, "nope")).toBeUndefined();
    });
  });

  describe("availableKinds", () => {
    it("lists the distributions that can run here", () => {
      expect(availableKinds(gemini, "darwin-aarch64")).toEqual(["npx"]);
      expect(availableKinds(fastAgent, "darwin-aarch64")).toEqual(["uvx"]);
      expect(availableKinds(antigravity, "darwin-aarch64")).toEqual(["binary"]);
    });

    it("omits a binary the registry does not publish for this platform", () => {
      expect(availableKinds(antigravity, "windows-aarch64")).toEqual([]);
      expect(availableKinds(antigravity, undefined)).toEqual([]);
    });

    it("lists every distribution an agent offers", () => {
      const both: RegistryAgent = {
        ...gemini,
        distribution: { ...gemini.distribution, binary: antigravity.distribution.binary },
      };
      expect(availableKinds(both, "darwin-aarch64")).toEqual(["npx", "binary"]);
    });
  });

  describe("describeAgents", () => {
    it("lists every agent with how it can be run here", () => {
      const text = describeAgents(registry, "darwin-aarch64");
      expect(text).toContain("gemini");
      expect(text).toContain("Gemini CLI — npx");
      expect(text).toContain("fast-agent");
    });

    it("says when an agent cannot run on this machine", () => {
      const unavailable: Registry = {
        version: "1.0.0",
        agents: [{ ...antigravity, distribution: { binary: {} } }],
      };
      expect(describeAgents(unavailable, "darwin-aarch64")).toContain("unavailable on this platform");
    });
  });

  describe("selectBinaryTarget", () => {
    it("picks the build for this machine", () => {
      expect(selectBinaryTarget(antigravity, "linux-x86_64").args).toEqual(["--uid="]);
    });

    it("refuses an agent that ships no binaries", () => {
      expect(() => selectBinaryTarget(gemini, "darwin-aarch64")).toThrow(
        /publishes no binary distribution/,
      );
    });

    it("refuses a platform the registry does not cover", () => {
      expect(() => selectBinaryTarget(antigravity, undefined)).toThrow(
        /registry publishes no binaries for/,
      );
    });

    it("refuses to substitute another platform's build", () => {
      expect(() => selectBinaryTarget(antigravity, "windows-x86_64")).toThrow(
        /no binary for windows-x86_64 \(available: darwin-aarch64, linux-x86_64\)/,
      );
    });
  });

  describe("packageLaunchSpec", () => {
    it("runs npm packages through npx without prompting", () => {
      expect(packageLaunchSpec("npx", gemini.distribution.npx!)).toEqual({
        command: "npx",
        args: ["-y", "@google/gemini-cli@0.58.0", "--acp"],
        env: undefined,
        kind: "npx",
      });
    });

    it("runs PyPI packages through uvx", () => {
      expect(packageLaunchSpec("uvx", fastAgent.distribution.uvx!)).toEqual({
        command: "uvx",
        args: ["fast-agent-mcp", "serve"],
        env: undefined,
        kind: "uvx",
      });
    });

    it("passes the distribution's env through and tolerates missing args", () => {
      expect(packageLaunchSpec("npx", { package: "some-agent", env: { KEY: "v" } })).toEqual({
        command: "npx",
        args: ["-y", "some-agent"],
        env: { KEY: "v" },
        kind: "npx",
      });
    });
  });
});
