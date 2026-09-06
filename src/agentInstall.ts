/**
 * agentInstall.ts
 *
 * Downloads, verifies and unpacks the binary distribution of a registry agent,
 * caching it so the download happens once.
 *
 * This is the one place in the gateway that fetches a third-party executable
 * and runs it, so the rules here are deliberately strict: an archive is only
 * installed when the registry publishes a `sha256` that the download matches,
 * unless the user has explicitly said otherwise.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import {
  availableKinds,
  findAgent,
  packageLaunchSpec,
  selectBinaryTarget,
  type BinaryTarget,
  type LaunchSpec,
  type PlatformTarget,
  type Registry,
  type RegistryAgent,
} from "./registry.js";

/**
 * Where downloaded agents live, unless overridden.
 *
 * Follows each platform's own convention: `%LOCALAPPDATA%` on Windows,
 * `XDG_CACHE_HOME` where it is set, and `~/.cache` otherwise.
 */
export function defaultCacheDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local")
      : env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "acp-gateway", "agents");
}

/** Archive shapes the registry allows, mapped to how they are unpacked. */
export type ArchiveKind = "zip" | "tar.gz" | "tar.bz2" | "raw";

/**
 * Classifies an archive by its URL.
 *
 * The registry documents exactly which formats may appear; anything else is a
 * raw executable to be saved as-is.
 */
export function archiveKind(url: string): ArchiveKind {
  const pathname = url.split("?")[0].split("#")[0].toLowerCase();
  if (pathname.endsWith(".zip")) return "zip";
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar.gz";
  if (pathname.endsWith(".tar.bz2") || pathname.endsWith(".tbz2")) return "tar.bz2";
  return "raw";
}

/** The directory one agent build is unpacked into. */
export function installDir(cacheDir: string, agentId: string, target: PlatformTarget, version: string): string {
  // The version is part of the path so a registry bump installs alongside the
  // old build rather than half-overwriting it.
  return path.join(cacheDir, `${agentId}@${version}`, target);
}

/**
 * Resolves the registry's `cmd` inside the install directory.
 *
 * `cmd` is third-party text, so a path that climbs out of the directory — and
 * would have us run something else entirely — is rejected rather than resolved.
 */
