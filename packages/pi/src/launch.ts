/**
 * P01 launcher: resolve the pinned Pi CLI and spawn one long-lived process.
 *
 * Resolution uses only public package metadata: the package root is found via
 * import.meta.resolve() of the Pi package.json (a public export-map entry),
 * then the declared `bin.pi` is read from that manifest. No deep source
 * imports, no global `pi` lookup.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
/** Public root specifier. NOTE: the package does not export ./package.json. */
export const PI_PACKAGE_SPEC = PI_PACKAGE_NAME;

export interface PiBinResolution {
  packageRoot: string;
  binPath: string;
  version: string;
}

export class PiResolutionError extends Error {}

/**
 * Walk up from a resolved file until the Pi package root is found (bounded).
 * Needed because Pi's exports map exposes the library root but not
 * `./package.json`, so the manifest is located via the filesystem.
 */
export function findPiPackageRoot(resolvedFile: string): string | null {
  let dir = dirname(resolvedFile);
  for (let i = 0; i < 6; i++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === PI_PACKAGE_NAME) return dir;
    } catch {
      // Not a readable manifest here; keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the Pi CLI entrypoint. `moduleUrl` is injectable so tests can point
 * at fixture files instead of the real install.
 */
export function resolvePiBin(moduleUrl?: string): PiBinResolution {
  let resolved: string;
  try {
    resolved = moduleUrl ?? import.meta.resolve(PI_PACKAGE_SPEC);
  } catch {
    throw new PiResolutionError(
      `${PI_PACKAGE_NAME} is not resolvable. Install dependencies so the pinned Pi package is present.`,
    );
  }
  let resolvedFile: string;
  try {
    resolvedFile = fileURLToPath(resolved);
  } catch {
    throw new PiResolutionError(`Pi specifier is not a file URL: ${resolved}`);
  }
  const packageRoot = findPiPackageRoot(resolvedFile);
  if (!packageRoot) {
    throw new PiResolutionError(`No ${PI_PACKAGE_NAME} manifest found above ${resolvedFile}`);
  }
  const manifestPath = join(packageRoot, "package.json");
  let manifest: { name?: unknown; version?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch (cause) {
    throw new PiResolutionError(
      `Cannot read Pi manifest at ${manifestPath}: ${cause instanceof Error ? cause.message : "unknown error"}`,
    );
  }
  // Name already matched in findPiPackageRoot; re-check defensively.
  if (manifest.name !== PI_PACKAGE_NAME) {
    throw new PiResolutionError(
      `Expected Pi package ${PI_PACKAGE_NAME} but found ${JSON.stringify(manifest.name)} at ${manifestPath}`,
    );
  }
  const bin = typeof manifest.bin === "string" ? manifest.bin : (manifest.bin as Record<string, unknown> | undefined)?.["pi"];
  if (typeof bin !== "string" || !bin) {
    throw new PiResolutionError(`Pi manifest at ${manifestPath} declares no pi bin entry`);
  }
  const binPath = resolve(packageRoot, bin);
  return {
    packageRoot,
    binPath,
    version: typeof manifest.version === "string" ? manifest.version : "unknown",
  };
}

export interface RunPiOptions {
  /** Extra args appended after the extension flag (Pi CLI args verbatim). */
  piArgs?: string[];
  /** Absolute path of the bundled SupraCortex extension file. Omit to skip. */
  extensionPath?: string;
  /** Environment for the child. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** stdio mode. Defaults to inherit (interactive terminal). */
  stdio?: "inherit" | "pipe";
  /** Spawn implementation (injectable for tests). */
  spawnImpl?: typeof spawn;
}

/**
 * Spawn one Pi process. stdio is inherited so the interactive TUI just works.
 * Fullscreen is the default so the app owns the terminal viewport; callers may
 * explicitly opt into regular mode for scrollback-oriented workflows.
 * Never places secrets in argv; auth stays in Pi's agent directory.
 */
export function runPi(bin: PiBinResolution, opts: RunPiOptions = {}): ChildProcess {
  const piArgs = opts.piArgs ?? [];
  const agentDir = (opts.env ?? process.env).PI_CODING_AGENT_DIR?.trim() || join((opts.env ?? process.env).HOME ?? (opts.env ?? process.env).USERPROFILE ?? ".", ".pi", "agent");
  const hasTuiMode = piArgs.some((arg) => arg === "--tui-mode" || arg.startsWith("--tui-mode="));
  const args = [
    ...(opts.extensionPath ? ["-e", opts.extensionPath] : []),
    ...(!hasTuiMode ? ["--tui-mode", "fullscreen"] : []),
    ...(!piArgs.some((arg) => arg === "--mcp-config" || arg.startsWith("--mcp-config="))
      ? ["--mcp-config", join(agentDir, "mcp.json")]
      : []),
    ...piArgs,
  ];
  const spawnFn = opts.spawnImpl ?? spawn;
  return spawnFn(process.execPath, [bin.binPath, ...args], {
    stdio: opts.stdio ?? "inherit",
    shell: false,
    env: opts.env ?? process.env,
  });
}

/** Default location of this package's bundled extension artifact. */
export function bundledExtensionPath(): string {
  // packages/pi/src/launch.ts -> <root>/dist/pi-extension.js
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(root, "dist", "pi-extension.js");
}

/** Test helper: file URL for a fixture manifest path. */
export function fixtureUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}
