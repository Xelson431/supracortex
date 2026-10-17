import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";
import { stripJsonc } from "./config-loader.ts";
import { writeFileAtomic } from "./host-config.ts";

export const AGENTS = ["claude", "codex", "cursor", "gemini", "opencode", "pi"] as const;
export type AgentName = (typeof AGENTS)[number];
/**
 * A generic MCP target for any CLI that follows the standard `mcpServers` stdio
 * JSON convention (Claude, Cursor, Pi/picode, Cline, Windsurf, and others). This
 * is the "every CLI" extension point: point `file` at the tool's MCP config and
 * SupraCortex owns exactly the `mcpServers.supracortex` key. Use `style: "bare"`
 * to omit the `type` field for tools that reject it (Gemini-style).
 */
export interface CustomTarget { name: string; file: string; style?: "stdio" | "bare"; }
export interface AgentDetection { agent: AgentName; detected: boolean; experimental: boolean; reason: string; }
export interface WiringChange { agent: string; file: string; ownedPath: string; status: "created" | "updated" | "skipped"; backup?: string; }
export interface InstallManifestEntry { adapter: string; file: string; ownedPath: string; preEditHash: string | null; postEditHash: string; backup: string | null; created: boolean; }
export interface WiringReport { detections: AgentDetection[]; changes: WiringChange[]; backups: string[]; manifest: string; notes: string[]; }

const MARK = "supracortex:owned";
const GUIDANCE_BEGIN = `<!-- ${MARK}:begin -->`;
const GUIDANCE_END = `<!-- ${MARK}:end -->`;
const FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } } as const;
const MANIFEST_VERSION = 1;
const MAX_MANIFEST_ENTRIES = 128;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CUSTOM_ADAPTER_RE = /^custom:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}
async function hash(path: string): Promise<string | null> {
  if (!(await exists(path))) return null;
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function escapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function fsErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** True if the file at `path` is unmistakably a SupraCortex-owned plugin loader:
 * it either carries the owned marker or is a one-line re-export of our dist
 * entry. Used to delete a stale loader without ever removing an unrelated
 * user plugin. */
async function isOursPluginLoader(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  const text = await readFile(path, "utf8");
  return (
    text.includes(MARK) ||
    (text.includes("export { SupraCortex }") && text.includes("opencode.js"))
  );
}

/**
 * Prove that a host-configuration path is below the selected install root.
 * Existing path components must be ordinary files/directories: symlinked
 * components are rejected so install and uninstall cannot be redirected after
 * lexical `..` checks. Callers repeat this immediately before mutation to
 * narrow the unavoidable user-space TOCTOU window.
 */
export async function assertInstallerPathConfined(
  root: string,
  target: string,
  label = "installer path",
): Promise<string> {
  if (!root || !target || root.includes("\0") || target.includes("\0")) {
    throw new Error(`${label} is empty or contains a NUL byte`);
  }
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  if (absTarget === absRoot || escapesRoot(absRoot, absTarget)) {
    throw new Error(`${label} escapes the allowed root`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absRoot);
  } catch {
    throw new Error(`${label} root does not exist`);
  }

  const parts = relative(absRoot, absTarget).split(sep).filter(Boolean);
  let cursor = absRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
      if (info.isFile() && info.nlink > 1) throw new Error(`${label} contains a hard-linked file`);
      const canonical = await realpath(cursor);
      if (escapesRoot(canonicalRoot, canonical)) {
        throw new Error(`${label} resolves outside the allowed root`);
      }
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") break;
      throw error;
    }
  }
  return absTarget;
}

function resolveCustomTarget(root: string, requested: string): string {
  if (!requested || requested.includes("\0")) throw new Error("custom target file is empty or invalid");
  if (isAbsolute(requested) || win32.isAbsolute(requested)) {
    throw new Error("custom target file must be relative to the selected project root");
  }
  const portable = requested.replace(/\\/g, "/");
  if (portable.split("/").includes("..")) {
    throw new Error("custom target file escapes the selected project root");
  }
  return resolve(root, ...portable.split("/"));
}