export function resolveExecutable(dir: string, cmd: string): string {
  const executable = path.resolve(dir, cmd);
  const root = path.resolve(dir);
  if (executable !== root && !executable.startsWith(root + path.sep)) {
    throw new Error(`Agent command "${cmd}" points outside its install directory; refusing to run it.`);
  }
  return executable;
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Refuses an archive we cannot vouch for.
 *
 * Roughly half the registry's binary targets publish no checksum. Running one
 * means trusting whatever the vendor's host served, so it takes an explicit
 * opt-in rather than happening quietly.
 */
export function assertVerifiable(
  agent: RegistryAgent,
  target: BinaryTarget,
  allowUnverified: boolean,
): void {
  if (target.sha256 || allowUnverified) return;
  throw new Error(
    `The ACP registry publishes no sha256 for "${agent.id}" on this platform, so the ` +
      `download cannot be verified. Re-run with --allow-unverified-agent to install it anyway, ` +
      `or install the agent yourself and pass it after --.`,
  );
}

/** Checks a download against the registry's checksum. */
export function assertChecksum(agent: RegistryAgent, target: BinaryTarget, data: Uint8Array): void {
  if (!target.sha256) return;
  const actual = sha256(data);
  if (actual.toLowerCase() !== target.sha256.toLowerCase()) {
    throw new Error(
      `Checksum mismatch for "${agent.id}": the registry expects ${target.sha256.toLowerCase()} ` +
        `but ${target.archive} produced ${actual}. Refusing to run it.`,
    );
  }
}

/** Downloads an archive into memory so it can be checksummed before it touches disk. */
export async function downloadArchive(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Runs an extraction tool, failing with its own diagnostics attached. */
export async function runExtractionTool(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    child.on("error", (err: Error) =>
      reject(
        new Error(
          `Could not run "${command}" to unpack the agent archive: ${err.message}. ` +
            `Install it, or install the agent yourself and pass it after --.`,
        ),
      ),
    );
    child.on("exit", (code: number | null) => {
      if (code === 0) return resolve();
      reject(new Error(`"${command}" failed to unpack the agent archive (code=${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Unpacks an archive into `dir`.
 *
 * Uses the system's own tools rather than adding archive libraries as
 * dependencies. `tar` handles the tarballs everywhere and zips on macOS and
 * Windows, where it is bsdtar; GNU tar cannot read zips, so Linux falls back
 * to `unzip`.
 */
export async function extractArchive(
  data: Uint8Array,
  kind: ArchiveKind,
  dir: string,
  cmd: string,
  platform: string = process.platform,
): Promise<void> {
  await mkdir(dir, { recursive: true });

  if (kind === "raw") {
    // No archive to unpack: the download is the executable itself.
    await writeFile(path.join(dir, path.basename(cmd)), data);
    return;
  }

  const archivePath = path.join(dir, `archive.${kind}`);
  await writeFile(archivePath, data);
  try {
    if (kind === "zip" && platform === "linux") {
      await runExtractionTool("unzip", ["-q", "-o", archivePath], dir);
    } else {
      await runExtractionTool("tar", ["-xf", archivePath], dir);
    }
  } finally {
    await rm(archivePath, { force: true });
  }
}

export interface InstallOptions {
  agent: RegistryAgent;
  target: BinaryTarget;
  platformTarget: PlatformTarget;
  cacheDir?: string;
  /** Install an archive the registry publishes no checksum for. */
  allowUnverified?: boolean;
  fetchImpl?: typeof fetch;
  platform?: string;
}

/**
 * Makes a registry agent runnable, returning the command that launches it.
 *
 * A cached install is reused as-is; the version in the cache path means a
 * registry bump installs a fresh copy rather than reusing a stale one.
 */
export async function installBinaryAgent({
  agent,
  target,
  platformTarget,
  cacheDir,
  allowUnverified = false,
  fetchImpl = fetch,
  platform = process.platform,
}: InstallOptions): Promise<LaunchSpec> {
  cacheDir ??= defaultCacheDir(platform);
  const dir = installDir(cacheDir, agent.id, platformTarget, agent.version);
  const executable = resolveExecutable(dir, target.cmd);
  const spec: LaunchSpec = {
    command: executable,
    args: target.args ?? [],
    env: target.env,
    kind: "binary",
  };

  if (existsSync(executable)) {
    console.error(`[registry] Using cached ${agent.id} ${agent.version} from ${dir}`);
    return spec;
  }

  assertVerifiable(agent, target, allowUnverified);

  console.error(`[registry] Downloading ${agent.id} ${agent.version} from ${target.archive}`);
  const data = await downloadArchive(target.archive, fetchImpl);
  assertChecksum(agent, target, data);
  if (!target.sha256) {
    console.error(
      `[registry] ⚠️  ${agent.id} publishes no checksum; installing it unverified at your request.`,
    );
  }

  // Unpack somewhere temporary and move into place only once it succeeded, so
  // a failed extraction never leaves a half-installed agent to be cached.
  const staging = await mkdtemp(path.join(tmpdir(), `acp-gateway-${agent.id}-`));
  try {
    await extractArchive(data, archiveKind(target.archive), staging, target.cmd, platform);
    const staged = resolveExecutable(staging, target.cmd);
    if (!existsSync(staged)) {
      throw new Error(
        `The archive for "${agent.id}" does not contain "${target.cmd}" where the registry says it should.`,
      );
    }
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.dirname(dir), { recursive: true });
    await moveInto(staging, dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  // Archive formats do not always carry the executable bit. Windows has no
  // such bit — chmod there only toggles the read-only flag — so skip it.
  if (platform !== "win32") {
    await chmod(executable, 0o755);
  }
  console.error(`[registry] Installed ${agent.id} ${agent.version} to ${dir}`);
  return spec;
}

/** Moves a staged install into the cache, copying across filesystems if needed. */
export async function moveInto(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    // rename() fails across devices — the temp dir is often a different mount.
    await cp(from, to, { recursive: true });
  }
}

export interface ResolveAgentOptions {
  id: string;
  registry: Registry;
  platformTarget: PlatformTarget | undefined;
  cacheDir?: string;
  allowUnverified?: boolean;
  fetchImpl?: typeof fetch;
  platform?: string;
}

/**
 * Turns a registry id into the command that runs that agent, installing it
 * first where the only distribution is a binary.
 *
 * Package distributions are preferred over binaries: npm and PyPI verify what
 * they serve, and nothing has to be downloaded, unpacked or cached here.
 */
export async function resolveAgentLaunch({
  id,
  registry,
  platformTarget,
  cacheDir,
  allowUnverified = false,
  fetchImpl = fetch,
  platform = process.platform,
}: ResolveAgentOptions): Promise<LaunchSpec> {
  const agent = findAgent(registry, id);
  if (!agent) {
    throw new Error(`No agent "${id}" in the ACP registry. Run --list-agents to see what it publishes.`);
  }

  const kinds = availableKinds(agent, platformTarget);
  if (!kinds.length) {
    const published = Object.keys(agent.distribution).join(", ") || "nothing";
    throw new Error(
      `The ACP registry publishes no build of "${id}" for ${platformTarget ?? `${process.platform}/${process.arch}`} ` +
        `(it publishes: ${published}).`,
    );
  }

  if (kinds.includes("npx")) return packageLaunchSpec("npx", agent.distribution.npx!);
  if (kinds.includes("uvx")) return packageLaunchSpec("uvx", agent.distribution.uvx!);

  return installBinaryAgent({
    agent,
    target: selectBinaryTarget(agent, platformTarget),
    platformTarget: platformTarget!,
    cacheDir,
    allowUnverified,
    fetchImpl,
    platform,
  });
}
