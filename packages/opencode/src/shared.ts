/**
 * Shared layer between stock OpenCode and SupraCode.
 *
 * SupraCode runs with its own OpenCode profile (so stock plugins, custom
 * agents and commands never leak in), but the user's MCP
 * servers, model providers and skills are the same machine-level resources in
 * both. They are read LIVE from the stock config at every launch — never
 * copied into the profile, where they would go stale.
 *
 * Mechanism (OpenCode config precedence: global -> $OPENCODE_CONFIG -> project):
 *   - the profile (`~/.config/supracode/opencode/`) is OpenCode's global config;
 *   - a generated `shared.opencode.json` is passed as $OPENCODE_CONFIG with
 *       mcp       stock MCP servers, minus names the profile defines itself
 *       provider  stock providers, minus ids the profile defines itself
 *       skills.paths  a generated dir of links to the stock skills
 *   so every key the user sets in the profile wins (it is left out of the
 *   shared file instead of being overridden by it).
 *
 * Never shared: plugin, agent, command, mode, permission, tui, keybinds,
 * instructions, and stock plugins (including their bundled files and skills).
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { ProfilePaths } from "./profile.ts";

/** Stock config sections SupraCode shares. Everything else stays separate. */
export const SHARED_SECTIONS = ["mcp", "provider"] as const;

/** MCP server names never shared (SupraCode provides these natively). */
const MCP_EXCLUDE = new Set(["supracortex"]);

/** Skills never shared: they configure things SupraCode deliberately lacks. */
export function isExcludedSkill(name: string): boolean {
  return name === "supracortex";
}

export interface SharedPaths {
  dir: string;
  configFile: string;
  skillsDir: string;
}

export function sharedPaths(paths: ProfilePaths): SharedPaths {
  // Next to the farm (state, not config: fully regenerated each launch).
  const dir = join(paths.farm, "..", "shared");
  return { dir, configFile: join(dir, "shared.opencode.json"), skillsDir: join(dir, "skills") };
}

export interface SharedReport {
  configFile: string;
  mcp: string[];
  provider: string[];
  skills: string[];
  /** Stock entries left out because the profile defines the same name. */
  shadowedByProfile: string[];
  excluded: string[];
  /** Non-fatal problems (unparseable stock config, unreadable skills dir). */
  warnings: string[];
}

function readJsonc(path: string): Record<string, unknown> | null {
  for (const candidate of [path, path.replace(/\.json$/, ".jsonc")]) {
    if (!existsSync(candidate)) continue;
    const errors: ParseError[] = [];
    const value = parse(readFileSync(candidate, "utf8"), errors, { allowTrailingComma: true }) as unknown;
    if (errors.length) throw new Error(`cannot parse ${candidate}`);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }
  return null;
}

function stockConfig(paths: ProfilePaths): Record<string, unknown> | null {
  return readJsonc(join(paths.stockConfig, "opencode.json"));
}

function profileConfig(paths: ProfilePaths): Record<string, unknown> {
  try {
    return readJsonc(join(paths.opencodeConfig, "opencode.json")) ?? {};
  } catch {
    return {};
  }
}

function sectionKeys(cfg: Record<string, unknown>, section: string): Set<string> {
  const v = cfg[section];
  return new Set(v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);
}

/** Skill directories to share: stock OpenCode skills (external dirs such as
 * ~/.claude/skills and ~/.agents/skills are scanned by OpenCode itself). */
function stockSkillDirs(paths: ProfilePaths): string[] {
  return [join(paths.stockConfig, "skills"), join(paths.stockConfig, "skill")].filter((d) => existsSync(d));
}

/** Recreate the skills link dir to mirror stock skills (minus exclusions). */
function syncSkillLinks(skillsDir: string, sources: string[], report: SharedReport): void {
  mkdirSync(skillsDir, { recursive: true });
  const want = new Map<string, string>();
  for (const src of sources) {
    let names: string[] = [];
    try {
      names = readdirSync(src);
    } catch (err) {
      report.warnings.push(`cannot read ${src}: ${(err as Error).message}`);
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (isExcludedSkill(name)) {
        report.excluded.push(`skill:${name}`);
        continue;
      }
      const target = join(src, name);
      if (!existsSync(join(target, "SKILL.md"))) continue;
      if (!want.has(name)) want.set(name, target);
    }
  }
  // Remove stale links (never touch non-links).
  for (const name of readdirSync(skillsDir)) {
    const p = join(skillsDir, name);
    try {
      if (lstatSync(p).isSymbolicLink() && want.get(name) !== readlinkSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  for (const [name, target] of want) {
    const p = join(skillsDir, name);
    if (!existsSync(p)) {
      try {
        symlinkSync(target, p, "dir");
      } catch (err) {
        report.warnings.push(`cannot link skill ${name}: ${(err as Error).message}`);
        continue;
      }
    }
    report.skills.push(name);
  }
}

/**
 * Build the shared layer. Never throws: a broken stock config degrades to
 * "nothing shared" with a warning, so SupraCode always launches.
 */
export function buildSharedLayer(paths: ProfilePaths): SharedReport {
  const sp = sharedPaths(paths);
  const report: SharedReport = { configFile: sp.configFile, mcp: [], provider: [], skills: [], shadowedByProfile: [], excluded: [], warnings: [] };
  mkdirSync(sp.dir, { recursive: true });
  let stock: Record<string, unknown> | null = null;
  try {
    stock = stockConfig(paths);
  } catch (err) {
    report.warnings.push(`stock OpenCode config not shared: ${(err as Error).message}`);
  }
  const profile = profileConfig(paths);
  const shared: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  for (const section of SHARED_SECTIONS) {
    const src = stock?.[section];
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    const own = sectionKeys(profile, section);
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(src as Record<string, unknown>)) {
      if (section === "mcp" && MCP_EXCLUDE.has(name)) {
        report.excluded.push(`mcp:${name}`);
        continue;
      }
      if (own.has(name)) {
        report.shadowedByProfile.push(`${section}:${name}`);
        continue;
      }
      out[name] = value;
      (section === "mcp" ? report.mcp : report.provider).push(name);
    }
    if (Object.keys(out).length) shared[section] = out;
  }
  syncSkillLinks(sp.skillsDir, stockSkillDirs(paths), report);
  if (report.skills.length) shared.skills = { paths: [sp.skillsDir] };
  // Atomic write: a concurrently starting SupraCode never reads half a file.
  const tmp = `${sp.configFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(shared, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, sp.configFile);
  return report;
}
