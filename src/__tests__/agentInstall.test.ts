import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  archiveKind,
  assertChecksum,
  assertVerifiable,
  defaultCacheDir,
  downloadArchive,
  extractArchive,
  installBinaryAgent,
  installDir,
  moveInto,
  resolveAgentLaunch,
  runExtractionTool,
  resolveExecutable,
  sha256,
} from "../agentInstall.js";
import type { BinaryTarget, Registry, RegistryAgent } from "../registry.js";

const agent: RegistryAgent = {
  id: "demo-acp",
  name: "Demo Agent",
  version: "1.2.3",
  description: "A demo agent",
  distribution: {},
};

/** Builds a real .tar.gz containing an executable, so extraction is exercised for real. */
async function makeTarball(cmdName: string, contents: string): Promise<Uint8Array> {
  const staging = await mkdtemp(path.join(tmpdir(), "acp-gateway-fixture-"));
  try {
    await writeFile(path.join(staging, cmdName), contents);
    const archive = path.join(staging, "out.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", staging, cmdName]);
    return new Uint8Array(await readFile(archive));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function okResponse(data: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  } as Response;
}

describe("agentInstall", () => {
  let cacheDir: string;
  let errorSpy: any;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "acp-gateway-cache-"));
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    await rm(cacheDir, { recursive: true, force: true });
  });

  describe("defaultCacheDir", () => {
    it("uses XDG_CACHE_HOME where it is set", () => {
      expect(defaultCacheDir("linux", { XDG_CACHE_HOME: "/xdg" })).toBe(
        path.join("/xdg", "acp-gateway", "agents"),
      );
    });

    it("falls back to the per-user cache on macOS and Linux", () => {
      expect(defaultCacheDir("darwin", {})).toMatch(/\.cache[\\/]acp-gateway[\\/]agents$/);
    });

    it("uses LOCALAPPDATA on Windows", () => {
      expect(defaultCacheDir("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toBe(
        path.join("C:\\Users\\me\\AppData\\Local", "acp-gateway", "agents"),
      );
      expect(defaultCacheDir("win32", {})).toMatch(/AppData[\\/]Local[\\/]acp-gateway/);
    });
  });

  describe("archiveKind", () => {
    it("recognises every format the registry allows", () => {
      expect(archiveKind("https://x/y.zip")).toBe("zip");
      expect(archiveKind("https://x/y.tar.gz")).toBe("tar.gz");
      expect(archiveKind("https://x/y.tgz")).toBe("tar.gz");
      expect(archiveKind("https://x/y.tar.bz2")).toBe("tar.bz2");
      expect(archiveKind("https://x/y.tbz2")).toBe("tar.bz2");
    });

    it("ignores query strings and fragments", () => {
      expect(archiveKind("https://x/y.ZIP?token=abc#frag")).toBe("zip");
    });

    it("treats anything else as a raw executable", () => {
      expect(archiveKind("https://x/agent-darwin-arm64")).toBe("raw");
    });
  });

  describe("installDir", () => {
    it("keeps each version and platform apart", () => {
      expect(installDir("/cache", "demo", "darwin-aarch64", "1.2.3")).toBe(
        path.join("/cache", "demo@1.2.3", "darwin-aarch64"),
      );
    });
  });

  describe("resolveExecutable", () => {
    it("resolves the registry's cmd inside the install directory", () => {
      expect(resolveExecutable("/cache/demo", "./bin/agent")).toBe(
        path.resolve("/cache/demo/bin/agent"),
      );
    });

    it("refuses a cmd that climbs out of the install directory", () => {
      expect(() => resolveExecutable("/cache/demo", "../../../usr/bin/curl")).toThrow(
        /points outside its install directory/,
      );
    });
  });

  describe("assertVerifiable", () => {
    const unverifiable: BinaryTarget = { archive: "https://x/y.zip", cmd: "./demo" };

    it("refuses an archive the registry publishes no checksum for", () => {
      expect(() => assertVerifiable(agent, unverifiable, false)).toThrow(
        /publishes no sha256 for "demo-acp".*--allow-unverified-agent/s,
      );
    });

    it("allows it once the user has explicitly opted in", () => {
      expect(() => assertVerifiable(agent, unverifiable, true)).not.toThrow();
    });

    it("allows an archive that does publish a checksum", () => {
      expect(() =>
        assertVerifiable(agent, { ...unverifiable, sha256: "a".repeat(64) }, false),
      ).not.toThrow();
    });
  });

  describe("assertChecksum", () => {
    const data = new Uint8Array([1, 2, 3]);

    it("accepts a download that matches, whatever the case", () => {
      const digest = sha256(data);
      expect(() =>
        assertChecksum(agent, { archive: "https://x/y", cmd: "./d", sha256: digest.toUpperCase() }, data),
      ).not.toThrow();
    });

    it("refuses a download that does not match", () => {
      expect(() =>
        assertChecksum(agent, { archive: "https://x/y", cmd: "./d", sha256: "b".repeat(64) }, data),
      ).toThrow(/Checksum mismatch for "demo-acp"/);
    });

    it("has nothing to check when the registry publishes no checksum", () => {
      expect(() => assertChecksum(agent, { archive: "https://x/y", cmd: "./d" }, data)).not.toThrow();
    });
  });

  describe("downloadArchive", () => {
    it("returns the bytes", async () => {
      const data = new Uint8Array([9, 8, 7]);
      const fetchImpl = vi.fn().mockResolvedValue(okResponse(data));

      expect(await downloadArchive("https://x/y.zip", fetchImpl as any)).toEqual(data);
    });

    it("reports a failed download", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });

      await expect(downloadArchive("https://x/y.zip", fetchImpl as any)).rejects.toThrow(
        /Failed to download https:\/\/x\/y.zip: 403 Forbidden/,
      );
    });
  });

  describe("extractArchive", () => {
    it("writes a raw download straight out as the executable", async () => {
      const dir = path.join(cacheDir, "raw");
      await extractArchive(new Uint8Array([1, 2]), "raw", dir, "./demo-agent");

      expect(await readFile(path.join(dir, "demo-agent"))).toEqual(Buffer.from([1, 2]));
    });

    it("unpacks a real tarball and removes the archive afterwards", async () => {
      const tarball = await makeTarball("demo", "#!/bin/sh\necho hi\n");
      const dir = path.join(cacheDir, "tar");

      await extractArchive(tarball, "tar.gz", dir, "./demo");

      expect(await readFile(path.join(dir, "demo"), "utf8")).toContain("echo hi");
      expect(existsSync(path.join(dir, "archive.tar.gz"))).toBe(false);
    });

    it("uses unzip for zips on Linux, where tar cannot read them", async () => {
      const dir = path.join(cacheDir, "zip");
      // `unzip` is not guaranteed on every machine, so assert on the failure
      // message rather than on a successful extraction.
      await expect(
        extractArchive(new Uint8Array([1]), "zip", dir, "./demo", "linux"),
      ).rejects.toThrow(/unzip/);
    });

    it("reports an extraction tool that is not installed", async () => {
      await expect(
        runExtractionTool("acp-gateway-no-such-tool", [], cacheDir),
      ).rejects.toThrow(/Could not run "acp-gateway-no-such-tool" to unpack the agent archive/);
    });

    it("reports a corrupt archive with the tool's own diagnostics", async () => {
      const dir = path.join(cacheDir, "bad");
      await expect(
        extractArchive(new Uint8Array([1, 2, 3]), "tar.gz", dir, "./demo", "darwin"),
      ).rejects.toThrow(/failed to unpack the agent archive/);
    });
  });

  describe("moveInto", () => {
    it("copies when the staged install cannot simply be renamed into place", async () => {
      const from = await mkdtemp(path.join(tmpdir(), "acp-gateway-move-"));
      await writeFile(path.join(from, "demo"), "binary");
      // A destination whose parents do not exist: rename() fails, and the copy
      // fallback — the same path taken when the temp dir is another mount —
      // has to create the tree.
      const to = path.join(cacheDir, "deep", "deeper", "install");

      await moveInto(from, to);

      expect(await readFile(path.join(to, "demo"), "utf8")).toBe("binary");
      await rm(from, { recursive: true, force: true });
    });
  });

  describe("installBinaryAgent", () => {
    async function install(overrides: Record<string, any> = {}) {
      const tarball = await makeTarball("demo", "#!/bin/sh\nexit 0\n");
      const target: BinaryTarget = {
        archive: "https://example.com/demo.tar.gz",
        sha256: sha256(tarball),
        cmd: "./demo",
        args: ["--acp"],
        ...overrides.target,
      };
      const fetchImpl = vi.fn().mockResolvedValue(okResponse(tarball));
      const spec = await installBinaryAgent({
        agent,
        target,
        platformTarget: "darwin-aarch64",
        cacheDir,
        fetchImpl: fetchImpl as any,
        platform: "darwin",
        ...overrides.options,
      });
      return { spec, fetchImpl, tarball };
    }

    it("downloads, verifies, unpacks and makes the agent executable", async () => {
      const { spec } = await install();

      expect(spec).toEqual({
        command: path.join(cacheDir, "demo-acp@1.2.3", "darwin-aarch64", "demo"),
        args: ["--acp"],
        env: undefined,
        kind: "binary",
      });
      expect(existsSync(spec.command)).toBe(true);
      // 0o111 — executable by someone.
      expect((await stat(spec.command)).mode & 0o111).toBeGreaterThan(0);
    });

    it("skips the executable bit on Windows, which has none", async () => {
      const { spec } = await install({ options: { platform: "win32" } });

      expect(existsSync(spec.command)).toBe(true);
    });

    it("reuses a cached install instead of downloading again", async () => {
      await install();
      const { fetchImpl } = await install();

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("Using cached demo-acp 1.2.3");
    });

    it("refuses an archive with no published checksum", async () => {
      await expect(install({ target: { sha256: undefined } })).rejects.toThrow(
        /publishes no sha256/,
      );
    });

    it("installs an unverified archive when explicitly allowed, and says so", async () => {
      const { spec } = await install({
        target: { sha256: undefined },
        options: { allowUnverified: true },
      });

      expect(existsSync(spec.command)).toBe(true);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("publishes no checksum");
    });

    it("refuses a download that does not match the checksum", async () => {
      await expect(install({ target: { sha256: "c".repeat(64) } })).rejects.toThrow(
        /Checksum mismatch/,
      );
    });

    it("leaves nothing cached when the archive lacks the promised command", async () => {
      await expect(install({ target: { cmd: "./not-in-archive" } })).rejects.toThrow(
        /does not contain "\.\/not-in-archive"/,
      );
      expect(existsSync(installDir(cacheDir, agent.id, "darwin-aarch64", agent.version))).toBe(
        false,
      );
    });
  });

  describe("resolveAgentLaunch", () => {
    const gemini: RegistryAgent = {
      id: "gemini",
      name: "Gemini CLI",
      version: "0.58.0",
      description: "Google's CLI",
      distribution: { npx: { package: "@google/gemini-cli@0.58.0", args: ["--acp"] } },
    };
    const pyAgent: RegistryAgent = {
      id: "fast-agent",
      name: "fast-agent",
      version: "1.0.0",
      description: "A Python agent",
      distribution: { uvx: { package: "fast-agent-mcp" } },
    };
    const binaryOnly: RegistryAgent = {
      ...agent,
      distribution: {
        binary: {
          "linux-x86_64": { archive: "https://x/y.tar.gz", sha256: "a".repeat(64), cmd: "./demo" },
        },
      },
    };
    const registry: Registry = {
      version: "1.0.0",
      agents: [gemini, pyAgent, binaryOnly],
    };

    it("runs npm-distributed agents through npx without downloading anything", async () => {
      const fetchImpl = vi.fn();
      const spec = await resolveAgentLaunch({
        id: "gemini",
        registry,
        platformTarget: "darwin-aarch64",
        fetchImpl: fetchImpl as any,
      });

      expect(spec).toEqual({
        command: "npx",
        args: ["-y", "@google/gemini-cli@0.58.0", "--acp"],
        env: undefined,
        kind: "npx",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("names npx explicitly on Windows, where a bare npx cannot be spawned", async () => {
      const spec = await resolveAgentLaunch({
        id: "gemini",
        registry,
        platformTarget: "windows-x86_64",
        platform: "win32",
      });

      expect(spec.command).toBe("npx.cmd");
    });

    it("runs PyPI-distributed agents through uvx", async () => {
      const spec = await resolveAgentLaunch({
        id: "fast-agent",
        registry,
        platformTarget: "linux-x86_64",
      });

      expect(spec).toEqual({
        command: "uvx",
        args: ["fast-agent-mcp"],
        env: undefined,
        kind: "uvx",
      });
    });

    it("installs the binary when that is the only distribution", async () => {
      const tarball = await makeTarball("demo", "#!/bin/sh\nexit 0\n");
      const registryWithDigest: Registry = {
        version: "1.0.0",
        agents: [
          {
            ...binaryOnly,
            distribution: {
              binary: {
                "linux-x86_64": {
                  archive: "https://x/y.tar.gz",
                  sha256: sha256(tarball),
                  cmd: "./demo",
                },
              },
            },
          },
        ],
      };
      const fetchImpl = vi.fn().mockResolvedValue(okResponse(tarball));

      const spec = await resolveAgentLaunch({
        id: "demo-acp",
        registry: registryWithDigest,
        platformTarget: "linux-x86_64",
        cacheDir,
        fetchImpl: fetchImpl as any,
        platform: "linux",
      });

      expect(spec.kind).toBe("binary");
      expect(existsSync(spec.command)).toBe(true);
    });

    it("reports an id the registry does not list", async () => {
      await expect(
        resolveAgentLaunch({ id: "nope", registry, platformTarget: "linux-x86_64" }),
      ).rejects.toThrow(/No agent "nope" in the ACP registry/);
    });

    it("reports an agent that has no build for this machine", async () => {
      await expect(
        resolveAgentLaunch({ id: "demo-acp", registry, platformTarget: "windows-aarch64" }),
      ).rejects.toThrow(/publishes no build of "demo-acp" for windows-aarch64 \(it publishes: binary\)/);
    });

    it("says so when an agent publishes no distribution at all", async () => {
      const empty: Registry = {
        version: "1.0.0",
        agents: [{ ...agent, distribution: {} }],
      };

      await expect(
        resolveAgentLaunch({ id: "demo-acp", registry: empty, platformTarget: "linux-x86_64" }),
      ).rejects.toThrow(/it publishes: nothing/);
    });

    it("reports an unsupported platform by name", async () => {
      await expect(
        resolveAgentLaunch({ id: "demo-acp", registry, platformTarget: undefined }),
      ).rejects.toThrow(/publishes no build of "demo-acp" for/);
    });
  });
});
