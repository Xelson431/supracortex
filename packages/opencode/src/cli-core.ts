/**
 * CLI core: the shared implementation behind install/enable/disable/status/
 * doctor/compact/inspect/reset/uninstall. Both the `supracortex` CLI
 * scripts and the OpenCode slash commands call into these functions so behavior
 * is identical regardless of entry point.
 *
 * Every mutating operation is idempotent and creates a backup before editing a
 * shared config file (opencode.json / .jsonc).
 */

import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile, realpath, lstat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { ensureProfile, migrateOutOfStock, profilePaths, stockPollution, type ProfileContents } from "./profile.ts";
import {
  HEALTH_STALE_AFTER_HOURS,
  HANDSHAKE_SLOW_MS as DIAG_HANDSHAKE_SLOW_MS,
  HANDSHAKE_BUDGET_MS as DIAG_HANDSHAKE_BUDGET_MS,
  HANDSHAKE_PROTOCOL_VERSION as DIAG_HANDSHAKE_PROTOCOL_VERSION,
  STILL_BOOTING_CODE as DIAG_STILL_BOOTING_CODE,
} from "../../core/src/diagnostics/index.ts";
import {
  JsonlStore,
  projectScopedConfig,
  effectiveDecisionTiming,
  resolveCredential,
  resolveDecisionProvider,
  buildDefaultTemplate,
  buildIndex,
  resolveProjectStorageDirectory,
  validateConfig,
  resolveConfig,
  unknownConfigKeys,
  type Config,
  readJsonlTail,
  safeReadFile,
} from "@local/supracortex-core";
import {
  globalConfigPath,
  loadConfig,
  projectConfigPath,
  readConfigFile,
  stripJsonc,
} from "./config-loader.ts";
import { createEngine, createReadOnlyStore } from "./lifecycle.ts";
import { providerCheck as providerCheckFn } from "./provider-cli.ts";
import { PLUGIN_VERSION, sanitizeLegacyInjectionMirror } from "./plugin.ts";
import {
  assertInstallerPathConfined,
  agentGuidance,
  wireAgents,
  uninstallAgents,
  detectAgents,
  wireCodexGlobal,
  unwireCodexGlobal,
  type AgentName,
  type CustomTarget,
  type WiringReport,
  mcpLaunch,
} from "./agent-wiring.ts";
import { connect } from "./connect.ts";

export const PROJECT_DIR = ".supracortex";
const PLUGIN_ENTRY_REL = join(".opencode", "plugins", "supracortex.ts");
const SKILL_ENTRY_REL = join(".opencode", "skills", "supracortex", "SKILL.md");
const OWNED_MARKER = "supracortex:owned";

export type OpenCodeGeneration = "v1" | "v2";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that a storage root cannot escape the project through a symlink.
 *
 * Storage is a trust boundary: a project may contain `.supracortex` as a
 * symlink to an external directory, and diagnostics must neither read/write
 * outside the project nor purge prompt-bearing files there. The storage root
 * may not exist yet, so resolve the deepest existing ancestor (through
 * symlinks) and append the missing tail. Returns an error message on failure,
 * `null` when containment holds.
 */