async function backup(root: string, path: string): Promise<string> {
  await assertInstallerPathConfined(root, path, "backup source");
  // Cap litter: reuse a single sidecar file instead of timestamped copies,
  // mirroring cli-core.ts. Legacy timestamped sidecars are swept best-effort
  // (older backups outside the sweep pattern are left in place and reported).
  const out = `${path}.bak`;
  await assertInstallerPathConfined(root, out, "backup destination");
  await copyFile(path, out);
  try {
    const dir = dirname(path);
    const base = basename(path);
    const items = await readdir(dir).catch(() => [] as string[]);
    const legacy = (items as string[]).filter((n) => n.startsWith(`${base}.supracortex-backup-`)).sort();
    for (const n of legacy) {
      try { await rm(join(dir, n), { force: true }); } catch { /* keep + report */ }
    }
    if (legacy.length) console.warn(`[supracortex:install] swept ${legacy.length} legacy backup(s) beside ${base}`);
  } catch { /* best-effort */ }
  return out;
}

/**
 * Resolve the packed package root regardless of whether this module runs from
 * source (`packages/opencode/src/`) or bundled into `dist/*.js`. Walk up to the
 * nearest package.json named "supracortex".
 */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
        if (j.name === "supracortex") return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}
function distEntry(file: string): string {
  const root = packageRoot();
  const built = join(root, "dist", file);
  if (existsSync(built)) return built;
  // The OpenCode host compiles the plugin loader itself, so a source fallback is
  // valid for opencode.js. The MCP CLI entry needs its own launch handling
  // (`cliLaunchArgs`): host configs run it under bare Node, so a TypeScript
  // source path is only runnable when Node type stripping is enabled.
  if (file === "opencode.js") return join(root, "packages", "opencode", "src", "index.ts");
  return built;
}
/**
 * MCP launch args for the `node` executable, i.e. everything before `mcp`.
 *
 * - Built installs ship `dist/cli.js` -> `[dist/cli.js, "mcp"]` exactly as
 *   before.
 * - Fresh checkouts (`dist/` is gitignored) fall back to the TypeScript source
 *   `scripts/cli.ts` WITH `--experimental-strip-types`. Node 22.6 (the
 *   documented minimum in scripts/launcher-common.sh) accepts that flag for
 *   this file, and it remains accepted on newer Node, so the command runs
 *   across the supported range. A bare `.ts` path with no flag is what crashes
 *   on Node 22; the explicit flag avoids that.
 * - Neither entry present -> the checkout is broken; refuse with an actionable
 *   error rather than emitting an unrunnable command.
 */
function cliLaunchArgs(): string[] {
  const root = packageRoot();
  const built = join(root, "dist", "cli.js");
  if (existsSync(built)) return [built, "mcp"];
  const source = join(root, "scripts", "cli.ts");
  if (existsSync(source)) return ["--experimental-strip-types", source, "mcp"];
  throw new Error(
    `SupraCortex is not built: ${built} is missing, and its source entry ${source} was not found either. ` +
      `Run "pnpm install && pnpm run build" in ${root}.`,
  );
}
function mcpNodeExecutable(): string {
  // `supracode install` may run under Bun, but the MCP child needs Node
  // >=22.5 for the shared node:sqlite backend. Store a Node command, not the
  // installer runtime. SUPRACODE_NODE_BIN overrides PATH resolution.
  return process.release?.name === "node"
    ? process.execPath
    : process.env.SUPRACODE_NODE_BIN?.trim() || "node";
}
/**
 * The installed stable MCP entry (`supracortex-mcp` from install.sh), if any.
 * Host configs that reference it survive the checkout moving, being rebuilt
 * or being switched to another branch; only the shim needs to follow.
 * SUPRACORTEX_MCP_BIN overrides; set it to "" to force the direct node form.
 */
export function stableMcpShim(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SUPRACORTEX_MCP_BIN;
  if (override !== undefined) return override.trim() || null;
  const home = env.HOME?.trim();
  const candidates = [home ? join(home, ".local", "bin", "supracortex-mcp") : "", "/usr/local/bin/supracortex-mcp", "/opt/homebrew/bin/supracortex-mcp"];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}
/** stdio MCP launch spec: the stable shim when installed, else node + this checkout. */
export function mcpLaunch(): { command: string; args: string[] } {
  const shim = stableMcpShim();
  return shim ? { command: shim, args: [] } : { command: mcpNodeExecutable(), args: cliLaunchArgs() };
}
function command(root: string): { command: string; args: string[]; env: Record<string, string> } {
  return { ...mcpLaunch(), env: { SUPRACORTEX_ROOT: root } };
}

