/**
 * SupraCode host profile: stock OpenCode, isolated from the user's global
 * OpenCode configuration.
 *
 * OpenCode derives its global config directory solely from `XDG_CONFIG_HOME`
 * (`<XDG_CONFIG_HOME>/opencode`, computed once at startup via xdg-basedir);
 * there is no flag that skips loading it. So the launcher points
 * `XDG_CONFIG_HOME` at a SupraCode-owned "config farm":
 *
 *   ~/.config/supracode/opencode/          SupraCode's OpenCode config (user-editable:
 *                                          add plugins, agents, MCP servers here)
 *   ~/.local/state/supracode/xdg-config/   the farm handed to OpenCode as XDG_CONFIG_HOME
 *     opencode -> ~/.config/supracode/opencode
 *     gh       -> ~/.config/gh            (every other ~/.config entry is linked
 *     git      -> ~/.config/git            through, so gh/git/etc. launched from the
 *     ...                                  bash tool, MCP servers and LSPs keep working)
 *
 * What is deliberately NOT isolated: XDG data/cache/state. Logins (auth.json),
 * session history and downloaded binaries stay shared with stock OpenCode.
 * MCP servers, model providers and skills are shared LIVE through a generated
 * layer (see shared.ts). Plugins, agents, commands and TUI plugins
 * stay separate — "same tools, add plugins myself".
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, mkdirSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export const OWNED_MARKER = "supracortex:owned";

export interface ProfilePaths {
  /** SupraCode-owned OpenCode config dir (what OpenCode sees as its global config). */
  opencodeConfig: string;
  /** The farm passed as XDG_CONFIG_HOME. */
  farm: string;
  /** The user's real XDG config home (source of the pass-through links). */
  realConfigHome: string;
  /** The user's stock OpenCode config dir. */
  stockConfig: string;
}

export function profilePaths(env: NodeJS.ProcessEnv = process.env): ProfilePaths {
  const home = env.HOME?.trim() || homedir();
  const realConfigHome = env.SUPRACODE_REAL_XDG_CONFIG_HOME?.trim() || env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const supracodeHome = env.SUPRACODE_HOME?.trim() || join(home, ".config", "supracode");
  const stateHome = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  return {
    opencodeConfig: join(supracodeHome, "opencode"),
    farm: join(stateHome, "supracode", "xdg-config"),
    realConfigHome,
    stockConfig: join(realConfigHome, "opencode"),
  };
}

/** Entries of the real config home that must never be linked into the farm. */
const FARM_EXCLUDE = new Set(["opencode", "supracode"]);

/**
 * Create/refresh the config farm. Idempotent and cheap (one readdir). Links
 * are refreshed every launch so config dirs created after install (e.g. a new
 * `gh auth login`) are visible to child processes too. Anything in the farm
 * that is not a symlink is left untouched (never delete user data).
 */
export function refreshConfigFarm(paths: ProfilePaths): void {
  mkdirSync(paths.farm, { recursive: true });
  mkdirSync(paths.opencodeConfig, { recursive: true });
  const want = new Map<string, string>([["opencode", paths.opencodeConfig]]);
  let entries: string[] = [];
  try {
    entries = readdirSync(paths.realConfigHome);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (FARM_EXCLUDE.has(name)) continue;
    want.set(name, join(paths.realConfigHome, name));
  }
  for (const name of readdirSync(paths.farm)) {
    const at = join(paths.farm, name);
    const info = lstatSync(at);
    if (!info.isSymbolicLink()) continue;
    const target = readlinkSync(at);
    if (want.get(name) !== target) unlinkSync(at);
  }
  for (const [name, target] of want) {
    const at = join(paths.farm, name);
    if (existsSync(at) || isDanglingLink(at)) continue;
    symlinkSync(target, at);
  }
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Env vars that would re-inject configuration from outside the profile. */
const LEAKY_ENV = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_TUI_CONFIG",
];

/** Build the environment for launching OpenCode as SupraCode. Pure. */
export function supracodeEnv(base: NodeJS.ProcessEnv, paths: ProfilePaths, sharedConfig?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of LEAKY_ENV) delete env[key];
  env.XDG_CONFIG_HOME = paths.farm;
  // The ONLY config injected from outside the profile is SupraCode's own
  // generated shared layer (stock MCP servers, providers, skills — never
  // plugins). A user-set OPENCODE_CONFIG was stripped above: it could carry
  // stock plugins.
  if (sharedConfig) env.OPENCODE_CONFIG = sharedConfig;
  // Remember the real value so nested `supracode` invocations (and the
  // migration/doctor commands) resolve the user's real config home.
  env.SUPRACODE_REAL_XDG_CONFIG_HOME = paths.realConfigHome;
  env.SUPRACODE = "1";
  return env;
}