export async function assertStorageContained(projectRoot: string, storagePath: string): Promise<string | null> {
  try {
    const rootReal = await realpath(projectRoot);
    const rootPrefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
    const contained = (candidate: string): boolean => candidate === rootReal || candidate.startsWith(rootPrefix);

    // Realpath the deepest existing ancestor; a missing storage root cannot
    // be resolved directly. `stat` follows symlinks, so an existing symlinked
    // storage root resolves to its target here.
    let ancestor = storagePath;
    const missing: string[] = [];
    for (;;) {
      try {
        await stat(ancestor);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          return `cannot verify storage containment (${ancestor}): ${(err as Error).message}`;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) return `cannot verify storage containment for ${storagePath}`;
        missing.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
    const resolvedStorage = missing.length ? join(await realpath(ancestor), ...missing) : await realpath(ancestor);
    if (!contained(resolvedStorage)) {
      return `storage path is outside the project root: ${storagePath} resolves to ${resolvedStorage}`;
    }

    // Explicitly reject a storage root that is itself a symlink pointing out.
    try {
      if ((await lstat(storagePath)).isSymbolicLink()) {
        const targetReal = await realpath(storagePath);
        if (!contained(targetReal)) {
          return `storage path is a symlink outside the project root: ${storagePath} -> ${targetReal}`;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return `cannot verify storage containment (${storagePath}): ${(err as Error).message}`;
      }
    }
    return null;
  } catch (err) {
    return `cannot verify storage containment: ${(err as Error).message}`;
  }
}

async function backup(path: string): Promise<string | null> {
  if (!(await exists(path))) return null;
  // Cap litter: reuse a single sidecar file instead of timestamped copies.
  const bak = `${path}.bak`;
  await copyFile(path, bak);
  // Best-effort cleanup of legacy timestamped litter (keep max 3 if removal fails).
  try {
    const dir = dirname(path);
    const base = basename(path);
    const items = await readdir(dir).catch(() => [] as string[]);
    const legacy = (items as string[]).filter((n) => n.startsWith(`${base}.ci-backup-`)).sort();
    for (const n of legacy) {
      try { await rm(join(dir, n), { force: true }); } catch { /* keep */ }
    }
  } catch { /* best-effort */ }
  return bak;
}

/**
 * Central config body. Every feature is ON: the shipped defaults are the full
 * feature set, so the central file only records deliberate choices (currently
 * the decision provider). Deleting a key restores its all-on default.
 */
function centralConfigText(extra: Record<string, unknown> = {}): string {
  return (
    `// SupraCortex CENTRAL configuration (${OWNED_MARKER})\n` +
    `// Single source of truth for every project. Every feature is enabled by\n` +
    `// default; set a key here only to change it everywhere. Project files\n` +
    `// (<project>/.supracortex/config.jsonc) may only hold store identity and a\n` +
    `// per-project kill switch — other keys there are ignored.\n` +
    JSON.stringify({ $schema: "./config.schema.json", enabled: true, mode: "balanced", ...extra }, null, 2) +
    "\n"
  );
}

/** Read a JSONC object file (null when absent/unparseable). */
async function readJsoncObject(path: string): Promise<Record<string, unknown> | null> {
  if (!(await exists(path))) return null;
  try {
    const v = JSON.parse(stripJsonc(await readFile(path, "utf8"))) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Edit keys of an existing JSONC file in place (comments preserved) or create
 * it. `undefined` removes a key.
 */
async function editJsonc(path: string, edits: Array<[(string | number)[], unknown]>, create: () => string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let text = (await exists(path)) ? await readFile(path, "utf8") : create();
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`refusing to edit unparseable config ${path}`);
  for (const [keyPath, value] of edits) {
    text = applyEdits(text, modify(text, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  await writeFile(path, text, "utf8");
}

// ---------------------------------------------------------------------------
// Plugin entry loader (thin, imports the reusable package)
// ---------------------------------------------------------------------------

/**
 * Resolve the file:// specifier for the SupraCortex plugin entry given the
 * directory this module is running from (`here`). Bundled runs (node
 * dist/cli.js) have cli-core.ts inlined into dist/cli.js, so `here` is the
 * dist/ directory and the built plugin entry is dist/opencode.js (there is no
 * dist/plugin.ts — cli-core.ts is the only file bundled per entry point).
 * Source runs have `here` at packages/opencode/src, where plugin.ts exists
 * directly. Exported as a pure helper so both branches are unit-testable
 * without needing to actually execute the bundled CLI.
 */
export function pluginEntrySpecFor(here: string, generation: OpenCodeGeneration = "v1"): string {
  if (basename(here) === "dist") {
    return pathToFileURL(join(here, generation === "v2" ? "opencode-v2.js" : "opencode.js")).href;
  }
  return pathToFileURL(join(here, generation === "v2" ? "plugin-v2.ts" : "plugin.ts")).href;
}

/**
 * Select the host contract without probing an interactive CLI. An explicit
 * environment override makes CI and installations deterministic; otherwise an
 * existing V2-shaped config is authoritative and the established V1 contract
 * remains the safe default.
 */
export async function detectOpenCodeGeneration(root: string, env = process.env): Promise<OpenCodeGeneration> {
  const override = env.SUPRACORTEX_OPENCODE_GENERATION?.trim().toLowerCase();
  if (override === "v1" || override === "1") return "v1";
  if (override === "v2" || override === "2") return "v2";

  for (const file of [join(root, "opencode.jsonc"), join(root, "opencode.json")]) {
    if (!(await exists(file))) continue;
    try {
      const value = JSON.parse(stripJsonc(await readFile(file, "utf8"))) as Record<string, unknown>;
      if (Array.isArray(value.plugins) || (value.mcp && typeof value.mcp === "object" && "servers" in value.mcp)) return "v2";
      if (Array.isArray(value.plugin)) return "v1";
    } catch {
      // Invalid user config is the host's concern; retain the safe V1 default.
    }
  }
  return "v1";
}

/** Resolve the packaged canonical skill in both source and bundled installs. */
export function skillTemplatePathFor(here: string): string {
  const packageRoot = basename(here) === "dist" ? join(here, "..") : join(here, "..", "..", "..");
  return join(packageRoot, "templates", "skills", "supracortex", "SKILL.md");
}

async function canonicalSkillSource(): Promise<string> {
  return readFile(skillTemplatePathFor(dirname(fileURLToPath(import.meta.url))), "utf8");
}

async function installSkill(root: string, global: boolean, force: boolean | undefined, report: InstallReport): Promise<void> {
  const skillPath = global
    ? join(homedir(), ".config", "opencode", "skills", "supracortex", "SKILL.md")
    : join(root, SKILL_ENTRY_REL);
  const source = await canonicalSkillSource();
  if (await exists(skillPath)) {
    const current = await readFile(skillPath, "utf8");
    if (current.includes(OWNED_MARKER)) {
      if (force && current !== source) {
        await writeFile(skillPath, source, "utf8");
        report.edited.push(skillPath);
      } else {
        report.skipped.push(skillPath);
      }
    } else {
      report.skipped.push(skillPath);
      report.notes.push(`preserved user-owned ${skillPath}`);
    }
    return;
  }
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, source, "utf8");
  report.created.push(skillPath);
}

function ownedLoaderLines(spec: string, generation: OpenCodeGeneration): string {
  // OpenCode V1 and V2 require different plugin shapes. Keep one loader file
  // safe for either process: V1 exports the named/default function, V2 sees a
  // default {id, setup} object selected by SUPRACODE_HOST_GENERATION. Imports
  // are lazy so the wrong adapter is never evaluated. When both a global and
  // project loader are discoverable, the global loader defers to the project
  // loader, preventing duplicate engine instances.
  const v1Spec = generation === "v1" ? spec : pluginEntrySpecFor(dirname(fileURLToPath(import.meta.url)), "v1");
  const v2Spec = generation === "v2" ? spec : pluginEntrySpecFor(dirname(fileURLToPath(import.meta.url)), "v2");
  return `// ${OWNED_MARKER}
// Dual-host SupraCode loader. V1 and V2 adapters are lazy and remain isolated.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const v1Spec = ${JSON.stringify(v1Spec)};
const v2Spec = ${JSON.stringify(v2Spec)};
const modulePath = fileURLToPath(import.meta.url);
const localLoaderFor = (root) => join(root, ".opencode", "plugins", "supracortex.ts");
const hasProjectLoader = (root) => {
  try { const local = localLoaderFor(root); return existsSync(local) && fileURLToPath(import.meta.url) !== local; }
  catch { return false; }
};
const v1 = async (input, options) => {
  const root = input?.directory ?? process.cwd();
  if (hasProjectLoader(root)) return {};
  const mod = await import(v1Spec);
  const plugin = mod.SupraCortex ?? mod.default;
  return typeof plugin === "function" ? plugin(input, options) : {};
};
const v2 = {
  id: "supracortex",
  async setup(context) {
    const root = process.env.SUPRACORTEX_ROOT ?? process.cwd();
    if (hasProjectLoader(root)) return;
    const mod = await import(v2Spec);
    const plugin = mod.SupraCortexV2 ?? mod.default;
    if (plugin && typeof plugin.setup === "function") return plugin.setup(context);
  }
};
export const SupraCortex = v1;
export default process.env.SUPRACODE_HOST_GENERATION === "v2" ? v2 : v1;
`;
}

async function pluginLoaderSource(root: string, generationOverride?: OpenCodeGeneration): Promise<string> {
  // Resolve the adapter plugin by absolute path from this repo so the loader
  // works for a local (unpublished) workspace install. If you publish
  // @local/supracortex-opencode to a registry your OpenCode can
  // resolve, replace this import with the bare specifier:
  //   export { SupraCortex } from "@local/supracortex-opencode/plugin";
  // `here` is packages/opencode/src in source runs, or dist/ when this file
  // is bundled into dist/cli.js.
  const here = dirname(fileURLToPath(import.meta.url));
  const generation = generationOverride ?? await detectOpenCodeGeneration(root);
  // The CLI is commonly invoked from source (`node scripts/cli.ts`) while
  // OpenCode loads the generated loader in a separate runtime. Prefer the
  // built adapter whenever it is available so OpenCode never has to compile
  // workspace TypeScript or resolve pnpm-only workspace aliases. Fall back to
  // source for development checkouts that have not been built yet.
  const repoDist = basename(here) === "dist" ? here : join(here, "..", "..", "..", "dist");
  const entryDir = existsSync(join(repoDist, generation === "v2" ? "opencode-v2.js" : "opencode.js"))
    ? repoDist
    : here;
  const spec = pluginEntrySpecFor(entryDir, generation);
  return ownedLoaderLines(spec, generation);
}

function nodeMcpExecutable(): string {
  return process.release?.name === "node"
    ? process.execPath
    : process.env.SUPRACODE_NODE_BIN?.trim() || "node";
}

function v2McpServer(root: string, dynamicRoot = false): Record<string, unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = basename(here) === "dist" ? join(here, "..") : join(here, "..", "..", "..");
  const cli = join(packageRoot, "dist", "cli.js");
  // The `supracode` wrapper may run this installer under Bun. MCP workers
  // require Node >=22.5 for node:sqlite; never persist Bun as the child
  // executable. An explicit override is useful for version managers.
  const node = nodeMcpExecutable();
  // Prefer the installed stable shim so the entry survives checkout moves.
  const launch = mcpLaunch();
  const command = launch.args.length === 0 ? [launch.command] : [node, cli, "mcp"];
  return {
    type: "local",
    command,
    ...(!dynamicRoot ? { cwd: root, environment: { SUPRACORTEX_ROOT: root } } : {}),
  };
}

/** Everything the SupraCode profile needs from this package, as absolute paths. */
export async function profileContents(cliPathOverride?: string): Promise<ProfileContents> {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = basename(here) === "dist" ? join(here, "..") : join(here, "..", "..", "..");
  const cliPath = await resolveCliPath(cliPathOverride);
  const commands: Record<string, string> = {};
  for (const name of COMMAND_NAMES) commands[`${name}.md`] = commandBody(name, cliPath);
  let skill: string | undefined;
  try {
    skill = await canonicalSkillSource();
  } catch {
    skill = undefined;
  }
  return {
    pluginBundle: join(packageRoot, "dist", "opencode.js"),
    brandTui: brandTuiPackageDir(),
    commands,
    ...(skill ? { skill } : {}),
  };
}

/** Absolute path of the SupraCode brand TUI package (this repo). */
function brandTuiPackageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = basename(here) === "dist" ? join(here, "..") : join(here, "..", "..", "..");
  return join(packageRoot, "packages", "tui");
}

/** Absolute path of the built V2 adapter bundle (this repo). */
function v2AdapterBundle(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = basename(here) === "dist" ? join(here, "..") : join(here, "..", "..", "..");
  return join(packageRoot, "dist", "opencode-v2.js");
}

/** Absolute path of the isolated OpenCode V2 brand TUI plugin bundle. */
function v2TuiPluginBundle(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = basename(here) === "dist" ? join(here, "..") : join(here, "..", "..", "..");
  return join(packageRoot, "packages", "tui", "dist", "tui-v2.js");
}

/** Register the V2-only TUI plugin without touching V1's tui.json. */
async function ensureV2TuiPlugin(root: string, report: InstallReport): Promise<void> {
  const file = join(root, "plugins", "supracode-v2", "tui.ts");
  const desired =
    `// ${OWNED_MARKER}\n` +
    `// SupraCode V2 TUI plugin entrypoint; discovered beside server index.ts.\n` +
    `export { default } from ${JSON.stringify(v2TuiPluginBundle())};\n`;
  if (await exists(file)) {
    const current = await readFile(file, "utf8");
    if (current === desired) {
      report.skipped.push(file);
      return;
    }
    if (!current.includes(OWNED_MARKER)) {
      report.notes.push(`preserved user-owned ${file}`);
      return;
    }
    await writeFile(file, desired, "utf8");
    report.edited.push(file);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, desired, "utf8");
  report.created.push(file);
}


/**
 * The dedicated supracode2 (OpenCode V2) config root. Resolved through the same
 * env-aware scheme as the SupraCode profile (`profilePaths` in profile.ts) — a
 * relocated `HOME` or `SUPRACODE_HOME` moves it too — and honoring
 * `SUPRACODE2_CONFIG_DIR`, the override the V2 launcher (scripts/cli.ts)
 * already uses, so the loader written here is exactly the one the launcher
 * reads. Never keyed off the developer's real `os.homedir()`.
 */
function v2ConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SUPRACODE2_CONFIG_DIR?.trim();
  if (override) return override;
  // profilePaths().opencodeConfig is <configHome>/supracode/opencode, so
  // supracode2 is its sibling: <configHome>/supracode2.
  const profileHome = dirname(profilePaths(env).opencodeConfig);
  return join(dirname(profileHome), "supracode2");
}

/**
 * Ensure the dedicated supracode2 (OpenCode V2) config root. Only the V2
 * plugin loader lives here; the shared V1 plugins directory is untouched.
 */
async function ensureV2Root(report: InstallReport): Promise<void> {
  const root = v2ConfigRoot();
  const indexPath = join(root, "plugins", "supracode-v2", "index.ts");
  const desired =
    `// ${OWNED_MARKER}\n` +
    `// SupraCortex V2 server plugin loader (supracode2 config root only).\n` +
    `// V2 discovers immediate package directories. A project loader takes\n` +
    `// precedence so the engine is initialized exactly once per worktree.\n` +
    `import { existsSync } from "node:fs";\n` +
    `import { join } from "node:path";\n` +
    `import { fileURLToPath } from "node:url";\n` +
    `const adapter = ${JSON.stringify(v2AdapterBundle())};\n` +
    `export default { id: "supracortex", async setup(context) {\n` +
    `  const project = process.env.SUPRACORTEX_ROOT ?? process.cwd();\n` +
    `  const local = join(project, ".opencode", "plugins", "supracortex.ts");\n` +
    `  if (existsSync(local) && fileURLToPath(import.meta.url) !== local) return;\n` +
    `  const mod = await import(adapter);\n` +
    `  return (mod.SupraCortexV2 ?? mod.default).setup(context);\n` +
    `} };\n`;
  if (await exists(indexPath)) {
    const current = await readFile(indexPath, "utf8");
    if (current === desired) {
      report.skipped.push(indexPath);
      await ensureV2TuiPlugin(root, report);
      await installV2Mcp(root, report, true);
      return;
    }
    if (!current.includes(OWNED_MARKER)) {
      report.notes.push(`preserved user-owned ${indexPath}`);
      return;
    }
    await writeFile(indexPath, desired, "utf8");
    report.edited.push(indexPath);
    await ensureV2TuiPlugin(root, report);
    await installV2Mcp(root, report, true);
    return;
  }
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, desired, "utf8");
  report.created.push(indexPath);
  await ensureV2TuiPlugin(root, report);
  await installV2Mcp(root, report, true);
}

/** Add the V2-local MCP entry without modifying user-owned server definitions. */
async function installV2Mcp(root: string, report: InstallReport, dynamicRoot = false): Promise<void> {
  const candidates = [join(root, "opencode.jsonc"), join(root, "opencode.json")];
  const file = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  const old = (await exists(file)) ? await readFile(file, "utf8") : "{}\n";
  const errors: ParseError[] = [];
  const parsed = parse(old, errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown> | undefined;
  if (errors.length || !parsed || Array.isArray(parsed)) {
    report.notes.push(`preserved invalid OpenCode V2 config ${file}`);
    return;
  }
  const mcp = parsed.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  if (servers?.supracortex !== undefined) {
    // Refresh only an entry this installer wrote (a supracortex cli.js /
    // shim command) whose path no longer exists; never a user-authored one.
    // Refresh only an entry this installer wrote (a supracortex cli.js or
    // supracortex-mcp command) that differs from the current one, e.g. after
    // the checkout moved. A user-authored entry is never touched.
    const cmd = (servers.supracortex as { command?: unknown }).command;
    const parts = Array.isArray(cmd) ? cmd.map(String) : [];
    const ours = parts.some((p) => /supracortex[^/]*\/dist\/cli\.js$|\/supracortex-mcp$/.test(p));
    const want = v2McpServer(root, dynamicRoot).command as string[];
    if (!ours || JSON.stringify(parts) === JSON.stringify(want)) {
      report.skipped.push(file);
      return;
    }
  }
  const edits = modify(old, ["mcp", "servers", "supracortex"], v2McpServer(root, dynamicRoot), {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const next = applyEdits(old, edits);
  if (await exists(file)) {
    const backupPath = await backup(file);
    if (backupPath) report.backups.push(backupPath);
    report.edited.push(file);
  } else {
    report.created.push(file);
  }
  await writeFile(file, next, "utf8");
}

/** Remove only the exact V2 server object written by this installer. */
async function uninstallV2Mcp(root: string, report: UninstallReport): Promise<void> {
  for (const file of [join(root, "opencode.jsonc"), join(root, "opencode.json")]) {
    if (!(await exists(file))) continue;
    const old = await readFile(file, "utf8");
    const errors: ParseError[] = [];
    const parsed = parse(old, errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown> | undefined;
    const server = (parsed?.mcp as Record<string, unknown> | undefined)?.servers as Record<string, unknown> | undefined;
    if (errors.length || !server?.supracortex) continue;
    if (JSON.stringify(server.supracortex) !== JSON.stringify(v2McpServer(root))) {
      report.notes.push(`preserved user-modified OpenCode V2 MCP server in ${file}`);
      continue;
    }
    const next = applyEdits(old, modify(old, ["mcp", "servers", "supracortex"], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
    await writeFile(file, next, "utf8");
    report.edited.push(file);
  }
}

/**
 * Remove the dedicated supracode2 (OpenCode V2) config root that `ensureV2Root`
 * created, without ever deleting user-modified content. Only marker-fenced
 * files and the exact V2 MCP entry this installer wrote are removed; any other
 * (user-authored / user-modified) content is backed up and left in place with a
 * note. Empty owned directories are pruned, and the root itself is removed only
 * when nothing else remains.
 */
async function uninstallV2Root(report: UninstallReport, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = v2ConfigRoot(env);
  if (!(await exists(root))) return;

  // 1. Marker-fenced V2 plugin loaders. A file without our marker was
  //    user-modified (or user-authored): back it up and keep it.
  for (const rel of [join("plugins", "supracode-v2", "index.ts"), join("plugins", "supracode-v2", "tui.ts")]) {
    const path = join(root, rel);
    if (!(await exists(path))) continue;
    const content = await readFile(path, "utf8");
    if (content.includes(OWNED_MARKER)) {
      await rm(path, { force: true });
      report.removed.push(path);
    } else {
      const bak = await backup(path);
      if (bak) report.backups.push(bak);
      report.notes.push(`preserved user-modified OpenCode V2 file ${path}${bak ? " (backed up)" : ""}`);
    }
  }

  // 2. Our exact V2 MCP server entry in the V2 root config. A changed entry is
  //    user-modified: back it up and leave it.
  for (const file of [join(root, "opencode.jsonc"), join(root, "opencode.json")]) {
    if (!(await exists(file))) continue;
    const old = await readFile(file, "utf8");
    const errors: ParseError[] = [];
    const parsed = parse(old, errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown> | undefined;
    const servers = (parsed?.mcp as Record<string, unknown> | undefined)?.servers as Record<string, unknown> | undefined;
    if (errors.length || !servers?.supracortex) continue;
    if (JSON.stringify(servers.supracortex) !== JSON.stringify(v2McpServer(root, true))) {
      const bak = await backup(file);
      if (bak) report.backups.push(bak);
      report.notes.push(`preserved user-modified OpenCode V2 MCP server in ${file}${bak ? " (backed up)" : ""}`);
      continue;
    }
    let next = applyEdits(old, modify(old, ["mcp", "servers", "supracortex"], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
    // Drop an emptied `mcp.servers` / `mcp` container.
    const after = parse(next) as Record<string, unknown> | undefined;
    const afterServers = (after?.mcp as Record<string, unknown> | undefined)?.servers as Record<string, unknown> | undefined;
    if (afterServers && Object.keys(afterServers).length === 0) {
      next = applyEdits(next, modify(next, ["mcp", "servers"], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
    }
    const mid = parse(next) as Record<string, unknown> | undefined;
    if (mid?.mcp && typeof mid.mcp === "object" && Object.keys(mid.mcp as object).length === 0) {
      next = applyEdits(next, modify(next, ["mcp"], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
    }
    const again = parse(next) as Record<string, unknown> | undefined;
    const onlySchema = again !== undefined && Object.keys(again).every((k) => k === "$schema");
    if (onlySchema && file.endsWith("opencode.jsonc")) {
      // The file held only our entry (regenerable): drop it, no backup litter.
      await rm(file, { force: true });
      report.removed.push(file);
    } else {
      // Mixed with user keys: back up before stripping only our entry.
      const bak = await backup(file);
      if (bak) report.backups.push(bak);
      await writeFile(file, next, "utf8");
      report.edited.push(file);
    }
  }

  // 3. Prune empty directories we own; never recurse into user content.
  for (const dir of [join(root, "plugins", "supracode-v2"), join(root, "plugins")]) {
    try {
      if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
    } catch { /* absent or non-empty */ }
  }
  try {
    if ((await readdir(root)).length === 0) {
      await rm(root, { recursive: true, force: true });
      report.removed.push(root);
    } else {
      report.notes.push(`left ${root} in place (still contains user content)`);
    }
  } catch { /* root already gone */ }
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

export interface InstallOptions {
  projectRoot: string;
  global?: boolean;
  /** Rewrite SupraCortex-owned loaders and commands, preserving runtime data and user-owned config. */
  force?: boolean;
  /** @deprecated Global installs are always enabled; accepted and ignored. */
  enableByDefault?: boolean;
  /** Absolute path to the CLI entry (scripts/cli.ts). Auto-detected if omitted. */
  cliPath?: string;
}

export interface InstallReport {
  created: string[];
  skipped: string[];
  edited: string[];
  backups: string[];
  notes: string[];
}

/** Phase 1 universal adapter transaction. With yes=false this is a pure plan. */
export interface InitOptions {
  /** Default true: `init --yes` enables the project unless `--no-enable`. */
  enable?: boolean;
}
export async function init(
  projectRoot: string,
  yes = false,
  only?: AgentName[],
  customTargets?: CustomTarget[],
  guidance = true,
  initOpts?: InitOptions,
): Promise<WiringReport> {
  const report = await wireAgents(projectRoot, {
    yes,
    ...(only ? { only } : {}),
    ...(customTargets && customTargets.length ? { customTargets } : {}),
    guidance,
  });
  if (!yes) {
    report.notes.push("init plan only (no files changed; re-run with --yes to enable + backfill)");
    return report;
  }
  const wantEnable = initOpts?.enable !== false;
  // Fresh-project defaults (only when no explicit --agent filter): ensure an
  // OpenCode loader and an imperative project rule exist so first-session
  // status can report ENABLED and the rule line is present. Explicit filters
  // are respected exactly (no extras). Under --no-enable these default writes
  // are skipped so the project is genuinely left as-is.
  if (only === undefined && wantEnable) {
    try {
      const loaderPath = join(projectRoot, PLUGIN_ENTRY_REL);
      const globalLoader = join(homedir(), ".config", "opencode", "plugins", "supracortex.ts");
      if (!(await exists(loaderPath)) && !(await exists(globalLoader))) {
        const extra = await wireAgents(projectRoot, { yes: true, only: ["opencode"], guidance: false });
        report.changes.push(...extra.changes);
        report.backups.push(...extra.backups);
        report.notes.push(...extra.notes.map((n) => `opencode default: ${n}`));
      }
    } catch (err) {
      report.notes.push(`opencode default loader warn: ${(err as Error).message}`);
    }
    if (guidance) {
      try {
        const note = await ensureProjectRule(projectRoot);
        if (note) report.notes.push(note);
      } catch (err) {
        report.notes.push(`project rule warn: ${(err as Error).message}`);
      }
    }
  }
  if (wantEnable) {
    try {
      const before = await safeLoadConfig(projectRoot).catch(() => null);
      const wasEnabled = before?.config.enabled === true;
      // Clears a per-project kill switch if present; never writes settings.
      await setEnabled(projectRoot, true);
      report.notes.push(
        wasEnabled
          ? `enabled (already enabled via central config ${globalConfigPath()})`
          : `enabled project (removed the per-project opt-out; follows ${globalConfigPath()}; restart required for a pre-existing session)`,
      );
    } catch (err) {
      report.notes.push(`enable warn: ${(err as Error).message} (resolve with 'supracortex enable')`);
    }
  } else {
    report.notes.push("enable skipped (--no-enable; project left as-is)");
    if (only === undefined && guidance) {
      report.notes.push("project rule skipped (--no-enable; project left as-is)");
    }
  }
  if (!wantEnable) {
    report.notes.push("backfill skipped (--no-enable; project left as-is)");
    return report;
  }
  try {
    const backfill = await backfillProjectIndex(projectRoot);
    report.notes.push(backfill.note);
  } catch (err) {
    report.notes.push(`backfill warn: ${(err as Error).message} (empty-packet preserved)`);
  }
  return report;
}
/** Imperative project rule marker line (exact; converged across guidance). */
export const PROJECT_RULE_LINE =
  "ALWAYS call cortex_context before any multi-file task; single typo fix may skip with reason";
/**
 * Ensure the imperative project rule is present. Precedence: CLAUDE.md when it
 * already carries owned guidance, else AGENTS.md (created when missing). No new
 * config root is invented; backups precede overwrites; re-runs are idempotent.
 */
export async function ensureProjectRule(projectRoot: string): Promise<string | null> {
  const claudeFile = join(projectRoot, "CLAUDE.md");
  const agentsFile = join(projectRoot, "AGENTS.md");
  const hasMarker = async (file: string): Promise<boolean> => {
    try {
      const text = await readFile(file, "utf8");
      return text.includes(PROJECT_RULE_LINE);
    } catch {
      return false;
    }
  };
  if (await hasMarker(claudeFile)) return "project rule present (CLAUDE.md)";
  if (await hasMarker(agentsFile)) return "project rule present (AGENTS.md)";
  // Prefer the existing file when one exists; otherwise create AGENTS.md.
  let target = agentsFile;
  try {
    const claudeExists = await exists(claudeFile);
    if (claudeExists) target = claudeFile;
  } catch { /* default stands */ }
  const block = agentGuidance();
  let old = "";
  try {
    old = await readFile(target, "utf8");
  } catch {
    old = "";
  }
  if (old.includes(block.trim())) return `project rule present (${target})`;
  let next: string;
  let created = false;
  if (!old.trim()) {
    next = `${block}\n`;
    created = true;
  } else if (old.includes("supracortex:owned")) {
    // Owned marker present but text may be stale or duplicated: collapse all
    // complete owned blocks to exactly one fresh block at the first position
    // (mirrors nextGuidanceContent; never truncates user content). Backup first.
    const ownedRe = /<!--\s*supracortex:owned\s*:\s*begin[\s\S]*?-->(?:[\s\S]*?<!--\s*supracortex:owned\s*:\s*end\s*-->)/g;
    const first = old.search(ownedRe);
    if (first !== -1) {
      const without = old.replace(ownedRe, "");
      next = `${without.slice(0, first)}${block}${without.slice(first)}`;
    } else {
      // Orphan fence only: append a fresh block and leave the orphan intact.
      next = `${old.endsWith("\n") ? old : `${old}\n`}\n${block}\n`;
    }
    if (next !== old) {
      const bak = await backup(target);
      void bak;
    }
  } else {
    const bak = await backup(target);
    void bak;
    next = `${old.endsWith("\n") ? old : `${old}\n`}\n${block}\n`;
  }
  if (next === old) return `project rule present (${target})`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, next, "utf8");
  return created ? `project rule created (${target})` : `project rule merged (${target})`;
}
/** Backfill the repository index when empty/missing. Never throws. */
export async function backfillProjectIndex(
  projectRoot: string,
): Promise<{ files: number; durationMs: number; note: string }> {
  let storageDir = join(projectRoot, PROJECT_DIR);
  try {
    const loaded = await safeLoadConfig(projectRoot);
    storageDir = resolveProjectStorageDirectory(projectRoot, loaded.config.storage.directory);
  } catch { /* default stands */ }
  const indexFile = join(storageDir, "index", "repository.json");
  try {
    const raw = await readFile(indexFile, "utf8");
    const parsed = JSON.parse(raw) as { files?: Record<string, unknown> };
    const count = parsed?.files ? Object.keys(parsed.files).length : 0;
    if (count > 0) return { files: count, durationMs: 0, note: `backfill skipped (index non-empty: ${count} files)` };
  } catch { /* missing/empty -> build */ }
  const started = Date.now();
  try {
    const outcome = await buildIndex({ root: projectRoot });
    const durationMs = Date.now() - started;
    const files = Object.keys(outcome.index.files).length;
    // Integrity check: written file count must match the built index.
    if (files !== outcome.scanned) {
      return {
        files,
        durationMs,
        note: `backfill warn: integrity mismatch scanned=${outcome.scanned} files=${files} skipped=${outcome.skipped} in ${durationMs}ms (truncated reason; empty-packet may persist)`,
      };
    }
    await mkdir(dirname(indexFile), { recursive: true });
    if (await exists(indexFile)) await backup(indexFile);
    await writeFile(indexFile, JSON.stringify(outcome.index, null, 2) + "\n", "utf8");
    if (files === 0) {
      return { files, durationMs, note: `backfill warn: 0 files indexed in ${durationMs}ms (empty repo or all-protected; empty-packet preserved)` };
    }
    const capNote = outcome.skipped > 0 ? `, skipped ${outcome.skipped}` : "";
    return { files, durationMs, note: `backfill index: ${files} files in ${durationMs}ms${capNote}` };
  } catch (err) {
    const durationMs = Date.now() - started;
    return { files: 0, durationMs, note: `backfill warn: ${(err as Error).message} in ${durationMs}ms (empty-packet preserved)` };
  }
}
export async function upgrade(projectRoot: string, guidance = true): Promise<WiringReport> {
  return wireAgents(projectRoot, { yes: true, guidance });
}
export { detectAgents, uninstallAgents };

/**
 * Global install: writes the SupraCode profile (loader, commands, skill; stock
 * ~/.config/opencode is never written), the Codex MCP entry, and the central
 * config with SupraCortex enabled everywhere. A project opts out with its own
 * `{ "enabled": false }`.
 */
async function installGlobal(opts: InstallOptions, report: InstallReport): Promise<InstallReport> {
  // Central config: always enabled. An existing file is preserved except
  // that a disabled/off central switch left by older installers is turned on
  // (explicit user edits to any other key are kept).
  const globCfgPath = globalConfigPath();
  const current = await readJsoncObject(globCfgPath);
  if (!current) {
    await mkdir(dirname(globCfgPath), { recursive: true });
    await writeFile(globCfgPath, centralConfigText(), "utf8");
    report.created.push(globCfgPath);
  } else if (current.enabled === false || current.mode === "off") {
    const bak = await backup(globCfgPath);
    if (bak) report.backups.push(bak);
    await editJsonc(globCfgPath, [[["enabled"], true], [["mode"], "balanced"]], () => centralConfigText());
    report.edited.push(globCfgPath);
  } else {
    report.skipped.push(globCfgPath);
  }
  const globSchema = join(dirname(globCfgPath), "config.schema.json");
  if (!(await exists(globSchema))) {
    await writeFile(globSchema, JSON.stringify(configSchema(), null, 2), "utf8");
    report.created.push(globSchema);
  }

  // SupraCode host profile. Everything OpenCode-facing (engine plugin loader,
  // brand TUI plugin, slash commands, skill) goes into SupraCode's OWN isolated
  // OpenCode config dir — never into the user's stock ~/.config/opencode — so
  // plain `opencode` stays stock and SupraCode stays stock-plus-SupraCortex.
  const profile = await ensureProfile(await profileContents(opts.cliPath));
  report.created.push(...profile.created);
  report.edited.push(...profile.edited);
  report.skipped.push(...profile.skipped);
  report.notes.push(...profile.notes);
  const leftovers = await stockPollution();
  if (leftovers.length) {
    report.notes.push(
      `stock OpenCode still carries SupraCortex artifacts (${leftovers.join(", ")}); ` +
        "run 'supracode migrate --yes' to remove them (backups are kept).",
    );
  }
  // Dedicated supracode2 (OpenCode V2) config root. V1 and V2 file-plugin
  // contracts are incompatible by design.
  await ensureV2Root(report);

  // Global Codex wiring at ~/.codex/config.toml (rootless: adapts to launch dir).
  const codex = await wireCodexGlobal(homedir());
  if (codex.created) report.created.push(codex.file);
  else report.edited.push(codex.file);
  if (codex.backup) report.backups.push(codex.backup);

  report.notes.push(
    "Global install complete. SupraCortex is ENABLED in every project with every feature on; " +
      `settings are central (${globCfgPath}). Turn one project off with 'supracode disable' there, ` +
      "or everything via SUPRACORTEX_DISABLE=1.",
  );
  report.notes.push("Start a new OpenCode/Codex session so the integration loads.");
  return report;
}

export async function install(opts: InstallOptions): Promise<InstallReport> {
  const report: InstallReport = { created: [], skipped: [], edited: [], backups: [], notes: [] };
  const root = opts.projectRoot;

  if (opts.global) {
    return installGlobal(opts, report);
  }

  // 1. Runtime dir only. Settings are central; no project config is written
  // (a project file would only ever go stale relative to the central one).
  const runtimeDir = join(root, PROJECT_DIR);
  await mkdir(runtimeDir, { recursive: true });
  const cfgPath = projectConfigPath(root);
  if (await exists(cfgPath)) report.skipped.push(cfgPath);
  // Write the JSON schema alongside for editor validation.
  const schemaPath = join(runtimeDir, "config.schema.json");
  if (!(await exists(schemaPath))) {
    await writeFile(schemaPath, JSON.stringify(configSchema(), null, 2), "utf8");
    report.created.push(schemaPath);
  }

  // 2. Runtime state is private/generated and never becomes committable by a
  // config toggle. Reviewed exports must be deliberately created elsewhere.
  await ensureGitignore(runtimeDir, report);

  // 3. Plugin loader.
  const generation = await detectOpenCodeGeneration(root);
  const pluginPath = join(root, PLUGIN_ENTRY_REL);
  if (await exists(pluginPath)) {
    const current = await readFile(pluginPath, "utf8");
    if (opts.force && current.includes(OWNED_MARKER)) {
      await writeFile(pluginPath, await pluginLoaderSource(root), "utf8");
      report.edited.push(pluginPath);
    } else {
      report.skipped.push(pluginPath);
      if (opts.force && !current.includes(OWNED_MARKER)) report.notes.push(`preserved user-owned ${pluginPath}`);
    }
  } else {
    await mkdir(dirname(pluginPath), { recursive: true });
    await writeFile(pluginPath, await pluginLoaderSource(root), "utf8");
    report.created.push(pluginPath);
  }
  if (generation === "v2") await installV2Mcp(root, report);

  // 3b. Slash commands (project-local .opencode/commands/). Baked with an
  // absolute path to the CLI so the injected `!`node ...`` runs reliably.
  await installCommands(root, opts, report);

  // 3c. OpenCode discovers project skills from .opencode/skills/. This remains
  // separate from generated runtime data so agents can load it directly.
  await installSkill(root, false, opts.force, report);

  report.notes.push(
    "Restart or start a new OpenCode session for the plugin to load. Verify with /cortex-status.",
  );
  return report;
}

/** Refresh generated integration artifacts without touching runtime memory. */
export async function reinstall(opts: Omit<InstallOptions, "force">): Promise<InstallReport> {
  return install({ ...opts, force: true });
}

async function ensureGitignore(runtimeDir: string, report: InstallReport): Promise<void> {
  const giPath = join(runtimeDir, ".gitignore");
  const entries = [
    "# supracortex generated runtime state: do not un-ignore",
    "*",
    "!.gitignore",
    "!config.jsonc",
    "!config.schema.json",
    "!.supracortexignore",
    "",
  ].join("\n");
  if (await exists(giPath)) {
    const cur = await readFile(giPath, "utf8");
    if (!cur.includes("supracortex generated runtime state")) {
      await writeFile(giPath, cur + "\n" + entries, "utf8");
      report.edited.push(giPath);
    } else {
      report.skipped.push(giPath);
    }
  } else {
    await writeFile(giPath, entries, "utf8");
    report.created.push(giPath);
  }
}

export const COMMAND_NAMES = [
  "cortex-status",
  "cortex-enable",
  "cortex-disable",
  "cortex-doctor",
  "cortex-compact",
  "cortex-inspect",
  "cortex-reset",
  "jev",
] as const;

/** Resolve the absolute path to the CLI entry.
 *
 * Priority:
 * 1. An explicit path passed by the caller (tests/CI).
 * 2. The packed `dist/cli.js` if it exists next to this module (published install).
 * 3. The source `scripts/cli.ts` (local dev checkout).
 *
 * This avoids baking a source-only absolute path into slash commands when the
 * package has been packed and installed elsewhere.
 */
export async function resolveCliPath(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const here = dirname(fileURLToPath(import.meta.url));
  // Running from packed dist/cli.js — the current file IS the CLI.
  if (basename(here) === "dist") {
    const cli = join(here, "cli.js");
    try { await stat(cli); return cli; } catch { /* fall through */ }
  }
  // cli-core.ts lives at packages/opencode/src/ in source.
  const packedCli = join(here, "..", "..", "..", "dist", "cli.js");
  try {
    await stat(packedCli);
    return packedCli;
  } catch {
    // Not packed; use the source entry.
    return join(here, "..", "..", "..", "scripts", "cli.ts");
  }
}

function commandBody(name: string, cliPath: string): string {
  const templates: Record<string, string> = {
    "cortex-status": `---
description: Show supracortex status
agent: build
---
Run the status command and summarize for the user.
!\`node "${cliPath}" status\`
Explain whether it is active and why. If disabled, suggest /cortex-enable.`,
    "cortex-enable": `---
description: Enable supracortex for this project
agent: build
---
!\`node "${cliPath}" enable\`
Tell the user the change was persisted and a new OpenCode session may be required to fully load the plugin.`,
    "cortex-disable": `---
description: Disable supracortex for this project
agent: build
---
!\`node "${cliPath}" disable\`
Tell the user hooks stop immediately and memory/cache is preserved.`,
    "cortex-doctor": `---
description: Run supracortex health checks
agent: build
---
!\`node "${cliPath}" doctor\`
Summarize failing checks and suggest fixes.`,
    "jev": `---
description: Jev decision model — status, or set/forget its OpenRouter key (/jev, /jev key <KEY>, /jev login, /jev forget)
agent: build
---
!\`node "${cliPath}" jev $ARGUMENTS 2>&1\`
Report the output above briefly: which key source Jev uses and whether it is ACTIVE. Never repeat, quote or summarize any API key value.
If a key was just saved, remind the user that a key typed into chat is part of this conversation's history, so for the most private option they can run \`supracode jev key -\` in a terminal instead.
If Jev is not active, say SupraCortex keeps working with its deterministic ranking, and offer: \`/jev key <OPENROUTER_KEY>\`, or \`/jev login\` to reuse the OpenRouter login from \`opencode auth login\`.`,
    "cortex-compact": `---
description: Compact supracortex memory
agent: build
---
!\`node "${cliPath}" compact\`
Report superseded/expired/kept counts.`,
    "cortex-inspect": `---
description: Explain what context would be prepared for a task (no model call)
agent: build
---
Inspect context for: $ARGUMENTS
!\`node "${cliPath}" inspect "$ARGUMENTS"\`
Present selected memory, files, exclusions with reasons, and token budget.`,
    "cortex-reset": `---
description: Reset generated supracortex data. Requires confirmation.
agent: build
---
Target: $ARGUMENTS (cache|index|sessions|metrics|all-generated|all).
"all" deletes durable memory too — confirm with the user first, then:
!\`node "${cliPath}" reset $ARGUMENTS --yes\`
Report what was removed.`,
  };
  // The ownership marker must live INSIDE the front matter (as a YAML
  // comment): OpenCode only parses front matter that starts on line 1, so a
  // leading HTML comment silently dropped description/agent and leaked the
  // whole header into the prompt.
  const body = templates[name] ?? "";
  return body.startsWith("---\n") ? `---\n# ${OWNED_MARKER}\n${body.slice(4)}\n` : `<!-- ${OWNED_MARKER} -->\n${body}\n`;
}

async function installCommands(
  root: string,
  opts: InstallOptions,
  report: InstallReport,
): Promise<void> {
  const cliPath = await resolveCliPath(opts.cliPath);
  const dir = opts.global
    ? join(homedir(), ".config", "opencode", "commands")
    : join(root, ".opencode", "commands");
  await mkdir(dir, { recursive: true });
  for (const name of COMMAND_NAMES) {
    const path = join(dir, `${name}.md`);
    if (await exists(path)) {
      const current = await readFile(path, "utf8");
      if (opts.force && current.includes(OWNED_MARKER)) {
        await writeFile(path, commandBody(name, cliPath), "utf8");
        report.edited.push(path);
      } else {
        report.skipped.push(path);
        if (opts.force && !current.includes(OWNED_MARKER)) report.notes.push(`preserved user-owned ${path}`);
      }
      continue;
    }
    await writeFile(path, commandBody(name, cliPath), "utf8");
    report.created.push(path);
  }
}

export interface UninstallOptions {
  projectRoot: string;
  keepData: boolean;
  global?: boolean;
}

export interface UninstallReport {
  removed: string[];
  kept: string[];
  edited: string[];
  backups: string[];
  notes: string[];
}

export async function uninstall(opts: UninstallOptions): Promise<UninstallReport> {
  const report: UninstallReport = { removed: [], kept: [], edited: [], backups: [], notes: [] };
  const root = opts.projectRoot;

  // Global installs live in the SupraCode profile (see profile.ts). Stock
  // OpenCode leftovers from older installs are removed by migrateOutOfStock.
  const profileOpencode = profilePaths().opencodeConfig;
  const integrationRoot = opts.global ? dirname(dirname(profileOpencode)) : root;
  const pluginPath = opts.global
    ? join(profileOpencode, "plugins", "supracortex.ts")
    : join(root, PLUGIN_ENTRY_REL);
  const cmdDir = opts.global
    ? join(profileOpencode, "commands")
    : join(root, ".opencode", "commands");
  const runtimeDir = join(root, PROJECT_DIR);

  // Resolve every path before the first mutation. This makes uninstall
  // all-or-none for tampered/symlinked project integration paths and ensures a
  // forged agent manifest cannot be followed before the ordinary artifacts are
  // proven to live under their expected roots.
  await assertInstallerPathConfined(integrationRoot, pluginPath, "OpenCode plugin path");
  for (const name of COMMAND_NAMES) {
    await assertInstallerPathConfined(integrationRoot, join(cmdDir, `${name}.md`), "OpenCode command path");
  }
  const skillPath = opts.global
    ? join(profileOpencode, "skills", "supracortex", "SKILL.md")
    : join(root, SKILL_ENTRY_REL);
  await assertInstallerPathConfined(integrationRoot, skillPath, "OpenCode skill path");
  await assertInstallerPathConfined(root, runtimeDir, "SupraCortex runtime path");

  const adapters = await uninstallAgents(root);
  for (const c of adapters.changes) report.edited.push(c.file);
  report.backups.push(...adapters.backups);

  // Remove plugin loader (only if it is ours).
  if (await removeIfOwned(integrationRoot, pluginPath)) report.removed.push(pluginPath);
  if (await detectOpenCodeGeneration(root) === "v2") await uninstallV2Mcp(root, report);

  // Global install also wired ~/.codex/config.toml; remove our marked block.
  if (opts.global) {
    const codexFile = await unwireCodexGlobal(homedir());
    if (codexFile) report.edited.push(codexFile);

    // Global install may also have registered SupraCortex as a user-scope MCP
    // server in Claude Code (via `claude mcp add -s user` or the ~/.claude.json
    // fallback). Revert that too, so a global uninstall leaves no orphaned
    // registration behind.
    const claude = await connect("claude", { remove: true });
    if (claude.action === "disconnected") {
      if (claude.file) report.edited.push(claude.file);
      report.notes.push("Removed the SupraCortex user-scope server from Claude Code.");
    } else if (!claude.ok) {
      report.notes.push(`Claude Code user-scope cleanup skipped: ${claude.detail}`);
    }

    // Remove the dedicated supracode2 (OpenCode V2) config root this installer
    // created, preserving any user-modified content (see uninstallV2Root).
    await uninstallV2Root(report);
    // Older installs wrote into stock ~/.config/opencode; clean those too.
    const stock = await migrateOutOfStock({ brandTui: brandTuiPackageDir() });
    report.removed.push(...stock.removed);
    report.edited.push(...stock.edited);
    report.backups.push(...stock.backups);
    report.notes.push(...stock.notes);
  }

  // Remove slash commands we own.
  for (const name of COMMAND_NAMES) {
    const p = join(cmdDir, `${name}.md`);
    if (await removeIfOwned(integrationRoot, p)) report.removed.push(p);
  }
  if (await removeIfOwned(integrationRoot, skillPath)) report.removed.push(skillPath);

  // Runtime data.
  if (opts.keepData) {
    report.kept.push(runtimeDir);
    report.notes.push("Runtime memory/cache kept (--keep-data). Re-install to resume.");
  } else if (await exists(runtimeDir)) {
    await assertInstallerPathConfined(root, runtimeDir, "SupraCortex runtime path");
    await rm(runtimeDir, { recursive: true, force: true });
    report.removed.push(runtimeDir);
  }

  report.notes.push("Project source files were not modified.");
  return report;
}

async function removeIfOwned(root: string, path: string): Promise<boolean> {
  await assertInstallerPathConfined(root, path, "owned installer artifact");
  if (!(await exists(path))) return false;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return false;
  }
  if (!content.includes(OWNED_MARKER)) return false;
  await assertInstallerPathConfined(root, path, "owned installer artifact");
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Enable / disable (persist to project config)
// ---------------------------------------------------------------------------

export interface ToggleReport {
  configPath: string;
  enabled: boolean;
  restartRequired: boolean;
  notes: string[];
}

/**
 * Per-project kill switch — the one feature-like key a project file may hold.
 * Disabling writes `{ enabled: false }`; enabling removes that override (and
 * the file itself when nothing project-scoped remains), so the project follows
 * the central config again.
 */
export async function setEnabled(projectRoot: string, enabled: boolean): Promise<ToggleReport> {
  const cfgPath = projectConfigPath(projectRoot);
  const notes: string[] = [];
  const current = await readJsoncObject(cfgPath);
  if (enabled) {
    if (current) {
      const scoped = projectScopedConfig(current);
      const remaining = { ...(scoped.config as Record<string, unknown>) };
      delete remaining.enabled;
      if (Object.keys(remaining).length === 0) {
        await rm(cfgPath, { force: true });
        notes.push(`Removed ${cfgPath}; this project now follows the central config.`);
      } else {
        await editJsonc(cfgPath, [[["enabled"], undefined]], () => "{}\n");
      }
      if (scoped.ignored.length) notes.push(`Ignored project keys (config is central): ${scoped.ignored.join(", ")}. Run 'supracode config migrate --yes' to clean them up.`);
    }
    const store = new JsonlStore(join(projectRoot, PROJECT_DIR));
    await store.ensureDir("state");
    notes.push("Enabled. Start a new OpenCode session if the plugin was not already loaded.");
  } else {
    await editJsonc(cfgPath, [[["enabled"], false]], () => `// supracortex project override (${OWNED_MARKER})\n{}\n`);
    notes.push("Disabled for this project only. Functional hooks stop immediately; a new session fully unloads the module.");
  }
  return { configPath: cfgPath, enabled, restartRequired: true, notes };
}

/**
 * Code graph is a feature, so it is switched CENTRALLY (every project).
 */
export async function setCodeGraphEnabled(_projectRoot: string, enabled: boolean, automaticContext = true): Promise<ToggleReport> {
  const cfgPath = globalConfigPath();
  // Always write explicit booleans. Using `undefined` to mean "restore the
  // default" silently stopped working when the automatic-context default moved
  // to false, and deleting a missing path from an empty document also throws.
  await editJsonc(
    cfgPath,
    enabled
      ? [[["graph", "enabled"], true], [["graph", "automaticContext"], automaticContext]]
      : [[["graph", "enabled"], false], [["graph", "automaticContext"], false]],
    () => centralConfigText(),
  );
  // Drop an emptied `graph` object so the file stays minimal.
  const after = await readJsoncObject(cfgPath);
  if (after && after.graph && typeof after.graph === "object" && Object.keys(after.graph as object).length === 0) {
    await editJsonc(cfgPath, [[["graph"], undefined]], () => centralConfigText());
  }
  return {
    configPath: cfgPath,
    enabled,
    restartRequired: true,
    notes: [enabled ? "Code graph enabled everywhere (default). Run `supracode code-graph rebuild --yes` to build it now." : "Code graph disabled centrally; stored graph data was preserved."],
  };
}
// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Honest install state machine (spec 7b). Exact strings, no synonyms. */
export type InstallState = "ENABLED" | "INSTALLED-but-disabled" | "config-without-hook";

/** Display-only alias table (spec 7b). Canonical alias logic lives elsewhere;
 * this is the read surface status prints so operators see the mapping. */
export interface AliasEntry {
  alias: string;
  tool: string;
  purpose: string;
}

export const CORTEX_ALIAS_TABLE: AliasEntry[] = [
  { alias: "cortex-status", tool: "status", purpose: "show honest status" },
  { alias: "cortex-enable", tool: "enable", purpose: "persist enabled=true" },
  { alias: "cortex-disable", tool: "disable", purpose: "persist enabled=false" },
  { alias: "cortex-doctor", tool: "doctor", purpose: "run health checks" },
  { alias: "cortex-compact", tool: "compact", purpose: "compact memory" },
  { alias: "jev", tool: "jev", purpose: "Jev status / set OpenRouter key" },
  { alias: "cortex-inspect", tool: "inspect", purpose: "preview context without a model call" },
  { alias: "cortex-reset", tool: "reset", purpose: "reset generated data" },
];

/** Handshake budget: at/above this the round-trip is flagged slow, never hung.
 * Single-sourced from diagnostics (re-export; do not fork the value). */
export const HANDSHAKE_SLOW_MS = DIAG_HANDSHAKE_SLOW_MS;
/** Freshness age above this is reported STALE. Single-sourced from diagnostics. */
export const STALE_AFTER_HOURS = HEALTH_STALE_AFTER_HOURS;
/** --fix green budget: 120s on Windows, 60s on posix. */
export function doctorFixBudgetMs(platform: NodeJS.Platform = process.platform): number {
  return platform === "win32" ? 120_000 : 60_000;
}

export interface StatusReport {
  version: string;
  active: boolean;
  reason: string;
  source: string;
  /** Honest state machine: ENABLED | INSTALLED-but-disabled | config-without-hook. */
  state: InstallState;
  configPath: string;
  configExists: boolean;
  storagePath: string;
  /** Raw JSONL line counts per memory log (tail-limited; not deduped). */
  memoryCounts: Record<string, number>;
  /** Logical memory view: unique entries by id (last write wins) + status breakdown. */
  memoryEntries: { total: number; byStatus: Record<string, number> };
  cacheEntries: number;
  indexFreshness: string;
  activeTasks: number;
  storageBytes?: number;
  lastError: string | null;
  /** Unknown keys discovered in raw global/project config files. */
  configWarnings: string[];
  restartRequired: boolean;
  /** Last context injection observed (5b store); null when never. */
  lastInjectionAt: string | null;
  /** Last staleness sweep observed; null when never. */
  lastSweepAt: string | null;
  /** Whole hours since lastInjectionAt ?? lastSweepAt; null when never. */
  freshnessHours: number | null;
  /** True when freshnessHours exceeds STALE_AFTER_HOURS. */
  stale: boolean;
  /** Measured MCP handshake round-trip; null when not measured. */
  handshakeMs: number | null;
  /** True when the handshake met/exceeded the slow budget. */
  handshakeSlow: boolean;
  handshakeDetail: string;
  /** Why the last injection decision went the way it did; never "unknown". */
  shouldInjectReason: string;
  aliases: AliasEntry[];
}

async function safeLoadConfig(projectRoot: string) {
  // Same central-config rules as every runtime loader (config-loader.ts).
  return loadConfig({ projectRoot, env: process.env });
}
/** Closed injection-reason set (mirrors plugin gate; unknown is forbidden). */
const INJECTION_REASONS = new Set([
  "no-query",
  "empty-packet",
  "dedup",
  "disabled",
  "gate-below-threshold",
  "injected",
]);
/** Memory lifecycle statuses counted by status(); mirrors core MemoryStatus. */
const MEMORY_STATUSES = new Set(["active", "candidate", "stale", "disputed", "superseded", "forgotten"]);
/** Recognized memory kinds; mirrors core MemoryKind for the logical count. */
const MEMORY_KINDS = new Set(["fact", "decision", "convention", "failure", "constraint", "task-outcome"]);

/** Validate + sanitize a persisted injection reason. Unknown/ANSI/newline
 * input fails closed to gate-below-threshold; control chars become `_`,
 * truncated to 80 chars so status never prints raw escapes. */
export function sanitizeInjectionReason(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "gate-below-threshold";
  const cleaned = raw.replace(/[\r\n\x1b]/g, "_").slice(0, 80);
  return INJECTION_REASONS.has(cleaned) ? cleaned : "gate-below-threshold";
}

/**
 * Every path a SupraCortex plugin loader may occupy, in precedence order:
 * project-local entry, the active SupraCode profile (the real global config
 * under SupraCode), and stock OpenCode.
 *
 * Stock is only considered when the SupraCode profile config dir does not
 * exist (i.e. we are not running under SupraCode): a stale stock loader must
 * never make the active profile look installed. There is deliberately no
 * `~/.config/opencode` fallback — `profilePaths` already derives the real
 * stock location from the environment, which keeps tests hermetic. Exact
 * duplicates are dropped.
 *
 * `env` is threaded through `profilePaths` so `SUPRACODE_HOME`,
 * `XDG_CONFIG_HOME` and `SUPRACODE_REAL_XDG_CONFIG_HOME` all resolve the same
 * way the launcher does.
 */
export function pluginLoaderCandidates(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = profilePaths(env);
  const candidates = [join(projectRoot, PLUGIN_ENTRY_REL)];
  // The profile config is always a candidate — when it coincides with stock
  // (SUPRACODE_HOME and XDG config resolve to the same dir) it is included once.
  candidates.push(join(paths.opencodeConfig, "plugins", "supracortex.ts"));
  if (paths.opencodeConfig !== paths.stockConfig && !existsSync(paths.opencodeConfig)) {
    candidates.push(join(paths.stockConfig, "plugins", "supracortex.ts"));
  }
  return [...new Set(candidates)];
}

/** Await existence across the precedence-aware loader candidates. */
export async function hasPluginLoader(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  for (const candidate of pluginLoaderCandidates(projectRoot, env)) {
    if (await exists(candidate)) return true;
  }
  return false;
}

export async function status(projectRoot: string, opts: { measureHandshake?: boolean; checkHandshake?: boolean } = {}): Promise<StatusReport> {
  const loaded = await safeLoadConfig(projectRoot);
  const storagePath = resolveProjectStorageDirectory(projectRoot, loaded.config.storage.directory);
  const memoryCounts: Record<string, number> = {};
  // Logical view over the same logs: raw line counts can double-count rewritten
  // entries, so status also reports deduped memory (last write wins, like
  // MemoryRepository.loadAll). Reset to zero on any storage read failure.
  const memoryEntries: StatusReport["memoryEntries"] = { total: 0, byStatus: {} };
  let cacheEntries = 0;
  let activeTasks = 0;
  let indexFreshness = "not built";
  let lastError: string | null = loaded.loadError ?? null;
  let storageBytes: number | undefined;
  // Injection/sweep observations persisted by the gate (5b store). Missing
  // fields display as "never"; the reason defaults to gate-below-threshold,
  // never "unknown".
  let lastInjectionAt: string | null = null;
  let lastSweepAt: string | null = null;
  let shouldInjectReason = "gate-below-threshold";

  // \`status()\` and \`doctor()\` never create or migrate storage. Probe first:
  // opening a store is only safe when the backend already holds data.
  // Under SQLite the logs/keys live inside state/store.sqlite, not on disk. A
  // failed open must never abort status (read-only diagnostics): fall back to
  // direct filesystem reads.
  //
  // Trust boundary first: a symlinked storage root must never be opened,
  // purged, or written through. On failure keep the error and skip every
  // storage read (the filesystem fallback is project-confined, but the
  // configured root itself is outside and must not be touched).
  const containmentError = await assertStorageContained(projectRoot, storagePath);
  if (containmentError) {
    lastError = lastError ? `${lastError}; ${containmentError}` : containmentError;
  }

  let store: Awaited<ReturnType<typeof createReadOnlyStore>> | null = null;
  if (!containmentError) {
    // Hosts that never load the plugin still purge a prompt-bearing legacy
    // mirror. Best-effort: a read-only status must not fail because of it.
    await sanitizeLegacyInjectionMirror(join(storagePath, "state")).catch(() => undefined);
    try {
      // Read-only: returns null when storage is absent and opens SQLite without
      // mkdir/DDL, so status never creates a root, database or schema.
      store = await createReadOnlyStore(loaded.config, projectRoot);
    } catch (err) {
      lastError ??= (err as Error).message;
    }
  }

  try {
    // Containment failure: do not read the configured (outside-project) root.
    if (containmentError) throw new Error(containmentError);
    const readJsonl = async <T>(rel: string): Promise<{ entries: T[]; corruptLines: number }> => {
      if (store) return store.readJsonlTail<T>(rel, 2000);
      const res = await readJsonlTail(join(storagePath, rel), 2000, projectRoot);
      if (res.error) throw new Error(res.error);
      return {
        entries: res.records.filter(r => r.valid).map(r => r.value as T),
        corruptLines: res.corrupt,
      };
    };

    const files = [
      "memory/durable.jsonl",
      "memory/decisions.jsonl",
      "memory/conventions.jsonl",
      "memory/failures.jsonl",
      // Persisted outcome memories live with memory. `tasks/completed.jsonl` is
      // owned by the task subsystem and is deliberately not a MemoryEntry log.
      "memory/outcomes.jsonl",
    ];
    for (const f of files) {
      try {
        const res = await readJsonl(f);
        if (res.corruptLines > 0) lastError ??= `storage corrupt (${f}): ${res.corruptLines} corrupt lines`;
        memoryCounts[f] = res.entries.length;
      } catch (err) {
        lastError ??= `storage read failed (${f}): ${(err as Error).message}`;
        memoryCounts[f] = 0;
      }
    }

    // Logical memory view through the adapter (never the raw filesystem): read
    // every row of every log MemoryRepository.loadAll reads and dedupe by id,
    // last append wins. Task-subsystem records are not MemoryEntry rows and are
    // excluded here (and from MemoryRepository) by ownership boundary.
    // Entries with an unrecognized/missing kind or status are skipped, matching
    // the repository's validity gate for the fields status reports on. A
    // failure leaves the zeroed defaults above.
    if (store) {
      try {
        const logical = new Map<string, { status: string }>();
        for (const f of files) {
          const res = await store.readHistory<{ id?: unknown; kind?: unknown; status?: unknown }>(f);
          for (const e of res.entries) {
            if (typeof e?.id !== "string" || !e.id) continue;
            if (typeof e.kind !== "string" || !MEMORY_KINDS.has(e.kind)) continue;
            if (typeof e.status !== "string" || !MEMORY_STATUSES.has(e.status)) continue;
            logical.set(e.id, { status: e.status });
          }
        }
        const counts = new Map<string, number>();
        for (const e of logical.values()) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        memoryEntries.total = logical.size;
        memoryEntries.byStatus = Object.fromEntries(sorted);
      } catch {
        memoryEntries.total = 0;
        memoryEntries.byStatus = {};
      }
    }
    const cacheRel = "cache/summaries.jsonl";
    try {
      const cache = await readJsonl(cacheRel);
      if (cache.corruptLines > 0) lastError ??= `storage corrupt (${cacheRel}): ${cache.corruptLines} corrupt lines`;
      cacheEntries = cache.entries.length;
    } catch (err) {
      lastError ??= `storage read failed (${cacheRel}): ${(err as Error).message}`;
    }

    // Each JSON document is read independently: a missing tasks/active.json
    // must not hide health/gate observations. ENOENT is silence; corrupt JSON
    // is a real storage fault and must surface as lastError.
    const readJsonLenient = async <T>(rel: string): Promise<T | null> => {
      try {
        return JSON.parse(await safeReadFile(projectRoot, join(storagePath, rel))) as T;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        lastError ??= e instanceof SyntaxError ? `storage corrupt (${rel})` : (e as Error).message;
        return null;
      }
    };
    const readJson = async <T>(rel: string): Promise<T | null> => {
      if (!store) return readJsonLenient<T>(rel);
      try {
        const value = await store.readJson<T>(rel);
        // JSONL/SQLite adapters return null for both missing and corrupt
        // documents. exists() distinguishes the two: a present document that
        // failed to parse is corruption, not silence.
        if (value === null && await store.exists(rel).catch(() => false)) {
          lastError ??= `storage corrupt (${rel})`;
        }
        return value;
      } catch (err) {
        lastError ??= (err as Error).message;
        return null;
      }
    };

    const active = await readJson<{ tasks?: unknown[]; taskIds?: unknown[] }>("tasks/active.json");
    activeTasks = active?.tasks?.length ?? active?.taskIds?.length ?? 0;
    const index = await readJson<{ generatedAt: string }>("index/repository.json");
    if (index?.generatedAt) indexFreshness = index.generatedAt;
    const health = await readJson<{ lastError?: { message: string } | null; lastSweepAt?: string | null; lastInjectionAt?: string | null }>("state/health.json");
    if (health?.lastError?.message) lastError ??= health.lastError.message;
    if (typeof health?.lastSweepAt === "string") lastSweepAt = health.lastSweepAt;
    if (typeof health?.lastInjectionAt === "string") lastInjectionAt = health.lastInjectionAt;
    // Injection decision fields persisted by the gate (5b store). Read-only
    // here: never reimplement the gate, only surface what it recorded.
    // Exception: injection.json/gate.json stay filesystem reads because the
    // OpenCode plugin writes that mirror directly with fs (plugin-owned
    // observability), bypassing the storage adapter.
    for (const candidate of ["state/injection.json", "state/gate.json"]) {
      const gate = await readJsonLenient<{ lastInjectionAt?: string | null; lastSkipReason?: string | null; skipReason?: string | null; reason?: string | null }>(candidate);
      if (typeof gate?.lastInjectionAt === "string") lastInjectionAt ??= gate.lastInjectionAt;
      const r = gate?.lastSkipReason ?? gate?.skipReason ?? gate?.reason;
      if (typeof r === "string" && r) shouldInjectReason = sanitizeInjectionReason(r);
    }
  } catch (err) {
    lastError ??= (err as Error).message;
  } finally {
    if (store) {
      try { await store.close(); } catch { /* best-effort close */ }
    }
  }

  // Loader presence decides the honest state machine alongside the toggle.
  const loaderPresent = await hasPluginLoader(projectRoot);
  const enabled = loaded.config.enabled === true;
  const state: InstallState = enabled && loaderPresent
    ? "ENABLED"
    : loaderPresent && !enabled
      ? "INSTALLED-but-disabled"
      : "config-without-hook";

  const nowMs = Date.now();
  const freshest = lastInjectionAt ?? lastSweepAt;
  let freshnessHours: number | null = null;
  if (freshest) {
    const t = Date.parse(freshest);
    freshnessHours = Number.isNaN(t) ? null : Math.max(0, Math.floor((nowMs - t) / 3_600_000));
  }
  const stale = freshnessHours !== null && freshnessHours > STALE_AFTER_HOURS;

  // Handshake timing. OFF by default: status is a read-only fast path and
  // never spawns. Opt in via status({ checkHandshake: true }) (CLI:
  // `status --check-handshake`); `measureHandshake: true` is kept as a
  // legacy alias for the same opt-in. Doctor always measures separately.
  let handshakeMs: number | null = null;
  let handshakeSlow = false;
  let handshakeDetail = "not measured (handshake skipped; pass --check-handshake to measure)";
  const wantHandshake = opts.checkHandshake === true || opts.measureHandshake === true;
  if (wantHandshake && !containmentError && (await exists(storagePath))) {
    const cliPath = await resolveCliPath();
    let launcherOk = false;
    try { await access(cliPath, constants.R_OK); launcherOk = true; } catch { /* not readable */ }
    if (launcherOk) {
      const hs = await spawnMcpHandshake(cliPath, projectRoot);
      handshakeMs = hs.ms;
      handshakeSlow = hs.slow;
      handshakeDetail = hs.detail;
    } else {
      handshakeDetail = "not measured (launcher unavailable)";
    }
  }

  return {
    version: PLUGIN_VERSION,
    active: loaded.config.enabled,
    reason: loaded.reason,
    source: loaded.source,
    state,
    configPath: loaded.projectConfigPath,
    configExists: loaded.projectConfigExists,
    storagePath,
    memoryCounts,
    memoryEntries,
    cacheEntries,
    indexFreshness,
    activeTasks,
    storageBytes,
    lastError,
    configWarnings: loaded.configWarnings,
    restartRequired: false,
    lastInjectionAt,
    lastSweepAt,
    freshnessHours,
    stale,
    handshakeMs,
    handshakeSlow,
    handshakeDetail,
    shouldInjectReason,
    aliases: CORTEX_ALIAS_TABLE,
  };
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function modernDoctor(projectRoot: string) {
  const loaded = await safeLoadConfig(projectRoot);
  const { runDiagnostics, sanitizeDiagnostics } = await import("@local/supracortex-core");
  const checks = await runDiagnostics({ projectRoot, config: loaded.config, configSource: loaded.projectConfigExists ? projectConfigPath(projectRoot) : undefined });
  if (loaded.loadError) checks.push({ id: "config-load", title: "Configuration load", status: "fail", evidence: "unknown", detail: loaded.loadError });
  return sanitizeDiagnostics(checks, projectRoot);
}

export async function doctor(projectRoot: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let storageDirectory = PROJECT_DIR;
  let loadedConfig: Config | null = null;

  // Node version.
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeSupported = (major ?? 0) > 22 || (major === 22 && (minor ?? 0) >= 6);
  push("node >= 22.6", nodeSupported, `node ${process.versions.node}`);

  // Config load + schema.
  try {
    const loaded = await safeLoadConfig(projectRoot);
    const v = validateConfig(loaded.config);
    push("config valid", v.valid, v.valid ? "ok" : v.errors.join("; "));
    push(
      "config keys",
      loaded.configWarnings.length === 0,
      loaded.configWarnings.length === 0 ? "no unknown keys" : loaded.configWarnings.join("; "),
    );
    // Settings are central. Stale feature keys in a project file are ignored
    // (so they cannot silently switch a feature off), but surface them so the
    // user is never misled by what the file appears to say.
    push(
      "central config",
      loaded.ignoredProjectKeys.length === 0,
      loaded.ignoredProjectKeys.length === 0
        ? `settings from ${loaded.globalConfigPath}${loaded.projectConfigExists ? " (project file holds only project-scoped keys)" : ""}`
        : `${loaded.ignoredProjectKeys.length} stale key(s) in ${loaded.projectConfigPath} are IGNORED (settings are central in ${loaded.globalConfigPath}): ` +
            `${loaded.ignoredProjectKeys.slice(0, 8).join(", ")}${loaded.ignoredProjectKeys.length > 8 ? ", …" : ""}. Clean up: supracode config migrate --yes`,
    );
    // Validate raw user config so deprecated/renamed/removed warnings only fire
    // for keys the user explicitly set, never for defaults.
    const rawProject = loaded.projectConfigExists ? JSON.parse(stripJsonc(await safeReadFile(projectRoot, projectConfigPath(projectRoot)))) : null;
    const rawGlobal = await readConfigFile(globalConfigPath());
    const rawUserConfig = { ...(rawGlobal ?? {}), ...(rawProject ?? {}) };
    const rawV = validateConfig(rawUserConfig);
    push(
      "config deprecations",
      true,
      rawV.warnings.length === 0 ? "none" : rawV.warnings.join("; "),
    );
    push("enabled state", true, `${loaded.config.enabled} (${loaded.reason})`);
    storageDirectory = loaded.config.storage.directory;
    loadedConfig = loaded.config;
    // Decision provider: which one, and whether its credential resolves
    // (env, then ~/.config/supracortex/*.env, then system files). No network.
    {
      const jev = loaded.config.jev;
      const provider = resolveDecisionProvider(jev);
      const cred = provider.apiKeyEnv ? resolveCredential(provider.apiKeyEnv, { credentialsFile: jev.credentialsFile }) : null;
      // A missing key is a supported mode (deterministic fallback), not a
      // failure. With a key, doctor makes ONE real health request so the
      // reported state is what sessions will actually get.
      const hasCred = !provider.requireAuth || !!cred;
      let detail: string;
      let ok = true;
      if (!jev.enabled) detail = "disabled -> deterministic context";
      else if (!hasCred) detail = `no key (${provider.apiKeyEnv}) -> deterministic context; set it to enable ${provider.id}`;
      else {
        const check = await providerCheckFn(projectRoot, 8_000).catch((e: Error) => ({ ok: false as const, reason: e.message, latencyMs: 0 }));
        ok = check.ok;
        detail = check.ok
          ? `ACTIVE ${provider.id} ${provider.model} (health ${check.latencyMs}ms; key from ${cred ? (cred.source === "env" ? "environment" : cred.source) : "n/a"}; budget ${effectiveDecisionTiming(jev).enrichmentBudgetMs}ms)`
          : `UNREACHABLE ${provider.id} (${"reason" in check ? check.reason : "unknown"}; key from ${cred ? (cred.source === "env" ? "environment" : cred.source) : "n/a"}) -> sessions fall back to deterministic context and re-check every 5 min. Fix: supracode jev key <KEY>`;
      }
      push("decision provider", ok, detail);
    }
    if (loaded.loadError) push("config parse", false, loaded.loadError);
  } catch (err) {
    push("config load", false, (err as Error).message);
  }

  // Plugin entry present (project-local OR the active profile/stock loader).
  const loaderCandidates = pluginLoaderCandidates(projectRoot);
  const projPlugin = loaderCandidates[0]!;
  const hasProj = await exists(projPlugin);
  let globalPlugin: string | null = null;
  if (!hasProj) {
    for (const candidate of loaderCandidates.slice(1)) {
      if (await exists(candidate)) {
        globalPlugin = candidate;
        break;
      }
    }
  }
  push(
    "plugin entry",
    await hasPluginLoader(projectRoot),
    hasProj ? projPlugin : globalPlugin ? `${globalPlugin} (global)` : `${projPlugin} (missing)`,
  );

  // Storage dir + permissions.
  // Invariant: `doctor` (like `status`) never creates or migrates storage.
  // When the configured backend already holds data, read logical documents
  // through createReadOnlyStore so SQLite-backed state is authoritative
  // instead of reporting missing JSONL files.
  let storagePath: string;
  let store: Awaited<ReturnType<typeof createReadOnlyStore>> | null = null;
  let storageDriver = "jsonl";
  let sqliteUnopened = false;
  let storageContained = true;
  /** Normalize the tail shape across the filesystem and adapter readers. */
  const readTail = async (rel: string): Promise<{ count: number; corrupt: number; error?: string }> => {
    if (store) {
      const res = await store.readJsonlTail<unknown>(rel, 2000);
      return { count: res.entries.length, corrupt: res.corruptLines };
    }
    const res = await readJsonlTail(join(storagePath, rel), 2000, projectRoot);
    return {
      count: res.records.filter(r => r.valid).length,
      corrupt: res.corrupt,
      ...(res.error ? { error: res.error } : {}),
    };
  };
  try {
    try {
      storagePath = resolveProjectStorageDirectory(projectRoot, storageDirectory);
      // Trust boundary BEFORE any purge or store open: a symlinked storage
      // root must never be mutated (no unlink outside the project).
      const containmentError = await assertStorageContained(projectRoot, storagePath);
      if (containmentError) {
        storageContained = false;
        push("storage writable", false, containmentError);
        storagePath = "";
      } else {
        // Legacy prompt-bearing mirrors are purged even when the host never
        // loads the plugin. Best-effort and read-only-by-default.
        await sanitizeLegacyInjectionMirror(join(storagePath, "state")).catch(() => undefined);
        const config = loadedConfig ?? (await safeLoadConfig(projectRoot)).config;
        storageDriver = config.storage.driver;
        try {
          // Read-only: null when storage is absent; SQLite opens without
          // mkdir/DDL so doctor never creates a store it is inspecting.
          store = await createReadOnlyStore(config, projectRoot);
        } catch (err) {
          if (storageDriver === "sqlite") {
            // Do not create a store just to diagnose it. Report an explicit
            // skip instead of a false "missing JSONL" failure.
            sqliteUnopened = true;
            push("storage writable", true, `skip: sqlite: not opened read-only (${(err as Error).message})`);
          } else {
            throw err;
          }
        }
      }
      if (!sqliteUnopened && storagePath) {
        const events = await readTail("events/events.jsonl");
        const usage = await readTail("metrics/provider-usage.jsonl");
        const readError = events.error ?? usage.error;
        const corrupt = events.corrupt + usage.corrupt;
        const backend = store ? ` (${storageDriver}-backed)` : "";
        push(
          "storage writable",
          !readError && corrupt === 0,
          readError
            ? `read failed: ${readError}`
            : corrupt
              ? `${corrupt} corrupt lines`
              : events.count > 0 || usage.count > 0
                ? `observed writes${backend}`
                : `not observed yet (read-only check${backend})`,
        );
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      push("storage writable", e.code === "ENOENT", e.code === "ENOENT" ? "not observed yet (read-only check)" : (err as Error).message);
      storagePath = "";
      if (e.code !== "ENOENT") storageContained = false;
    }

    // Corrupt JSONL scan (logical logs, so SQLite rows count too).
    try {
      if (sqliteUnopened) {
        push("jsonl integrity", true, "skip: sqlite: not opened read-only");
      } else {
        if (!storagePath) throw new Error("storage path is unsafe or unavailable");
        let corrupt = 0;
        const readErrors: string[] = [];
        for (const f of [
          "memory/durable.jsonl",
          "memory/decisions.jsonl",
          "memory/conventions.jsonl",
          "memory/failures.jsonl",
          "memory/outcomes.jsonl",
          "cache/summaries.jsonl",
        ]) {
          const res = await readTail(f);
          if (res.error) readErrors.push(`read failed (${f}): ${res.error}`);
          corrupt += res.corrupt;
        }
        push(
          "jsonl integrity",
          readErrors.length === 0 && corrupt === 0,
          readErrors.length || corrupt
            ? [...readErrors, corrupt ? `${corrupt} corrupt lines` : ""].filter(Boolean).join("; ")
            : store
              ? `no corrupt lines (${storageDriver}-backed)`
              : "no corrupt lines",
        );
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      push("jsonl integrity", e.code === "ENOENT", e.code === "ENOENT" ? "no memory files yet" : (err as Error).message);
    }
  } finally {
    if (store) {
      try { await store.close(); } catch { /* best-effort close */ }
    }
  }

  // Stale locks.
  if (!storagePath) {
    push("stale locks", false, "unknown: storage path is unsafe or unavailable");
  } else {
    try {
      const lockDir = join(storagePath, "state");
      const items = (await readdir(lockDir).catch(() => [])) as string[];
      const locks = items.filter((i) => i.endsWith(".lock"));
      push("stale locks", locks.length === 0, locks.length ? `unknown: ${locks.length} lock file(s) present; staleness cannot be validated without mutation` : "unknown: no lock validation predicate available");
    } catch {
      push("stale locks", false, "unknown: lock state cannot be validated without mutation");
    }
  }

  // -----------------------------------------------------------------------
  // Phase 11.4: Host integration checks
  // -----------------------------------------------------------------------

  // 1. Host binary detected (informational: always ok=true).
  let hostBinaryDetail = "not found on PATH";
  const hostPaths = [
    { name: "opencode", PATH: ["opencode"] },
    { name: "claude", PATH: ["claude", "claude-code"] },
    { name: "codex", PATH: ["codex"] },
  ];
  for (const host of hostPaths) {
    for (const bin of host.PATH) {
      try {
        await access(bin, constants.X_OK);
        hostBinaryDetail = `${host.name} detected on PATH`;
        break;
      } catch { /* not found via this path */ }
    }
    if (hostBinaryDetail !== "not found on PATH") break;
  }
  push("host binary detected", true, hostBinaryDetail);

  // 2. Host config detect (informational: always ok=true).
  try {
    const agents = await detectAgents(projectRoot);
    const detected = agents.filter((a) => a.detected);
    push(
      "host config detect",
      true,
      detected.length > 0
        ? detected.map((a) => `${a.agent}${a.experimental ? " (experimental)" : ""}`).join(", ")
        : "no supported host agent configs found (install creates them)",
    );
  } catch (err) {
    push("host config detect", true, `detection error: ${(err as Error).message}`);
  }

  // 3. Launcher exists (CLI entry).
  const cliPath = await resolveCliPath();
  let launcherOk = false;
  try {
    await access(cliPath, constants.R_OK);
    launcherOk = true;
  } catch {
    // Not accessible.
  }
  push("launcher exists", launcherOk, launcherOk ? cliPath : `${cliPath} (not found or not readable)`);

  // 4. Measured MCP handshake (spec 7b). Bounded by the 15s budget with
  // still-booting retry; slow round-trips fail the check as "slow" rather
  // than hanging. Timing is always displayed.
  if (launcherOk && storageContained) {
    const hs = await spawnMcpHandshake(cliPath, projectRoot);
    const slowFlag = hs.slow ? " (slow, budget 15s)" : "";
    const timed = hs.ms === null ? hs.detail : `${hs.detail}${hs.ok ? "" : slowFlag}`;
    // ok=false when refused/failed; ok-but-slow is flagged slow (fail) so the
    // SLO is honest. Heavy init is deferred on budget exhaustion (MISSING-slow).
    push("MCP handshake", hs.ok && !hs.slow, timed);
  } else if (!storageContained) {
    // Even the write-free handshake resolves the storage root; skip it when
    // that root is outside the project.
    push("MCP handshake", false, "storage path is unsafe; skipping MCP handshake [MISSING]");
  } else {
    push("MCP handshake", false, "launcher not available; skipping MCP handshake [MISSING-slow]");
  }

  // 5. Read-only tools / storage health. Never initialize Engine from diagnostics.
  try {
    const loaded = await safeLoadConfig(projectRoot);
    push("engine operational", true, loaded.config.enabled ? "configured (not initialized by read-only doctor)" : "disabled by config");

    // No runtime registry is available to this read-only doctor; do not fabricate tools.
    push("tools registry", true, "unknown: runtime tool registry is not available to the read-only doctor");

    push("storage healthy", true, "unknown: runtime storage health cannot be verified safely");
  } catch (err) {
    push("tools registry", false, (err as Error).message);
    push("engine operational", false, (err as Error).message);
    push("storage healthy", false, (err as Error).message);
  }

  // Env overrides.
  const disable = process.env.SUPRACORTEX_DISABLE;
  push("env overrides", true, disable ? `SUPRACORTEX_DISABLE=${disable}` : "none");

  // -----------------------------------------------------------------------
  // Spec 7b: per-client matrix + smoke context
  // -----------------------------------------------------------------------

  // Per-client [OK]/[MISSING]: owned wiring present for each known host.
  // Informational (ok=true): wiring for hosts the project does not use is
  // not a failure; the token in the detail is the signal.
  for (const entry of perClientWiring(projectRoot)) {
    let wired = false;
    let detail = "client not detected";
    try {
      const raw = await readFile(entry.file, "utf8");
      wired = raw.includes("supracortex");
      detail = wired ? `[OK] owned wiring in ${entry.file}` : `[MISSING] no owned wiring in ${entry.file}`;
    } catch (e) {
      detail = (e as NodeJS.ErrnoException).code === "ENOENT"
        ? `[MISSING] ${entry.file} not present`
        : `[MISSING] unreadable ${entry.file}`;
    }
    push(`client ${entry.client}`, true, detail);
  }

  // Smoke: report whether context would be non-empty (memory, cache, or
  // index evidence). Informational: an empty store on a fresh install is
  // expected, not a failure.
  try {
    const s = await status(projectRoot);
    const nonEmpty = Object.values(s.memoryCounts).some((n) => n > 0) ||
      s.cacheEntries > 0 ||
      s.indexFreshness !== "not built";
    push(
      "smoke context non-empty",
      true,
      nonEmpty
        ? `non-empty (memory ${JSON.stringify(s.memoryCounts)}, cache ${s.cacheEntries}, index ${s.indexFreshness})`
        : "empty (no memory, cache, or index evidence yet)",
    );
  } catch (err) {
    push("smoke context non-empty", false, `smoke failed: ${(err as Error).message}`);
  }

  // Stock OpenCode must not carry SupraCortex; SupraCode has its own profile.
  try {
    const leftovers = await stockPollution();
    push(
      "stock opencode untouched",
      leftovers.length === 0,
      leftovers.length === 0 ? "no SupraCortex artifacts in stock ~/.config/opencode" : `found ${leftovers.join(", ")} — run 'supracode migrate --yes'`,
    );
    const profileLoader = join(profilePaths().opencodeConfig, "plugins", "supracortex.ts");
    push("supracode profile", existsSync(profileLoader), existsSync(profileLoader) ? profilePaths().opencodeConfig : "not created yet — run 'supracode profile init' (or just launch supracode)");
  } catch (err) {
    push("stock opencode untouched", false, (err as Error).message);
  }
  return checks;
}

/** Host config files that carry owned SupraCortex wiring, per client.
 * Read-only here: doctor reports [OK]/[MISSING]; --fix repairs opencode. */
export function perClientWiring(projectRoot: string): Array<{ client: string; file: string }> {
  return [
    { client: "opencode", file: join(projectRoot, PLUGIN_ENTRY_REL) },
    { client: "claude", file: join(projectRoot, ".mcp.json") },
    { client: "codex", file: join(projectRoot, ".codex", "config.toml") },
    { client: "cursor", file: join(projectRoot, ".cursor", "mcp.json") },
    { client: "gemini", file: join(projectRoot, ".gemini", "settings.json") },
    { client: "pi", file: join(projectRoot, ".pi", "mcp.json") },
  ];
}

// ---------------------------------------------------------------------------
// Doctor --fix (spec 7b): repair the loader to relative npx, never file://
// ---------------------------------------------------------------------------

export interface DoctorFixReport {
  fixed: string[];
  skipped: string[];
  backups: string[];
  notes: string[];
  durationMs: number;
  budgetMs: number;
  /** True when the fix completed within budget (120s Win / 60s posix). */
  green: boolean;
}

/** Relative npx loader: a bare specifier resolved via the installed package,
 * never an absolute file:// URL, so it survives directory moves and works on
 * Windows (no drive-letter URLs, no quoting hazards). */
export function relativeNpxLoader(generation: OpenCodeGeneration): string {
  const adapter = generation === "v2"
    ? `export { default } from "supracortex/opencode-v2";`
    : `export { SupraCortex } from "supracortex/opencode";`;
  return `// ${OWNED_MARKER}
// Thin project-local loader for supracortex.
// Relative npx resolution through the published supracortex package: never an
// absolute file URL, so this survives directory moves and Windows paths
// with spaces. Safe to delete to remove the plugin from this project; run
// \`supracortex uninstall\` for a clean removal that also reverts config edits.
${adapter}
`;
}

/** Platform-aware MCP server spec with relative npx resolution. Windows goes
 * through the `cmd /c` shim with a 120s timeout; posix uses npx directly with
 * 60s. Command is argv (no shell), so paths with spaces need no quoting. */
export function npxMcpServerSpec(root: string, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  const base = {
    type: "local",
    cwd: root,
    environment: { SUPRACORTEX_ROOT: root },
  };
  if (platform === "win32") {
    return { ...base, command: ["cmd", "/c", "npx", "supracortex", "mcp"], timeout: 120_000 };
  }
  return { ...base, command: ["npx", "supracortex", "mcp"], timeout: 60_000 };
}

export function isAbsoluteServerSpec(spec: unknown): boolean {
  const text = JSON.stringify(spec ?? "");
  if (text.includes("file://") || text.includes("scripts/cli.ts") || text.includes("dist/cli.js") || text.includes("scripts/dist")) return true;
  const leaves: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") leaves.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(spec);
  return leaves.some((s) => /^[A-Za-z]:[\\/]/.test(s) || /file:\/\//.test(s));
}

export async function doctorFix(
  projectRoot: string,
  opts: { global?: boolean; platform?: NodeJS.Platform } = {},
): Promise<DoctorFixReport> {
  const started = Date.now();
  const platform = opts.platform ?? process.platform;
  const budgetMs = doctorFixBudgetMs(platform);
  const report: DoctorFixReport = { fixed: [], skipped: [], backups: [], notes: [], durationMs: 0, budgetMs, green: true };
  const generation = await detectOpenCodeGeneration(projectRoot);

  // 1. Plugin loader -> relative npx, never file://.
  const loaderPath = opts.global
    ? join(homedir(), ".config", "opencode", "plugins", "supracortex.ts")
    : join(projectRoot, PLUGIN_ENTRY_REL);
  const desired = relativeNpxLoader(generation);
  if (desired.includes("file://")) throw new Error("refusing to write absolute file:// loader");
  const current = await readFile(loaderPath, "utf8").catch(() => null);
  if (current === null) {
    await mkdir(dirname(loaderPath), { recursive: true });
    await writeFile(loaderPath, desired, "utf8");
    report.fixed.push(loaderPath);
  } else if (current === desired) {
    report.skipped.push(loaderPath);
  } else if (!current.includes(OWNED_MARKER)) {
    report.skipped.push(loaderPath);
    report.notes.push(`preserved user-owned ${loaderPath}`);
  } else {
    const bak = await backup(loaderPath);
    if (bak) report.backups.push(bak);
    await writeFile(loaderPath, desired, "utf8");
    report.fixed.push(loaderPath);
    if (current.includes("file://")) report.notes.push(`removed absolute file:// loader at ${loaderPath}`);
  }

  // 2. V2 MCP server entry -> relative npx spec (platform-aware).
  const scopeRoot = opts.global ? join(homedir(), ".config", "opencode") : projectRoot;
  if (generation === "v2" || opts.global) {
    const candidates = [join(scopeRoot, "opencode.jsonc"), join(scopeRoot, "opencode.json")];
    const file = candidates.find((c) => existsSync(c)) ?? null;
    if (file) {
      const old = await readFile(file, "utf8");
      const parsed = parse(old, [], { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown> | undefined;
      const server = (parsed?.mcp as Record<string, unknown> | undefined)?.servers as Record<string, unknown> | undefined;
      const want = npxMcpServerSpec(scopeRoot, platform);
      if (server?.supracortex === undefined) {
        const bak = await backup(file);
        if (bak) report.backups.push(bak);
        await writeFile(file, applyEdits(old, modify(old, ["mcp", "servers", "supracortex"], want, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        })), "utf8");
        report.fixed.push(file);
      } else if (JSON.stringify(server.supracortex) !== JSON.stringify(want) && isAbsoluteServerSpec(server.supracortex)) {
        const bak = await backup(file);
        if (bak) report.backups.push(bak);
        await writeFile(file, applyEdits(old, modify(old, ["mcp", "servers", "supracortex"], want, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        })), "utf8");
        report.fixed.push(file);
        report.notes.push(`replaced absolute MCP server command in ${file} with relative npx`);
      } else {
        report.skipped.push(file);
      }
    } else {
      report.notes.push("no opencode.json(c) found; MCP server entry not created (run install to create it)");
    }
  }

  if (platform === "win32") {
    report.notes.push("Windows: MCP launches via the cmd /c shim with a 120s timeout; cwd is argv (spaces need no quoting).");
  }
  report.durationMs = Date.now() - started;
  report.green = report.durationMs <= budgetMs;
  return report;
}

/**
 * Bounded MCP handshake with timing (spec 7b).
 *
 * Era is pinned at connect (legacy `initialize`, protocol 2024-11-05): no
 * fallback to other eras. A `-32001` (still-booting) error retries with
 * backoff and a raised per-attempt timeout. The total budget is 15s (ZCode
 * parity): on expiry heavy init is deferred and the result is marked slow
 * (MISSING-slow downstream), never hung. Never leaks env values.
 */
export interface HandshakeResult {
  ok: boolean;
  /** Round-trip ms for the decisive attempt; null when nothing answered. */
  ms: number | null;
  /** True when the round-trip met/exceeded the slow budget or timed out. */
  slow: boolean;
  detail: string;
  /** JSON-RPC error code when the handshake was refused, if any. */
  code?: number;
}

/** Pinned handshake era: legacy initialize, no fallback. Single-sourced. */
export const HANDSHAKE_PROTOCOL_VERSION = DIAG_HANDSHAKE_PROTOCOL_VERSION;
export const STILL_BOOTING_CODE = DIAG_STILL_BOOTING_CODE;
/** Hard single-attempt budget alias (ZCode parity). */
export const HANDSHAKE_BUDGET_MS = DIAG_HANDSHAKE_BUDGET_MS;

function handshakeRequest(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: HANDSHAKE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "supracortex-doctor", version: "0.1.0" },
    },
  }) + "\n";
}

async function singleHandshakeAttempt(
  cliPath: string,
  projectRoot: string,
  id: number,
  attemptTimeoutMs: number,
): Promise<HandshakeResult> {
  const started = Date.now();
  const label = (detail: string): string => `handshake-only (engine init excluded): ${detail}`;
  return new Promise((resolve) => {
    const child = spawn(nodeMcpExecutable(), [cliPath, "mcp", "--handshake-only"], {
      env: {
        ...process.env,
        SUPRACORTEX_ROOT: projectRoot,
        SUPRACORTEX_HANDSHAKE_ONLY: "1",
        // Never probe the decision provider from a diagnostic handshake.
        SUPRACORTEX_NO_DECISION_WARMUP: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (r: HandshakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve({ ...r, detail: label(r.detail) });
    };
    const timeout = setTimeout(() => {
      finish({ ok: false, ms: Date.now() - started, slow: true, detail: `MCP handshake timed out (${Math.round(attemptTimeoutMs / 1000)}s); deferring heavy init` });
    }, attemptTimeoutMs);

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const output = Buffer.concat(chunks).toString("utf8");
      const line = output.split("\n").find((l) => l.includes("jsonrpc") || (l.trim().startsWith("{") && l.includes("}")));
      if (line === undefined && output.length <= 100) return;
      const ms = Date.now() - started;
      try {
        const msg = JSON.parse(line ?? output) as { error?: { code?: number; message?: string } };
        if (msg?.error && typeof msg.error.code === "number") {
          finish({ ok: false, ms, slow: ms >= HANDSHAKE_SLOW_MS, detail: `MCP handshake refused: ${msg.error.code} ${msg.error.message ?? ""}`.trim(), code: msg.error.code });
          return;
        }
      } catch { /* non-JSON chatter: treat any JSON-RPC-shaped output as alive */ }
      if (output.includes("jsonrpc") || output.includes("{")) {
        finish({ ok: true, ms, slow: ms >= HANDSHAKE_SLOW_MS, detail: ms >= HANDSHAKE_SLOW_MS ? `MCP handshake ok in ${ms}ms (slow, budget ${HANDSHAKE_SLOW_MS}ms)` : `MCP handshake ok in ${ms}ms` });
      }
    });

    child.stderr?.on("data", () => {
      // stderr diagnostics are normal; don't fail on stderr output.
    });

    child.on("error", (err) => {
      finish({ ok: false, ms: Date.now() - started, slow: false, detail: `MCP spawn failed: ${err.message}` });
    });

    child.on("exit", (code) => {
      if (settled) return;
      const ms = Date.now() - started;
      if (code !== null && code !== 0) {
        finish({ ok: false, ms, slow: false, detail: `MCP process exited with code ${code}` });
      } else {
        finish({ ok: true, ms, slow: ms >= HANDSHAKE_SLOW_MS, detail: `MCP process started and exited cleanly in ${ms}ms` });
      }
    });

    child.stdin?.write(handshakeRequest(id));
  });
}

async function spawnMcpHandshake(
  cliPath: string,
  projectRoot: string,
  budgetMs = HANDSHAKE_SLOW_MS,
): Promise<HandshakeResult> {
  // Dev checkout: the launcher is source TypeScript (scripts/cli.ts) which
  // plain node cannot execute without a loader. Skip instead of spawning a
  // doomed child; a built dist/cli.js is measured normally. Skipped, not failed.
  if (cliPath.endsWith(".ts")) {
    return { ok: true, ms: null, slow: false, detail: "MCP handshake skipped (dev-ts-no-loader: source checkout; build dist/cli.js to measure)" };
  }
  const deadline = Date.now() + budgetMs;
  let attemptTimeout = 5000;
  let id = 1;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, ms: null, slow: true, detail: `MCP handshake budget exhausted (${budgetMs}ms); heavy init deferred (MISSING-slow)` };
    }
    const res = await singleHandshakeAttempt(cliPath, projectRoot, id++, Math.min(attemptTimeout, remaining));
    if (res.ok) return res;
    // Still-booting: back off and raise the timeout, staying within budget.
    if (res.code === STILL_BOOTING_CODE && Date.now() < deadline) {
      const wait = Math.min(500 * id, deadline - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      attemptTimeout = Math.min(attemptTimeout + 5000, budgetMs);
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export type ResetTarget = "cache" | "index" | "sessions" | "metrics" | "all-generated" | "all";

export async function reset(projectRoot: string, target: ResetTarget): Promise<string[]> {
  const storagePath = join(projectRoot, PROJECT_DIR);
  const store = new JsonlStore(storagePath);
  const removed: string[] = [];
  const del = async (rel: string) => {
    if (await exists(join(storagePath, rel))) {
      await store.remove(rel);
      removed.push(rel);
    }
  };
  switch (target) {
    case "cache":
      await del("cache");
      break;
    case "index":
      await del("index");
      break;
    case "sessions":
      await del("memory/sessions");
      break;
    case "metrics":
      await del("metrics");
      break;
    case "all-generated":
      await del("cache");
      await del("index");
      await del("metrics");
      await del("memory/sessions");
      await del("tasks/active.json");
      break;
    case "all":
      // Full wipe including durable memory (explicit, confirmed by caller).
      await rm(storagePath, { recursive: true, force: true });
      removed.push(PROJECT_DIR);
      break;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JSON Schema (kept in sync with core Config).
// ---------------------------------------------------------------------------

export function configSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "supracortex config",
    type: "object",
    additionalProperties: true,
    properties: {
      enabled: { type: "boolean" },
      mode: { enum: ["off", "minimal", "balanced", "aggressive", "custom"] },
      storage: {
        type: "object",
        properties: {
          driver: { enum: ["jsonl", "sqlite"] },
          directory: { type: "string" },
          commitDurableMemory: { type: "boolean" },
          maxStorageMb: { type: "number", minimum: 1 },
        },
      },
      memory: { type: "object" },
      context: { type: "object" },
      cache: { type: "object" },
      graph: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          maxNodes: { type: "integer", minimum: 1, maximum: 50000 },
          maxEdges: { type: "integer", minimum: 1, maximum: 200000 },
          maxQueryResults: { type: "integer", minimum: 1, maximum: 50 },
          automaticContext: { type: "boolean", description: "Experimental OpenCode-only graph-assisted context ranking; off by default." },
        },
      },
      parallelism: { type: "object" },
      efficiency: { type: "object" },
      integration: { type: "object" },
      privacy: { type: "object" },
      logging: { type: "object" },
      telemetry: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { enum: ["off", "local"] },
          maxEvents: { type: "integer", minimum: 0 },
          maxAgeDays: { type: "number", minimum: 0 },
        },
      },
    },
  };
}

export { PLUGIN_VERSION };

// ---------------------------------------------------------------------------
// Central config migration
// ---------------------------------------------------------------------------

export interface ConfigMigrationEntry {
  project: string;
  action: "removed" | "reduced" | "kept";
  ignored: string[];
  kept: Record<string, unknown>;
  backup?: string;
}

/**
 * Strip every non-project-scoped key from project config files so the central
 * config is the only source of feature settings. The storage driver is kept
 * only when detection from disk would not reproduce it (store identity must
 * never change). Dry run unless `apply`. Every rewritten/removed file is
 * backed up next to the central config.
 */
export async function migrateProjectConfigs(projectRoots: string[], apply: boolean): Promise<ConfigMigrationEntry[]> {
  const out: ConfigMigrationEntry[] = [];
  const backupDir = join(dirname(globalConfigPath()), "project-config-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const root of projectRoots) {
    const cfgPath = projectConfigPath(root);
    const raw = await readJsoncObject(cfgPath);
    if (!raw) continue;
    const scoped = projectScopedConfig(raw);
    const kept = JSON.parse(JSON.stringify(scoped.config)) as Record<string, any>;
    // Defaults carry no information.
    if (kept.enabled === true) delete kept.enabled;
    if (kept.storage?.directory === PROJECT_DIR) delete kept.storage.directory;
    if (kept.storage?.driver) {
      const storageRoot = join(root, kept.storage.directory ?? PROJECT_DIR);
      const { detectStorageDriver } = await import("@local/supracortex-core");
      const detected = detectStorageDriver(storageRoot, (p) => existsSync(p)) ?? "jsonl";
      if (detected === kept.storage.driver) delete kept.storage.driver;
    }
    if (kept.storage && Object.keys(kept.storage).length === 0) delete kept.storage;
    const action: ConfigMigrationEntry["action"] = Object.keys(kept).length === 0 ? "removed" : scoped.ignored.length ? "reduced" : "kept";
    const entry: ConfigMigrationEntry = { project: root, action, ignored: scoped.ignored, kept };
    if (apply && action !== "kept") {
      await mkdir(backupDir, { recursive: true });
      const bak = join(backupDir, `${root.replace(/^\/+/, "").replace(/\//g, "__")}.config.jsonc`);
      await copyFile(cfgPath, bak);
      entry.backup = bak;
      if (action === "removed") await rm(cfgPath, { force: true });
      else await writeFile(cfgPath, `// supracortex project override (${OWNED_MARKER}) — project-scoped keys only\n${JSON.stringify(kept, null, 2)}\n`, "utf8");
    }
    out.push(entry);
  }
  return out;
}