export async function detectAgents(root: string): Promise<AgentDetection[]> {
  const checks: Array<[AgentName, string[], boolean]> = [
    ["claude", [".mcp.json", "CLAUDE.md", ".claude"], false],
    ["codex", [".codex", "AGENTS.md"], false],
    ["cursor", [".cursor"], true],
    ["gemini", [".gemini"], true],
    ["opencode", [".opencode", "opencode.json", "opencode.jsonc"], false],
    ["pi", [".pi"], false],
  ];
  return Promise.all(
    checks.map(async ([agent, paths, experimental]) => {
      const hit = await Promise.all(paths.map((p) => exists(join(root, p))));
      const detected = hit.some(Boolean);
      return { agent, detected, experimental, reason: detected ? "project files detected" : "not detected" };
    }),
  );
}

function jsonFile(agent: AgentName, root: string): string {
  if (agent === "claude") return join(root, ".mcp.json");
  if (agent === "cursor") return join(root, ".cursor", "mcp.json");
  if (agent === "gemini") return join(root, ".gemini", "settings.json");
  if (agent === "pi") return join(root, ".pi", "mcp.json");
  // Canonical path matches `install` (cli-core.ts): `.ts` is the single source
  // of truth so OpenCode does not scan two files and load the plugin twice.
  return join(root, ".opencode", "plugins", "supracortex.ts");
}
function ownedPathFor(agent: AgentName): string {
  if (agent === "opencode") return ".opencode.plugins.supracortex";
  if (agent === "codex") return "mcp_servers.supracortex";
  return "mcpServers.supracortex";
}
function serverValue(agent: AgentName, root: string): Record<string, unknown> {
  const spec = command(root);
  return agent === "gemini"
    ? { command: spec.command, args: spec.args, env: spec.env }
    : { type: "stdio", command: spec.command, args: spec.args, env: spec.env };
}

/** Produce the next file content for a JSON/JSONC-configured agent, preserving
 * unrelated keys and comments via jsonc-parser edits. */
async function nextJsonContent(file: string, root: string, agent: AgentName): Promise<{ content: string; owned: string }> {
  if (agent === "opencode") {
    const existing = (await exists(file)) ? await readFile(file, "utf8") : "";
    // Idempotent: an existing owned loader (written by `install` or a prior
    // `init`) is preserved byte-for-byte rather than rewritten or duplicated.
    if (existing.includes(MARK)) return { content: existing, owned: ownedPathFor(agent) };
    // Never overwrite an unrelated user plugin that happens to share the path.
    if (existing.trim()) throw new Error("user-owned plugin file; refusing overwrite");
    const content = `// ${MARK}\nexport { SupraCortex } from ${JSON.stringify(distEntry("opencode.js"))};\n`;
    return { content, owned: ownedPathFor(agent) };
  }
  const existing = (await exists(file)) ? await readFile(file, "utf8") : "";
  if (existing.trim()) {
    const errors: Array<{ error: number; offset: number; length: number }> = [];
    parse(existing, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`invalid JSON in ${file}`);
  }
  const base = existing.trim() ? existing : "{}\n";
  const edits = modify(base, ["mcpServers", "supracortex"], serverValue(agent, root), FMT);
  let content = applyEdits(base, edits);
  if (!content.endsWith("\n")) content += "\n";
  return { content, owned: ownedPathFor(agent) };
}

/** Generic builder for any CLI using the standard `mcpServers` stdio JSON
 * convention. Owns exactly `mcpServers.supracortex`, preserving all other keys
 * and comments. `style: "bare"` omits the `type` field for tools that reject it. */
async function nextCustomContent(file: string, root: string, style: "stdio" | "bare"): Promise<{ content: string; owned: string }> {
  const spec = command(root);
  const value: Record<string, unknown> = style === "bare"
    ? { command: spec.command, args: spec.args, env: spec.env }
    : { type: "stdio", command: spec.command, args: spec.args, env: spec.env };
  const existing = (await exists(file)) ? await readFile(file, "utf8") : "";
  if (existing.trim()) {
    const errors: Array<{ error: number; offset: number; length: number }> = [];
    parse(existing, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`invalid JSON in ${file}`);
  }
  const base = existing.trim() ? existing : "{}\n";
  const edits = modify(base, ["mcpServers", "supracortex"], value, FMT);
  let content = applyEdits(base, edits);
  if (!content.endsWith("\n")) content += "\n";
  return { content, owned: "mcpServers.supracortex" };
}

/** Codex uses TOML; we own exactly one marker-fenced table block. When `root`
 * is null (global install at ~/.codex/config.toml) the baked SUPRACORTEX_ROOT is
 * omitted so the server adapts to whatever project Codex launches in. */
