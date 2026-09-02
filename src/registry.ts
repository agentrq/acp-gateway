/**
 * registry.ts
 *
 * Resolves ACP agents from the public registry, so an agent can be named by id
 * instead of being installed and wired up by hand.
 *
 * The registry publishes one index of every agent it lists, each entry saying
 * how the agent is distributed: an npm package run through `npx`, a PyPI
 * package run through `uvx`, or a platform-specific binary to download.
 *
 * See https://github.com/agentclientprotocol/registry
 */

/** The registry index, as published by the ACP project. */
export const DEFAULT_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/** Platform identifiers the registry uses for binary distributions. */
export type PlatformTarget =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export interface BinaryTarget {
  archive: string;
  /** SHA-256 of the archive. Optional in the registry — many entries omit it. */
  sha256?: string;
  /** Path to the executable, relative to the extracted archive. */
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PackageDistribution {
  /** Package name, which may pin a version (e.g. `@google/gemini-cli@0.58.0`). */
  package: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentDistribution {
  binary?: Partial<Record<PlatformTarget, BinaryTarget>>;
  npx?: PackageDistribution;
  uvx?: PackageDistribution;
}

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  distribution: AgentDistribution;
}

export interface Registry {
  version: string;
  agents: RegistryAgent[];
}

/** How an agent named in the registry is actually launched. */
export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Which distribution this came from, for logging. */
  kind: "npx" | "uvx" | "binary";
}

/** Node's platform/arch names mapped onto the registry's identifiers. */
const PLATFORMS: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCHITECTURES: Record<string, string> = { arm64: "aarch64", x64: "x86_64" };

/**
 * The registry platform identifier for the machine we are running on, or
 * undefined where the registry publishes nothing for it.
 */
export function hostPlatformTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformTarget | undefined {
  const os = PLATFORMS[platform];
  const cpu = ARCHITECTURES[arch];
  if (!os || !cpu) return undefined;
  return `${os}-${cpu}` as PlatformTarget;
}

/** Rejects anything that is not a registry index, so a bad URL fails loudly. */
function assertRegistry(value: unknown, url: string): asserts value is Registry {
  const agents = (value as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) {
    throw new Error(`${url} did not return an ACP registry index.`);
  }
}

/**
 * Downloads the registry index.
 *
 * `fetchImpl` and `url` are injectable so a pinned or local registry can be
 * used instead of the published one.
 */
export async function fetchRegistry(
  url: string = DEFAULT_REGISTRY_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Registry> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch the ACP registry from ${url}: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  assertRegistry(body, url);
  return body;
}

/** Finds one agent by its registry id. */
export function findAgent(registry: Registry, id: string): RegistryAgent | undefined {
  return registry.agents.find((agent) => agent.id === id);
}

/**
 * Renders the registry as a table for the terminal.
 *
 * `target` is passed in rather than defaulted, so that "this machine has no
 * published build" stays distinguishable from "caller did not say".
 */
export function describeAgents(
  registry: Registry,
  target: PlatformTarget | undefined,
): string {
  const rows = registry.agents.map((agent) => {
    const kinds = availableKinds(agent, target);
    const support = kinds.length ? kinds.join(", ") : "unavailable on this platform";
    return `  ${agent.id.padEnd(22)} ${agent.name} — ${support}`;
  });
  return rows.join("\n");
}

/** Which distributions of this agent can actually run on this machine. */
export function availableKinds(
  agent: RegistryAgent,
  target: PlatformTarget | undefined,
): LaunchSpec["kind"][] {
  const kinds: LaunchSpec["kind"][] = [];
  if (agent.distribution.npx) kinds.push("npx");
  if (agent.distribution.uvx) kinds.push("uvx");
  if (target && agent.distribution.binary?.[target]) kinds.push("binary");
  return kinds;
}

/**
 * Picks the binary build for this machine.
 *
 * Throws rather than falling back to another platform's build: running the
 * wrong architecture would fail in a much more confusing way.
 */
export function selectBinaryTarget(
  agent: RegistryAgent,
  target: PlatformTarget | undefined,
): BinaryTarget {
  const binary = agent.distribution.binary;
  if (!binary) {
    throw new Error(`Agent "${agent.id}" publishes no binary distribution.`);
  }
  if (!target) {
    throw new Error(
      `The ACP registry publishes no binaries for ${process.platform}/${process.arch}.`,
    );
  }
  const selected = binary[target];
  if (!selected) {
    throw new Error(
      `Agent "${agent.id}" publishes no binary for ${target} ` +
        `(available: ${Object.keys(binary).join(", ")}).`,
    );
  }
  return selected;
}

/**
 * Turns an npm or PyPI distribution into the command that runs it.
 *
 * On Windows npm installs `npx` as `npx.cmd`; spawning a bare "npx" there
 * looks only for `npx.exe` and fails, so the runner is named explicitly.
 */
export function packageLaunchSpec(
  kind: "npx" | "uvx",
  distribution: PackageDistribution,
  platform: string = process.platform,
): LaunchSpec {
  // `npx -y` skips the install prompt, which would otherwise block a gateway
  // that nobody is watching.
  const args = kind === "npx" ? ["-y", distribution.package] : [distribution.package];
  return {
    command: kind === "npx" && platform === "win32" ? "npx.cmd" : kind,
    args: [...args, ...(distribution.args ?? [])],
    env: distribution.env,
    kind,
  };
}
