/**
 * P02 CLI configuration: `.supracortex/cli.jsonc` (project) + user-level file.
 * Separate from the core Engine config so CLI settings never change core
 * schema prematurely. Unknown keys are rejected with path diagnostics.
 */

import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { z } from "zod";

export const CLI_CONFIG_DIR = ".supracortex";
export const CLI_CONFIG_FILENAME = "cli.jsonc";
export const CLI_CONFIG_SCHEMA_VERSION = 1;

const ModelRefSchema = z.object({
  provider: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
});

const CliConfigSchema = z.object({
  schemaVersion: z.literal(CLI_CONFIG_SCHEMA_VERSION),
  mainModel: ModelRefSchema.optional(),
  roleModels: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), ModelRefSchema).optional(),
  agents: z.object({
    directories: z.array(z.string().min(1).max(512)).max(16).optional(),
  }).optional(),
  jobs: z.object({
    maxRunning: z.number().int().min(1).max(8).optional(),
    maxQueued: z.number().int().min(0).max(64).optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).optional(),
  context: z.object({
    mainMaxTokens: z.number().int().min(256).max(16000).optional(),
    childMaxTokens: z.number().int().min(256).max(16000).optional(),
  }).optional(),
  inheritPiResources: z.boolean().optional(),
}).strict();

export type CliConfig = z.infer<typeof CliConfigSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const DEFAULT_CLI_CONFIG: Required<Omit<CliConfig, "mainModel" | "roleModels">> & {
  mainModel?: ModelRef;
  roleModels?: Record<string, ModelRef>;
} = {
  schemaVersion: CLI_CONFIG_SCHEMA_VERSION,
  agents: { directories: [".supracortex/agents"] },
  jobs: { maxRunning: 2, maxQueued: 8, timeoutMs: 300000 },
  context: { mainMaxTokens: 4000, childMaxTokens: 2000 },
  inheritPiResources: true,
};

export class CliConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

/** Parse + validate raw JSONC text. Throws CliConfigError with file path. */
export function parseCliConfig(text: string, path: string): CliConfig {
  let raw: unknown;
  try {
    raw = parse(text) as unknown;
  } catch (cause) {
    throw new CliConfigError(path, `invalid JSONC: ${cause instanceof Error ? cause.message : "parse error"}`);
  }
  // `$schema` is editor metadata, not configuration.
  if (raw && typeof raw === "object" && "$schema" in raw) {
    delete (raw as Record<string, unknown>)["$schema"];
  }
  const parsed = CliConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first ? first.path.join(".") || "(root)" : "(root)";
    throw new CliConfigError(path, `invalid key ${at}: ${first?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

/** User-level config directory (platform-appropriate, XDG-aware on Linux). */
export function userConfigDir(): string {
  const home = homedir();
  const os = platform();
  if (os === "win32") {
    return join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "supracortex");
  }
  if (os === "darwin") {
    return join(home, "Library", "Application Support", "supracortex");
  }
  return join(process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "supracortex");
}

export async function readJsoncFile(path: string): Promise<CliConfig | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return parseCliConfig(text, path);
}

/** Load project CLI config (may be absent). */
export function loadProjectCliConfig(projectRoot: string): Promise<CliConfig | null> {
  return readJsoncFile(join(projectRoot, CLI_CONFIG_DIR, CLI_CONFIG_FILENAME));
}

/** Load user CLI config (may be absent). */
export function loadUserCliConfig(): Promise<CliConfig | null> {
  return readJsoncFile(join(userConfigDir(), CLI_CONFIG_FILENAME));
}

/** Shallow-merge with defined-values-win (nested objects merged one level). */
export function mergeCliConfig(base: CliConfig, overlay: CliConfig): CliConfig {
  return {
    ...base,
    ...overlay,
    roleModels: { ...(base.roleModels ?? {}), ...(overlay.roleModels ?? {}) },
    agents: { ...(base.agents ?? {}), ...(overlay.agents ?? {}) },
    jobs: { ...(base.jobs ?? {}), ...(overlay.jobs ?? {}) },
    context: { ...(base.context ?? {}), ...(overlay.context ?? {}) },
  };
}

export interface InvocationModelOverride {
  provider: string;
  id: string;
}

/**
 * Resolve the effective main model. Precedence: invocation > project > user.
 * Returns undefined when nothing is configured (caller must require selection;
 * never silently use Pi's first available model).
 */
export function resolveMainModel(opts: {
  invocation?: InvocationModelOverride;
  project?: CliConfig | null;
  user?: CliConfig | null;
}): ModelRef | undefined {
  if (opts.invocation) return { provider: opts.invocation.provider, id: opts.invocation.id };
  return opts.project?.mainModel ?? opts.user?.mainModel;
}

/** Resolve jobs/context sections with defaults applied. */
export function resolveJobLimits(cfg: CliConfig | null): { maxRunning: number; maxQueued: number; timeoutMs: number } {
  const d = DEFAULT_CLI_CONFIG.jobs;
  return {
    maxRunning: cfg?.jobs?.maxRunning ?? d.maxRunning!,
    maxQueued: cfg?.jobs?.maxQueued ?? d.maxQueued!,
    timeoutMs: cfg?.jobs?.timeoutMs ?? d.timeoutMs!,
  };
}

export function resolveContextCaps(cfg: CliConfig | null): { mainMaxTokens: number; childMaxTokens: number } {
  const d = DEFAULT_CLI_CONFIG.context;
  return {
    mainMaxTokens: cfg?.context?.mainMaxTokens ?? d.mainMaxTokens!,
    childMaxTokens: cfg?.context?.childMaxTokens ?? d.childMaxTokens!,
  };
}