async function nextCodexContent(file: string, root: string | null): Promise<{ content: string; owned: string }> {
  const begin = `# ${MARK}:begin`;
  const end = `# ${MARK}:end`;
  const launch = mcpLaunch();
  const envBlock = root === null
    ? ""
    : `[mcp_servers.supracortex.env]\nSUPRACORTEX_ROOT = ${JSON.stringify(root)}\n`;
  const block =
    `${begin}\n[mcp_servers.supracortex]\ncommand = ${JSON.stringify(launch.command)}\n` +
    `args = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]\n${envBlock}${end}`;
  const old = (await exists(file)) ? await readFile(file, "utf8") : "";
  if (old.includes("[mcp_servers.supracortex]") && !old.includes(begin)) {
    throw new Error("user-owned Codex mcp_servers.supracortex configuration; refusing overwrite");
  }
  const content = old.includes(begin)
    ? old.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), block)
    : `${old.trimEnd()}${old.trim() ? "\n\n" : ""}${block}\n`;
  return { content, owned: "mcp_servers.supracortex" };
}

/**
 * Agent guidance injected into MCP-host instruction files (CLAUDE.md, AGENTS.md)
 * so MCP-only hosts use SupraCortex tools without the user asking. This is the
 * MCP-host counterpart to the OpenCode host guidance append. The block
 * is wrapped in the same marker-fence convention used for Codex TOML, adapted
 * to Markdown comments. Keep it brief: it is injected into every future session.
 */
export function agentGuidance(): string {
  return `${GUIDANCE_BEGIN}
## SupraCortex

This project is wired to a local SupraCortex MCP server. Use its tools to ground your work in project memory.

- ALWAYS call cortex_context before any multi-file task; single typo fix may skip with reason. Treat the returned packet as guidance to verify against source files, not absolute truth.
- Use \`cortex_search\` for a narrower memory lookup, \`cortex_record\` with \`type: "memory"\` or \`type: "outcome"\` only for verified durable knowledge, and \`cortex_handoff\` for continuity. Never record secrets or full conversation transcripts.
- MCP does not claim files or schedule parallel agents; coordinate writes through the host and avoid duplicating the host's own graph/context tools.
- If SupraCortex is unavailable or errors, continue normally. Never fail the task because of it.
${GUIDANCE_END}`;
}

/** Instruction file that receives agent guidance; null for agents without one
 * (opencode injects context automatically; cursor/gemini/pi are not MCP-host
 * instruction files). */
function guidanceFileFor(agent: AgentName, root: string): string | null {
  if (agent === "claude") return join(root, "CLAUDE.md");
  if (agent === "codex") return join(root, "AGENTS.md");
  return null;
}

/** True if `content` still contains a BEGIN/END marker that is not part of the
 * single fresh block passed in. Used to detect orphan fences (a BEGIN without a
 * matching END, an END without a BEGIN, or mismatched ordering) after complete
 * blocks have been collapsed. */
function hasOrphanFence(content: string, block: string): boolean {
  const withoutBlock = content.replace(block, "");
  return withoutBlock.includes(GUIDANCE_BEGIN) || withoutBlock.includes(GUIDANCE_END);
}

/** Produce the next instruction-file content. Idempotent and non-destructive:
 * content outside the fence is preserved byte-for-byte. Complete owned blocks
 * are collapsed to exactly one (kept at the position of the first). An orphan
 * fence (BEGIN without END, or END without BEGIN) is repaired by APPENDING a
 * fresh block — never by truncating from the orphan, which would lose user
 * content. */
async function nextGuidanceContent(file: string): Promise<{ content: string; owned: string }> {
  const old = (await exists(file)) ? await readFile(file, "utf8") : "";
  const block = agentGuidance();
  const name = file.split(sep).pop() ?? file;

  const fullBlockRe = new RegExp(`${GUIDANCE_BEGIN}[\\s\\S]*?${GUIDANCE_END}`, "g");
  const firstIndex = old.search(fullBlockRe);

  let content: string;
  if (firstIndex !== -1) {
    // At least one complete block: remove ALL of them, then re-insert exactly
    // one fresh block at the position of the first. This collapses duplicates
    // to a single block while leaving surrounding content untouched.
    const withoutBlocks = old.replace(fullBlockRe, "");
    content = withoutBlocks.slice(0, firstIndex) + block + withoutBlocks.slice(firstIndex);
  } else {
    content = old;
  }

  if (hasOrphanFence(content, block)) {
    // A BEGIN/END survives outside a complete block: append a fresh block and
    // leave the orphan text intact. Appending cannot lose user content.
    content = `${content.endsWith("\n") ? content : `${content}\n`}\n${block}\n`;
  } else if (content.trim().length === 0) {
    content = `${block}\n`;
  } else if (!content.includes(block)) {
    content = `${content.endsWith("\n") ? content : `${content}\n`}\n${block}\n`;
  }
  return { content, owned: name };
}

