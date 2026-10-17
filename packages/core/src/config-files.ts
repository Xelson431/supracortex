/**
 * Config file locations and layered loading shared by every host (OpenCode
 * plugin, MCP server, CLI, Pi). One implementation so no host can drift back
 * to per-project feature settings.
 *
 *   central  ~/.config/supracortex/config.jsonc   every feature setting
 *   project  <root>/.supracortex/config.jsonc     store identity + kill switch only
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  detectStorageDriver,
  projectScopedConfig,
  type PartialConfig,
} from "./config.ts";
import { resolveProjectStorageDirectory } from "./memory/validation.ts";

export const PROJECT_DIR = ".supracortex";
export const CONFIG_FILENAME = "config.jsonc";

export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_DIR, CONFIG_FILENAME);
}

/**
 * The central config. It lives outside any OpenCode config dir so stock
 * OpenCode stays untouched and SupraCode's isolated profile (which redirects
 * XDG_CONFIG_HOME) still reads the same file. The pre-isolation location under
 * `~/.config/opencode/` is honoured while it is the only one present.
 */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || homedir();
  const realConfigHome = env.SUPRACODE_REAL_XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const current = join(realConfigHome, "supracortex", CONFIG_FILENAME);
  const legacy = join(home, ".config", "opencode", "supracortex", CONFIG_FILENAME);
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

/** Minimal JSONC -> JSON (comments + trailing commas), string-aware. */
export function stripJsonc(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    const n = input[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function readConfigFile(path: string): Promise<PartialConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
    delete parsed.$schema;
    return parsed as PartialConfig;
  } catch (err) {
    throw new Error(`Invalid config at ${path}: ${(err as Error).message}`);
  }
}

export type StorageDriverSource = "project" | "detected" | "central";

export interface ConfigLayers {
  global: PartialConfig | null;
  /** Project layer after the central-config rule (scoped keys + detected driver). */
  project: PartialConfig | null;
  /** The project file as written, for diagnostics. */
  rawProject: PartialConfig | null;
  ignoredProjectKeys: string[];
  storageDriverSource: StorageDriverSource;
  loadError?: string;
}

export async function loadConfigLayers(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<ConfigLayers> {
  let global: PartialConfig | null = null;
  let rawProject: PartialConfig | null = null;
  let loadError: string | undefined;
  try {
    global = await readConfigFile(globalConfigPath(env));
  } catch (err) {
    loadError = (err as Error).message;
  }
  try {
    rawProject = await readConfigFile(projectConfigPath(projectRoot));
  } catch (err) {
    loadError = (err as Error).message;
  }
  const scoped = projectScopedConfig(rawProject ?? {});
  const project: PartialConfig = { ...scoped.config };
  let storageDriverSource: StorageDriverSource = "central";
  if (scoped.config.storage?.driver) {
    storageDriverSource = "project";
  } else {
    const directory = scoped.config.storage?.directory ?? global?.storage?.directory ?? DEFAULT_CONFIG.storage.directory;
    let detected: ReturnType<typeof detectStorageDriver> = null;
    try {
      detected = detectStorageDriver(resolveProjectStorageDirectory(projectRoot, directory), existsSync);
    } catch {
      detected = null;
    }
    if (detected) {
      project.storage = { ...(project.storage ?? {}), driver: detected } as PartialConfig["storage"];
      storageDriverSource = "detected";
    }
  }
  return {
    global,
    project: Object.keys(project).length ? project : rawProject === null ? null : {},
    rawProject,
    ignoredProjectKeys: scoped.ignored,
    storageDriverSource,
    ...(loadError ? { loadError } : {}),
  };
}