// ---------------------------------------------------------------------------
// Profile contents
// ---------------------------------------------------------------------------

export interface ProfileReport {
  created: string[];
  edited: string[];
  skipped: string[];
  notes: string[];
}

function newReport(): ProfileReport {
  return { created: [], edited: [], skipped: [], notes: [] };
}

async function readJsonc(path: string): Promise<Record<string, unknown> | null> {
  try {
    const errors: ParseError[] = [];
    const value = parse(await readFile(path, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Providers from the stock config, minus inline credentials. OpenCode resolves
 * a provider's key from auth.json (shared data dir) when `options.apiKey` is
 * absent, so SupraCode works with the same logins without a second copy of the
 * secret on disk.
 */
async function stockProviders(stockConfig: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const file of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const cfg = await readJsonc(join(stockConfig, file));
    const providers = cfg?.provider;
    if (!providers || typeof providers !== "object") continue;
    for (const [id, raw] of Object.entries(providers as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const copy = structuredClone(raw) as Record<string, unknown>;
      const options = copy.options as Record<string, unknown> | undefined;
      if (options) {
        for (const key of Object.keys(options)) {
          if (/key|token|secret|password|authorization/i.test(key)) delete options[key];
        }
        if (options.headers && typeof options.headers === "object") {
          for (const h of Object.keys(options.headers as Record<string, unknown>)) {
            if (/key|token|secret|authorization/i.test(h)) delete (options.headers as Record<string, unknown>)[h];
          }
        }
      }
      out[id] = copy;
    }
  }
  return out;
}

export interface ProfileContents {
  /** Absolute path of the SupraCortex V1 plugin bundle (dist/opencode.js). */
  pluginBundle: string;
  /** Absolute path of the brand TUI package dir (packages/tui). */
  brandTui: string;
  /** Command templates: file name -> content. */
  commands: Record<string, string>;
  /** Skill markdown for skills/supracortex/SKILL.md. */
  skill?: string;
}

function pluginLoader(bundle: string): string {
  return (
    `// ${OWNED_MARKER}\n` +
    `// SupraCortex engine for the SupraCode profile (OpenCode V1 plugin contract).\n` +
    `// A project-local .opencode/plugins/supracortex.ts takes precedence so the\n` +
    `// engine is initialized exactly once per worktree.\n` +
    `import { existsSync } from "node:fs";\n` +
    `import { join } from "node:path";\n` +
    `import { fileURLToPath } from "node:url";\n` +
    `const bundle = ${JSON.stringify(`file://${bundle}`)};\n` +
    `export const SupraCortex = async (input, options) => {\n` +
    `  const root = input?.directory ?? process.cwd();\n` +
    `  const local = join(root, ".opencode", "plugins", "supracortex.ts");\n` +
    `  if (existsSync(local) && fileURLToPath(import.meta.url) !== local) return {};\n` +
    `  const mod = await import(bundle);\n` +
    `  const plugin = mod.SupraCortex ?? mod.default;\n` +
    `  return typeof plugin === "function" ? plugin(input, options) : {};\n` +
    `};\n` +
    `export default SupraCortex;\n`
  );
}

async function writeOwned(path: string, content: string, report: ProfileReport): Promise<void> {
  if (existsSync(path)) {
    const current = await readFile(path, "utf8");
    if (current === content) {
      report.skipped.push(path);
      return;
    }
    if (!current.includes(OWNED_MARKER)) {
      report.notes.push(`preserved user-owned ${path}`);
      report.skipped.push(path);
      return;
    }
    await writeFile(path, content, "utf8");
    report.edited.push(path);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  report.created.push(path);
}

/**
 * Create or refresh the SupraCode profile. Only SupraCortex-owned files are
 * (re)written; `opencode.json` and `tui.json` are created once and afterwards
 * belong to the user — except the single brand TUI entry, which is ensured.
 */
export async function ensureProfile(contents: ProfileContents, env: NodeJS.ProcessEnv = process.env): Promise<ProfileReport> {
  const paths = profilePaths(env);
  const report = newReport();
  await mkdir(paths.opencodeConfig, { recursive: true });

  const cfgPath = join(paths.opencodeConfig, "opencode.json");
  if (!existsSync(cfgPath) && !existsSync(join(paths.opencodeConfig, "opencode.jsonc"))) {
    const provider = await stockProviders(paths.stockConfig);
    const cfg: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
    if (Object.keys(provider).length) cfg.provider = provider;
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    report.created.push(cfgPath);
    if (Object.keys(provider).length) {
      report.notes.push(`copied provider definitions (${Object.keys(provider).join(", ")}) from stock OpenCode, without inline keys`);
    }
  } else {
    report.skipped.push(cfgPath);
  }

  await writeOwned(join(paths.opencodeConfig, "plugins", "supracortex.ts"), pluginLoader(contents.pluginBundle), report);

  const tuiPath = join(paths.opencodeConfig, "tui.json");
  let tuiText = existsSync(tuiPath) ? await readFile(tuiPath, "utf8") : `{\n  "$schema": "https://opencode.ai/tui.json"\n}\n`;
  const tui = parse(tuiText) as { plugin?: unknown } | undefined;
  const plugins = Array.isArray(tui?.plugin) ? (tui!.plugin as unknown[]) : [];
  const specOf = (p: unknown): string => String(Array.isArray(p) ? p[0] : p);
  // A brand entry from an older checkout location (…/packages/tui of any
  // supracortex tree) is stale: replace it instead of appending a second one.
  const isOurBrand = (p: unknown): boolean => /supracortex[^/]*\/packages\/tui\/?$/.test(specOf(p));
  const hasBrand = plugins.some((p) => specOf(p) === contents.brandTui);
  const stale = plugins.filter((p) => isOurBrand(p) && specOf(p) !== contents.brandTui);
  if (!hasBrand || stale.length) {
    const next = [...plugins.filter((p) => !stale.includes(p)), ...(hasBrand ? [] : [contents.brandTui])];
    tuiText = applyEdits(tuiText, modify(tuiText, ["plugin"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    const existed = existsSync(tuiPath);
    await writeFile(tuiPath, tuiText, "utf8");
    (existed ? report.edited : report.created).push(tuiPath);
  } else {
    report.skipped.push(tuiPath);
  }

  for (const [name, body] of Object.entries(contents.commands)) {
    await writeOwned(join(paths.opencodeConfig, "commands", name), body, report);
  }
  if (contents.skill) {
    await writeOwned(join(paths.opencodeConfig, "skills", "supracortex", "SKILL.md"), contents.skill, report);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Migration: remove SupraCortex from stock OpenCode
// ---------------------------------------------------------------------------

export interface MigrationReport {
  removed: string[];
  edited: string[];
  backups: string[];
  notes: string[];
  dryRun: boolean;
}

async function backupFile(path: string, backupDir: string, report: MigrationReport): Promise<void> {
  const dest = join(backupDir, path.replace(/^\/+/, "").replace(/\//g, "__"));
  await mkdir(backupDir, { recursive: true });
  await copyFile(path, dest);
  report.backups.push(dest);
}

/**
 * Remove every SupraCortex-owned artifact from the user's STOCK OpenCode
 * config so plain `opencode` is exactly stock again. Only files carrying the
 * ownership marker, or entries we can positively identify as ours, are
 * touched; every change is backed up first. Idempotent.
 */
export async function migrateOutOfStock(opts: { dryRun?: boolean; brandTui: string; env?: NodeJS.ProcessEnv }): Promise<MigrationReport> {
  const paths = profilePaths(opts.env ?? process.env);
  const stock = paths.stockConfig;
  const dryRun = opts.dryRun === true;
  const report: MigrationReport = { removed: [], edited: [], backups: [], notes: [], dryRun };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(dirname(paths.opencodeConfig), "migration-backups", stamp);

  const removeOwnedFile = async (path: string): Promise<void> => {
    if (!existsSync(path)) return;
    const text = await readFile(path, "utf8");
    if (!text.includes(OWNED_MARKER) && !/supracortex|cortex_/i.test(text)) {
      report.notes.push(`left ${path} (not recognisably SupraCortex-owned)`);
      return;
    }
    if (!dryRun) {
      await backupFile(path, backupDir, report);
      await rm(path);
    }
    report.removed.push(path);
  };

  // 1. Engine plugin loader.
  await removeOwnedFile(join(stock, "plugins", "supracortex.ts"));

  // 2. Slash commands.
  const commandsDir = join(stock, "commands");
  if (existsSync(commandsDir)) {
    for (const name of readdirSync(commandsDir)) {
      if (/^cortex-.*\.md$/.test(name)) await removeOwnedFile(join(commandsDir, name));
    }
  }

  // 3. Skill.
  const skill = join(stock, "skills", "supracortex", "SKILL.md");
  await removeOwnedFile(skill);
  if (!dryRun && existsSync(dirname(skill)) && readdirSync(dirname(skill)).length === 0) await rmdir(dirname(skill));

  // 4. Brand TUI entry in tui.json (every other entry preserved).
  const tuiPath = join(stock, "tui.json");
  if (existsSync(tuiPath)) {
    const text = await readFile(tuiPath, "utf8");
    const value = parse(text) as { plugin?: unknown } | undefined;
    const plugins = Array.isArray(value?.plugin) ? (value!.plugin as unknown[]) : [];
    const kept = plugins.filter((p) => {
      const spec = String(Array.isArray(p) ? p[0] : p);
      return spec !== opts.brandTui && !/supracode|supracortex/i.test(spec);
    });
    if (kept.length !== plugins.length) {
      if (!dryRun) {
        await backupFile(tuiPath, backupDir, report);
        const next = applyEdits(text, modify(text, ["plugin"], kept, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
        await writeFile(tuiPath, next, "utf8");
      }
      report.edited.push(tuiPath);
    }
  }

  // 5. MCP entries named supracortex, in any stock config file / shape.
  for (const file of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const path = join(stock, file);
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    const value = parse(text) as { mcp?: Record<string, unknown> } | undefined;
    const mcp = value?.mcp;
    if (!mcp || typeof mcp !== "object") continue;
    const edits: Array<(string | number)[]> = [];
    if ("supracortex" in mcp) edits.push(["mcp", "supracortex"]);
    const servers = (mcp as { servers?: Record<string, unknown> }).servers;
    if (servers && typeof servers === "object" && "supracortex" in servers) edits.push(["mcp", "servers", "supracortex"]);
    if (!edits.length) continue;
    let next = text;
    for (const pathKeys of edits) next = applyEdits(next, modify(next, pathKeys, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    // Drop containers we emptied (`mcp.servers: {}` / `mcp: {}`).
    const after = parse(next) as { mcp?: Record<string, unknown> } | undefined;
    if (after?.mcp && typeof after.mcp === "object") {
      const s = (after.mcp as { servers?: Record<string, unknown> }).servers;
      if (s && typeof s === "object" && Object.keys(s).length === 0) next = applyEdits(next, modify(next, ["mcp", "servers"], undefined, {}));
      const again = parse(next) as { mcp?: Record<string, unknown> } | undefined;
      if (again?.mcp && Object.keys(again.mcp).length === 0) next = applyEdits(next, modify(next, ["mcp"], undefined, {}));
    }
    const remaining = parse(next) as Record<string, unknown> | undefined;
    const onlySchema = remaining && Object.keys(remaining).every((k) => k === "$schema");
    if (!dryRun) {
      await backupFile(path, backupDir, report);
      if (onlySchema && file === "opencode.jsonc") await rm(path);
      else await writeFile(path, next, "utf8");
    }
    if (onlySchema && file === "opencode.jsonc") report.removed.push(path);
    else report.edited.push(path);
  }

  // 6. SupraCortex's own global config lives in ~/.config/supracortex now.
  const legacyDir = join(stock, "supracortex");
  if (existsSync(join(legacyDir, "config.jsonc"))) {
    const dest = join(paths.realConfigHome, "supracortex", "config.jsonc");
    if (!existsSync(dest)) {
      if (!dryRun) {
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(legacyDir, "config.jsonc"), dest);
        if (existsSync(join(legacyDir, "config.schema.json"))) {
          await copyFile(join(legacyDir, "config.schema.json"), join(dirname(dest), "config.schema.json"));
        }
      }
      report.edited.push(`${join(legacyDir, "config.jsonc")} -> ${dest}`);
    }
    if (!dryRun) {
      await backupFile(join(legacyDir, "config.jsonc"), backupDir, report);
      await rm(legacyDir, { recursive: true, force: true });
    }
    report.removed.push(legacyDir);
  }

  if (report.backups.length) report.notes.push(`backups in ${backupDir}`);
  return report;
}

/** Names of things that indicate SupraCortex is still wired into stock. */
export async function stockPollution(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const paths = profilePaths(env);
  const stock = paths.stockConfig;
  const found: string[] = [];
  if (existsSync(join(stock, "plugins", "supracortex.ts"))) found.push("plugins/supracortex.ts");
  if (existsSync(join(stock, "skills", "supracortex"))) found.push("skills/supracortex");
  const commandsDir = join(stock, "commands");
  if (existsSync(commandsDir) && readdirSync(commandsDir).some((n) => /^cortex-.*\.md$/.test(n))) found.push("commands/cortex-*.md");
  const tui = await readJsonc(join(stock, "tui.json"));
  if (Array.isArray(tui?.plugin) && (tui!.plugin as unknown[]).some((p) => /supracode|supracortex/i.test(String(Array.isArray(p) ? p[0] : p)))) found.push("tui.json brand plugin");
  for (const file of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const cfg = await readJsonc(join(stock, file));
    const mcp = cfg?.mcp as Record<string, unknown> | undefined;
    if (mcp && ("supracortex" in mcp || (typeof mcp.servers === "object" && mcp.servers !== null && "supracortex" in (mcp.servers as object)))) found.push(`${file} mcp.supracortex`);
  }
  if (existsSync(join(stock, "supracortex"))) found.push("supracortex/ (config dir)");
  return found;
}

export { basename };