/** Wire Codex globally at ~/.codex/config.toml (rootless, reversible block). */
export async function wireCodexGlobal(homeDir: string): Promise<{ file: string; created: boolean; backup?: string }> {
  const root = resolve(homeDir);
  const file = join(root, ".codex", "config.toml");
  await assertInstallerPathConfined(root, file, "global Codex config");
  const { content } = await nextCodexContent(file, null);
  const before = await hash(file);
  if (before !== null && before === hashText(content)) return { file, created: false };
  await assertInstallerPathConfined(root, file, "global Codex config");
  await mkdir(dirname(file), { recursive: true });
  let bak: string | undefined;
  if (before) bak = await backup(root, file);
  await assertInstallerPathConfined(root, file, "global Codex config");
  await writeFile(file, content, "utf8");
  return { file, created: before === null, ...(bak ? { backup: bak } : {}) };
}

/** Remove only our marker-fenced Codex block; delete file if nothing else left. */
export async function unwireCodexGlobal(homeDir: string): Promise<string | null> {
  const root = resolve(homeDir);
  const file = join(root, ".codex", "config.toml");
  await assertInstallerPathConfined(root, file, "global Codex config");
  if (!(await exists(file))) return null;
  const text = await readFile(file, "utf8");
  const cleaned = removeCodexBlock(text);
  if (cleaned === text) return null;
  await assertInstallerPathConfined(root, file, "global Codex config");
  if (cleaned.trim().length === 0) await rm(file, { force: true });
  else await writeFile(file, cleaned, "utf8");
  return file;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestOwnedPath(adapter: string): string | null {
  if (adapter === "opencode") return ".opencode.plugins.supracortex";
  if (adapter === "codex") return "mcp_servers.supracortex";
  if ((AGENTS as readonly string[]).includes(adapter) || CUSTOM_ADAPTER_RE.test(adapter)) {
    return "mcpServers.supracortex";
  }
  return null;
}

function builtInTarget(root: string, adapter: AgentName): string {
  return adapter === "codex" ? join(root, ".codex", "config.toml") : jsonFile(adapter, root);
}

function manifestPathValue(root: string, value: string, label: string): string {
  if (!value || value.length > 4096 || value.includes("\0")) throw new Error(`${label} is invalid`);
  if (isAbsolute(value)) return resolve(value);
  return resolveCustomTarget(root, value);
}

async function validateManifestEntry(
  root: string,
  raw: unknown,
  index: number,
): Promise<InstallManifestEntry> {
  const label = `install manifest entry ${index}`;
  if (!isRecord(raw)) throw new Error(`${label} is not an object`);
  const allowed = new Set(["adapter", "file", "ownedPath", "preEditHash", "postEditHash", "backup", "created"]);
  if (Object.keys(raw).some((key) => !allowed.has(key)) || Object.keys(raw).length !== allowed.size) {
    throw new Error(`${label} has an unexpected shape`);
  }
  if (typeof raw.adapter !== "string" || typeof raw.file !== "string" || typeof raw.ownedPath !== "string") {
    throw new Error(`${label} has invalid identity fields`);
  }
  const expectedOwnedPath = manifestOwnedPath(raw.adapter);
  if (expectedOwnedPath === null || raw.ownedPath !== expectedOwnedPath) {
    throw new Error(`${label} has an invalid adapter/ownership pair`);
  }
  if (raw.preEditHash !== null && (typeof raw.preEditHash !== "string" || !SHA256_RE.test(raw.preEditHash))) {
    throw new Error(`${label} has an invalid pre-edit hash`);
  }
  if (typeof raw.postEditHash !== "string" || !SHA256_RE.test(raw.postEditHash)) {
    throw new Error(`${label} has an invalid installed hash`);
  }
  if (typeof raw.created !== "boolean" || (raw.backup !== null && typeof raw.backup !== "string")) {
    throw new Error(`${label} has invalid lifecycle fields`);
  }

  const file = manifestPathValue(root, raw.file, `${label} target`);
  await assertInstallerPathConfined(root, file, `${label} target`);
  if ((AGENTS as readonly string[]).includes(raw.adapter)) {
    const expected = resolve(builtInTarget(root, raw.adapter as AgentName));
    if (file !== expected) throw new Error(`${label} target does not match its adapter`);
  }

  let backupPath: string | null = null;
  if (typeof raw.backup === "string") {
    backupPath = manifestPathValue(root, raw.backup, `${label} backup`);
    await assertInstallerPathConfined(root, backupPath, `${label} backup`);
    const bakSingle = `${file}.bak`;
    const legacyPrefix = `${file}.supracortex-backup-`;
    const isSingle = backupPath === bakSingle;
    const isLegacy = backupPath.startsWith(legacyPrefix) && /^\d+$/.test(backupPath.slice(legacyPrefix.length));
    if (!isSingle && !isLegacy) {
      throw new Error(`${label} backup is not owned by its target`);
    }
  }

  return {
    adapter: raw.adapter,
    file,
    ownedPath: raw.ownedPath,
    preEditHash: raw.preEditHash as string | null,
    postEditHash: raw.postEditHash,
    backup: backupPath,
    created: raw.created,
  };
}

async function readInstallManifest(root: string, manifestPath: string): Promise<InstallManifestEntry[]> {
  await assertInstallerPathConfined(root, manifestPath, "install manifest");
  if (!(await exists(manifestPath))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("install manifest is malformed; refusing to modify host configuration");
  }
  if (!isRecord(parsed) || parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
    throw new Error("install manifest has an unsupported or invalid document shape");
  }
  if (Object.keys(parsed).some((key) => key !== "version" && key !== "entries")) {
    throw new Error("install manifest contains unexpected document fields");
  }
  if (parsed.entries.length > MAX_MANIFEST_ENTRIES) {
    throw new Error(`install manifest exceeds ${MAX_MANIFEST_ENTRIES} entries`);
  }
  const entries: InstallManifestEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < parsed.entries.length; index++) {
    const entry = await validateManifestEntry(root, parsed.entries[index], index);
    if (seen.has(entry.file)) throw new Error("install manifest contains duplicate targets");
    seen.add(entry.file);
    entries.push(entry);
  }
  return entries;
}

export async function wireAgents(
  root: string,
  opts: { yes: boolean; only?: AgentName[]; customTargets?: CustomTarget[]; guidance?: boolean } = { yes: true },
): Promise<WiringReport> {
  root = resolve(root);
  const detections = await detectAgents(root);
  const selected = opts.only ?? detections.filter((d) => d.detected).map((d) => d.agent);
  const changes: WiringChange[] = [];
  const guidanceNotes: string[] = [];
  const backups: string[] = [];
  const preHashes = new Map<string, string | null>();
  const manifestPath = join(root, ".supracortex", "state", "install-manifest.json");
  const previous = opts.yes ? await readInstallManifest(root, manifestPath) : [];

  type Job = { adapter: string; file: string; result: { content: string; owned: string } };
  const jobs: Job[] = [];
  for (const agent of selected) {
    if (!(AGENTS as readonly string[]).includes(agent)) throw new Error(`unsupported agent adapter: ${String(agent)}`);
    const file = builtInTarget(root, agent);
    await assertInstallerPathConfined(root, file, `${agent} configuration`);
    const result = agent === "codex" ? await nextCodexContent(file, root) : await nextJsonContent(file, root, agent);
    jobs.push({ adapter: agent, file, result });
  }
  for (const target of opts.customTargets ?? []) {
    const adapter = `custom:${target.name}`;
    if (!CUSTOM_ADAPTER_RE.test(adapter)) {
      throw new Error("custom target name must contain only letters, numbers, dot, underscore, or hyphen");
    }
    const file = resolveCustomTarget(root, target.file);
    await assertInstallerPathConfined(root, file, `${adapter} configuration`);
    const result = await nextCustomContent(file, root, target.style ?? "stdio");
    jobs.push({ adapter, file, result });
  }
  const jobTargets = new Set<string>();
  for (const job of jobs) {
    if (jobTargets.has(job.file)) throw new Error(`multiple adapters target the same file: ${job.file}`);
    jobTargets.add(job.file);
  }

  for (const { adapter, file, result } of jobs) {
    await assertInstallerPathConfined(root, file, `${adapter} configuration`);
    const before = await hash(file);
    preHashes.set(file, before);
    const unchanged = before !== null && before === hashText(result.content);
    const status: WiringChange["status"] = unchanged ? "skipped" : before ? "updated" : "created";

    if (!opts.yes) {
      changes.push({ agent: adapter, file, ownedPath: result.owned, status });
      continue;
    }
    if (unchanged) {
      changes.push({ agent: adapter, file, ownedPath: result.owned, status: "skipped" });
      continue;
    }
    await assertInstallerPathConfined(root, file, `${adapter} configuration`);
    await mkdir(dirname(file), { recursive: true });
    let bak: string | undefined;
    if (before) { bak = await backup(root, file); backups.push(bak); }
    await assertInstallerPathConfined(root, file, `${adapter} configuration`);
    await writeFile(file, result.content, "utf8");
    changes.push({ agent: adapter, file, ownedPath: result.owned, status, ...(bak ? { backup: bak } : {}) });
  }

  // Stale-cleanup: a prior `init --agent opencode` wrote the loader as
  // .opencode/plugins/supracortex.js; the canonical path is now the .ts file
  // written by `install`. Remove the stale .js ONLY if it is unmistakably ours
  // (owned marker or a re-export of our dist entry). Never touch an unrelated
  // user plugin; if it does not match, leave it and do not fail.
  if (opts.yes && selected.includes("opencode")) {
    const stale = join(root, ".opencode", "plugins", "supracortex.js");
    if (await isOursPluginLoader(stale)) {
      await assertInstallerPathConfined(root, stale, "stale opencode plugin");
      await rm(stale);
    }
  }

  // Agent guidance for MCP-only hosts (Claude Code, Codex). This is the MCP-host
  // counterpart to the OpenCode host guidance append: it tells the agent
  // to use SupraCortex tools so it does not need the user to ask. Idempotent and
  // non-destructive, written to the agent's instruction file. Skipped entirely
  // with --no-guidance; opencode is never written (it already gets automatic
  // context injection and the host guidance append).
  if (opts.guidance !== false) {
    for (const agent of selected) {
      const gFile = guidanceFileFor(agent, root);
      if (!gFile) continue;
      await assertInstallerPathConfined(root, gFile, `${agent} guidance`);
      const gResult = await nextGuidanceContent(gFile);
      const before = await hash(gFile);
      const unchanged = before !== null && before === hashText(gResult.content);
      if (!opts.yes) {
        guidanceNotes.push(`guidance ${unchanged ? "unchanged" : before ? "would update" : "would create"}: ${gFile}`);
        continue;
      }
      if (unchanged) {
        guidanceNotes.push(`guidance unchanged: ${gFile}`);
        continue;
      }
      await assertInstallerPathConfined(root, gFile, `${agent} guidance`);
      await mkdir(dirname(gFile), { recursive: true });
      let bak: string | undefined;
      if (before) { bak = await backup(root, gFile); backups.push(bak); }
      await assertInstallerPathConfined(root, gFile, `${agent} guidance`);
      await writeFileAtomic(gFile, gResult.content);
      guidanceNotes.push(`guidance ${before ? "updated" : "created"}: ${gFile}${bak ? ` (backup ${bak})` : ""}`);
    }
  }

  if (opts.yes) {
    await assertInstallerPathConfined(root, manifestPath, "install manifest");
    await mkdir(join(root, ".supracortex", "state"), { recursive: true });
    const entries: InstallManifestEntry[] = [];
    for (const c of changes) {
      const old = previous.find((e) => e.file === c.file);
      if (old && c.status === "skipped") {
        // A no-op reinstall may encounter a file that the host reformatted but
        // whose generated value is already current. Refresh the observed hash
        // so the manifest describes exactly what this transaction accepted.
        entries.push({ ...old, postEditHash: (await hash(c.file)) ?? old.postEditHash });
        continue;
      }
      entries.push({
        adapter: c.agent,
        file: c.file,
        ownedPath: c.ownedPath,
        preEditHash: preHashes.get(c.file) ?? null,
        postEditHash: (await hash(c.file)) ?? "",
        backup: c.backup ?? null,
        created: c.status === "created" || (old?.created ?? false),
      });
    }
    // Preserve manifest rows for files not touched this run.
    for (const old of previous) if (!entries.some((e) => e.file === old.file)) entries.push(old);
    if (entries.length > MAX_MANIFEST_ENTRIES) throw new Error(`install manifest exceeds ${MAX_MANIFEST_ENTRIES} entries`);
    await assertInstallerPathConfined(root, manifestPath, "install manifest");
    await writeFile(manifestPath, JSON.stringify({ version: MANIFEST_VERSION, entries }, null, 2) + "\n", "utf8");
  }
  return { detections, changes, backups, manifest: manifestPath, notes: ["Cursor and Gemini adapters are experimental.", ...guidanceNotes] };
}

function removeCodexBlock(text: string): string {
  const begin = `# ${MARK}:begin`;
  const end = `# ${MARK}:end`;
  return text.replace(new RegExp(`\\n*${begin}[\\s\\S]*?${end}\\n*`), "\n").trimStart();
}

/** Surgically remove only owned wiring. Preserves concurrent user edits and
 * comments; deletes a file only when we created it and nothing else remains. */
export async function uninstallAgents(root: string): Promise<WiringReport> {
  root = resolve(root);
  const detections = await detectAgents(root);
  const changes: WiringChange[] = [];
  const notes: string[] = ["Cursor and Gemini adapters are experimental."];
  const manifestPath = join(root, ".supracortex", "state", "install-manifest.json");
  await assertInstallerPathConfined(root, manifestPath, "install manifest");
  if (!(await exists(manifestPath))) return { detections, changes, backups: [], manifest: manifestPath, notes };

  // Validate the complete document before touching any target. One malformed,
  // escaped, duplicated, or symlinked row aborts the entire uninstall.
  const entries = await readInstallManifest(root, manifestPath);

  const remaining: InstallManifestEntry[] = [];
  for (const entry of entries) {
    if (!(await exists(entry.file))) continue; // already gone
    await assertInstallerPathConfined(root, entry.file, `uninstall target for ${entry.adapter}`);
    const observedHash = await hash(entry.file);
    if (observedHash !== entry.postEditHash) {
      remaining.push(entry);
      notes.push(`preserved user-modified ${entry.file}; installed hash no longer matches`);
      continue;
    }

    if (entry.ownedPath === ".opencode.plugins.supracortex") {
      const text = await readFile(entry.file, "utf8");
      if (text.includes(MARK)) {
        await assertInstallerPathConfined(root, entry.file, `uninstall target for ${entry.adapter}`);
        await rm(entry.file, { force: true });
        changes.push({ agent: entry.adapter, file: entry.file, ownedPath: entry.ownedPath, status: "updated" });
      } else {
        remaining.push(entry);
        notes.push(`preserved user-modified ${entry.file}`);
      }
      continue;
    }

    if (entry.adapter === "codex") {
      const text = await readFile(entry.file, "utf8");
      const cleaned = removeCodexBlock(text);
      if (cleaned !== text) {
        await assertInstallerPathConfined(root, entry.file, `uninstall target for ${entry.adapter}`);
        if (cleaned.trim().length === 0) await rm(entry.file, { force: true });
        else await writeFile(entry.file, cleaned, "utf8");
        changes.push({ agent: entry.adapter, file: entry.file, ownedPath: entry.ownedPath, status: "updated" });
      } else {
        remaining.push(entry);
      }
      continue;
    }

    // JSON/JSONC agents: surgical key removal preserving other keys + comments.
    const text = await readFile(entry.file, "utf8");
    const edits = modify(text, ["mcpServers", "supracortex"], undefined, FMT);
    const cleaned = applyEdits(text, edits);
    let removeFile = false;
    if (entry.created) {
      try {
        const obj = JSON.parse(stripJsonc(cleaned)) as Record<string, unknown>;
        const keys = Object.keys(obj);
        const servers = obj.mcpServers as Record<string, unknown> | undefined;
        const trivial =
          keys.length === 0 ||
          (keys.length === 1 && keys[0] === "mcpServers" && (!servers || Object.keys(servers).length === 0));
        if (trivial) removeFile = true;
      } catch { /* keep the file */ }
    }
    if (removeFile) {
      await assertInstallerPathConfined(root, entry.file, `uninstall target for ${entry.adapter}`);
      await rm(entry.file, { force: true });
      changes.push({ agent: entry.adapter, file: entry.file, ownedPath: entry.ownedPath, status: "updated" });
    } else if (cleaned !== text) {
      await assertInstallerPathConfined(root, entry.file, `uninstall target for ${entry.adapter}`);
      await writeFile(entry.file, cleaned, "utf8");
      changes.push({ agent: entry.adapter, file: entry.file, ownedPath: entry.ownedPath, status: "updated" });
    } else {
      remaining.push(entry);
    }
  }

  if (remaining.length) {
    await assertInstallerPathConfined(root, manifestPath, "install manifest");
    await writeFile(manifestPath, JSON.stringify({ version: MANIFEST_VERSION, entries: remaining }, null, 2) + "\n", "utf8");
  } else {
    await assertInstallerPathConfined(root, manifestPath, "install manifest");
    await rm(manifestPath, { force: true });
  }
  return { detections, changes, backups: [], manifest: manifestPath, notes };
}
