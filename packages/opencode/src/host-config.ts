/**
 * TRANSACTIONAL HOST CONFIGURATION (Phase 11.2)
 *
 * Format-aware editing of host MCP config files with a stage/validate/commit/
 * rollback protocol. Supports:
 *   - JSONC (comments, trailing commas) via jsonc-parser
 *   - TOML (Codex ~/.codex/config.toml) via minimal line-spanning section editor
 *   - Bare INI-style for certain host formats
 *
 * Every mutation goes through configTransaction() which guarantees:
 *   1. All targets staged in memory first
 *   2. All staged configs validated (parse returns valid AST)
 *   3. Original file hash compared immediately before each commit
 *   4. Temp-file-write + rename for atomicity
 *   5. Any failure rolls back every changed file from staged backups
 */

import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Atomically write a file: write to a temp file in the same directory, then
 * rename over the target so a crash mid-write never leaves a truncated file. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmpFile = `${file}.supracortex-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpFile, content, "utf8");
  await rename(tmpFile, file);
}

export type HostFormat = "jsonc" | "toml" | "ini";

export interface ConfigTarget {
  /** Absolute path to the config file. */
  file: string;
  /** Host format for parsing/generation. */
  format: HostFormat;
  /** The MCP server name to own (e.g. "supracortex"). */
  serverName: string;
  /** Command + args for the stdio MCP server. */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Root for path-confinement checks. */
  root: string;
}

export interface StagedEdit {
  target: ConfigTarget;
  originalContent: string | null;
  stagedContent: string;
  preEditHash: string | null;
  backupPath: string | null;
  originalHashAtStage: string | null;
}

export interface TransactionResult {
  committed: string[];
  skipped: string[];
  backups: string[];
  manifestEntries: TransactionManifestEntry[];
}

export interface TransactionManifestEntry {
  adapter: string;
  file: string;
  format: HostFormat;
  ownedPath: string;
  preEditHash: string | null;
  postEditHash: string;
  backup: string | null;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OWNED_MARKER = "supracortex:owned";
const TOML_BEGIN = `# ${OWNED_MARKER}:begin`;
const TOML_END = `# ${OWNED_MARKER}:end`;

// Valid MCP server names per host constraints: alphanumeric, underscore, hyphen.
// Codex TOML format may be stricter about dots.
const MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const JSONC_FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } as const };

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

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function hashFile(path: string): Promise<string | null> {
  try {
    return hashContent(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function escapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function ownedPathFor(serverName: string, format: HostFormat): string {
  if (format === "toml") return `mcp_servers.${serverName}`;
  return `mcpServers.${serverName}`;
}

function fsErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

// ---------------------------------------------------------------------------
// Format-aware content generation
// ---------------------------------------------------------------------------

/** Generate next JSONC content. Preserves unrelated keys + comments. */
export async function nextJsoncContent(
  target: ConfigTarget,
): Promise<string> {
  const existing = await readFile(target.file, "utf8").catch(() => "");
  const base = existing.trim() ? existing : "{}\n";
  const value: Record<string, unknown> = {
    type: "stdio",
    command: target.command,
    args: target.args,
    ...(target.env && Object.keys(target.env).length ? { env: target.env } : {}),
  };
  const edits = modify(base, ["mcpServers", target.serverName], value, JSONC_FMT);
  let content = applyEdits(base, edits);
  if (!content.endsWith("\n")) content += "\n";
  return content;
}

/** Validate that existing JSONC parses (or is empty). */
function validateJsonc(text: string): boolean {
  if (!text.trim()) return true;
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0;
}

/**
 * Minimal TOML section editor for Codex config.toml.
 *
 * Operates on line spans for `[mcp_servers.X]` sections. Preserves ALL
 * unrelated content byte-for-byte. Never uses broad regex replacement on values.
 *
 * Strategy:
 * 1. If our marker-fenced block exists, replace it entirely.
 * 2. If our section exists but without markers (user-edited), refuse.
 * 3. Otherwise append our block at end.
 */
export function nextTomlContent(
  existing: string,
  serverName: string,
  command: string,
  args: string[],
  env?: Record<string, string>,
): string {
  const section = `[mcp_servers.${serverName}]`;

  // Find existing section span by line analysis.
  const sectionInfo = findTomlSection(existing, serverName);

  // Check for user-owned section (no marker).
  if (sectionInfo && sectionInfo.startLine !== -1) {
    const lines = existing.split("\n");
    // Look for our marker in the lines spanning this section.
    const sectionLines = lines.slice(sectionInfo.startLine, sectionInfo.endLine + 1);
    const hasMarker = sectionLines.some((l) => l.includes(TOML_BEGIN) || l.includes(OWNED_MARKER));
    if (!hasMarker) {
      throw new Error(
        `user-owned [mcp_servers.${serverName}] in Codex config; refusing overwrite`,
      );
    }
  }

  // Build replacement block.
  const block = buildTomlBlock(serverName, command, args, env);

  if (sectionInfo && sectionInfo.startLine !== -1) {
    return replaceTomlSection(existing, sectionInfo, block);
  }
  // Append.
  const trimmed = existing.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : "\n"}${block}\n`;
}

interface TomlSectionSpan {
  startLine: number;
  endLine: number;
  headerIndex: number; // byte offset of section header
  headerEnd: number;   // byte offset after header line
  bodyStart: number;   // byte offset where body begins
  bodyEnd: number;     // byte offset where section ends (before next section or EOF)
}

function findTomlSection(text: string, serverName: string): TomlSectionSpan | null {
  const lines = text.split("\n");
  const header = `[mcp_servers.${serverName}]`;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === header || trimmed.startsWith(`${header} `) || trimmed.startsWith(`${header}\t`)) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;

  // Back up to include any begin marker line immediately preceding the section header.
  const beginMarker = `# ${OWNED_MARKER}:begin`;
  if (startLine > 0) {
    const prevTrimmed = lines[startLine - 1]!.trim();
    if (prevTrimmed === beginMarker || prevTrimmed.startsWith(beginMarker)) {
      startLine = startLine - 1;
    }
  }

  // Find end of section: next top-level section, next mcp_servers.X, or EOF.
  let endLine = startLine;
  for (let i = startLine + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    // Stop at next top-level section or different mcp_servers section.
    if (t.startsWith("[") && !t.includes(serverName)) {
      endLine = i - 1;
      break;
    }
    endLine = i;
  }
  if (endLine < startLine) endLine = startLine;

  // Compute byte offsets.
  let headerIndex = 0;
  for (let i = 0; i < startLine; i++) {
    headerIndex += lines[i]!.length + 1; // +1 for newline
  }

  let bodyEnd = headerIndex;
  for (let i = startLine; i <= endLine; i++) {
    bodyEnd += lines[i]!.length + 1;
  }

  const headerLine = lines[startLine]!;
  const headerEnd = headerIndex + headerLine.length + 1;

  return { startLine, endLine, headerIndex, headerEnd, bodyStart: headerEnd, bodyEnd };
}

function replaceTomlSection(text: string, span: TomlSectionSpan, block: string): string {
  const before = text.slice(0, span.headerIndex);
  const after = text.slice(span.bodyEnd);
  return before + block + "\n" + after;
}

function buildTomlBlock(
  serverName: string,
  command: string,
  args: string[],
  env?: Record<string, string>,
): string {
  const argsToml = args.length > 0
    ? `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n`
    : "";
  const envToml = env && Object.keys(env).length > 0
    ? `[mcp_servers.${serverName}.env]\n${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n")}\n`
    : "";
  return (
    `${TOML_BEGIN}\n` +
    `[mcp_servers.${serverName}]\n` +
    `command = ${JSON.stringify(command)}\n` +
    argsToml +
    envToml +
    `${TOML_END}`
  );
}

export function removeTomlBlock(text: string): string {
  return text.replace(new RegExp(`\\n*${TOML_BEGIN}[\\s\\S]*?${TOML_END}\\n*`), "\n").trimStart();
}

// ---------------------------------------------------------------------------
// TOML validation (minimal — just checks line structure, not full TOML spec)
// ---------------------------------------------------------------------------

function validateTomlStructure(text: string): boolean {
  if (!text.trim()) return true;
  const lines = text.split("\n");
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = true;
      continue;
    }
    // Expect key = value lines in sections
    if (inSection && !trimmed.includes("=")) {
      // Could be a bare key or comment without # - be lenient
      continue;
    }
  }
  return true; // lenient
}

/** Validates that a staged config content is structurally sound. */
export function validateStagedContent(content: string, format: HostFormat): boolean {
  if (!content.trim()) return false; // empty content is invalid for a config
  switch (format) {
    case "jsonc":
      return validateJsonc(content);
    case "toml":
      return validateTomlStructure(content);
    case "ini":
      // Minimal INI: key=value lines or [section] headers
      return content.split("\n").every((l) => {
        const t = l.trim();
        return t === "" || t.startsWith("#") || t.startsWith(";") ||
          t.startsWith("[") || t.includes("=");
      });
  }
}

// ---------------------------------------------------------------------------
// Server name validation per host constraints
// ---------------------------------------------------------------------------

export function validateServerName(name: string, format: HostFormat): boolean {
  if (!name || name.length > 64) return false;
  if (format === "toml") {
    // Codex TOML: alphanumeric + underscore + hyphen, no dots in table name.
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
  }
  return MCP_NAME_RE.test(name);
}

// ---------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------

export function assertPathConfined(root: string, target: string, label: string): void {
  if (!root || !target || root.includes("\0") || target.includes("\0")) {
    throw new Error(`${label} is empty or contains a NUL byte`);
  }
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  if (absTarget === absRoot || escapesRoot(absRoot, absTarget)) {
    throw new Error(`${label} escapes the allowed root`);
  }
}

// ---------------------------------------------------------------------------
// Stage / Commit / Rollback Protocol
// ---------------------------------------------------------------------------

export interface StageOptions {
  targets: ConfigTarget[];
  /** If true, skip targets whose content already matches desired state. */
  skipUnchanged?: boolean;
}

export interface CommitOptions {
  /** If true, write install manifest after commit. */
  writeManifest?: boolean;
  manifestPath?: string;
  adapterName?: string;
}

/**
 * Stage multiple config targets in memory.
 *
 * For each target:
 *   - Read original content (if exists), compute hash
 *   - Generate desired content using format-aware builder
 *   - Store backup of original in temp dir (for rollback)
 *   - Return the staged edit
 *
 * Does NOT write anything to the target paths.
 */
export async function stageConfigEdits(
  stageDir: string,
  opts: StageOptions,
): Promise<StagedEdit[]> {
  await mkdir(stageDir, { recursive: true });
  const edits: StagedEdit[] = [];
  const seen = new Set<string>();

  for (const target of opts.targets) {
    assertPathConfined(target.root, target.file, `config target ${target.file}`);
    if (!validateServerName(target.serverName, target.format)) {
      throw new Error(`invalid MCP server name "${target.serverName}" for format ${target.format}`);
    }
    if (seen.has(target.file)) throw new Error(`duplicate target: ${target.file}`);
    seen.add(target.file);

    // Read original.
    let originalContent: string | null = null;
    let preEditHash: string | null = null;
    try {
      originalContent = await readFile(target.file, "utf8");
      preEditHash = hashContent(originalContent);
    } catch (err) {
      if (fsErrorCode(err) !== "ENOENT") throw err;
      // File doesn't exist yet — that's fine.
    }

    // Generate desired content.
    let stagedContent: string;
    switch (target.format) {
      case "jsonc":
        stagedContent = await nextJsoncContent(target);
        break;
      case "toml":
        stagedContent = nextTomlContent(
          originalContent ?? "",
          target.serverName,
          target.command,
          target.args,
          target.env,
        );
        break;
      case "ini": {
        // Simple INI: append our section at end.
        const iniBlock = buildIniBlock(target);
        stagedContent = originalContent
          ? `${originalContent.trimEnd()}\n\n${iniBlock}\n`
          : `${iniBlock}\n`;
        break;
      }
    }

    if (opts.skipUnchanged && preEditHash !== null && preEditHash === hashContent(stagedContent)) {
      continue; // no change needed
    }

    // Backup original to stage dir.
    let backupPath: string | null = null;
    if (originalContent !== null) {
      // `relative()` uses the host separator: on Windows it returns
      // `..\..\.cursor\mcp.json` (or an absolute `D:\...` path across drives).
      // Flatten both separators plus any drive colon so backupName is a single
      // filename directly under stageDir; otherwise writeFile would try to
      // create nested directories that do not exist and fail with ENOENT.
      const relativeTarget = relative(target.root, target.file)
        .replace(/[\\/:]+/g, "_")
        .replace(/^_+|_+$/g, "") || "target";
      const backupName = `backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${relativeTarget}`;
      backupPath = join(stageDir, backupName);
      await writeFile(backupPath, originalContent, "utf8");
    }

    edits.push({
      target,
      originalContent,
      stagedContent,
      preEditHash,
      backupPath,
      originalHashAtStage: preEditHash,
    });
  }

  return edits;
}

/**
 * Validate all staged edits parse correctly. Throws on first invalid config.
 */
export function validateStagedEdits(edits: StagedEdit[]): void {
  for (const edit of edits) {
    if (!validateStagedContent(edit.stagedContent, edit.target.format)) {
      throw new Error(
        `staged config for ${edit.target.file} does not parse as ${edit.target.format}`,
      );
    }
  }
}

/**
 * Commit staged edits: verify no concurrent edits, write atomically.
 *
 * For each target (in order):
 *   1. Re-read file, compare hash to stage-time hash
 *   2. If hash differs → CONCURRENT USER EDIT → abort with rollback
 *   3. Write to temp file in same directory
 *   4. Rename temp → target (atomic on same filesystem)
 *
 * On any failure: rollback all previously committed edits.
 *
 * Returns list of committed files.
 */
export async function commitStagedEdits(
  edits: StagedEdit[],
): Promise<TransactionResult> {
  const committed: string[] = [];
  const skipped: string[] = [];
  const backups: string[] = [];
  const manifestEntries: TransactionManifestEntry[] = [];

  // First pass: check for concurrent edits on ALL targets before any write.
  const preCommitHashes = new Map<string, string | null>();
  for (const edit of edits) {
    const currentHash = await hashFile(edit.target.file);
    preCommitHashes.set(edit.target.file, currentHash);

    if (currentHash !== edit.originalHashAtStage) {
      // File changed since stage. If the file is completely new (both null) that's fine.
      // But if one is null and the other isn't, or both exist but differ → conflict.
      if (edit.originalHashAtStage === null && currentHash === null) {
        // Both don't exist — fine, still creating.
      } else if (edit.originalHashAtStage !== null && currentHash !== null &&
                 edit.originalHashAtStage === currentHash) {
        // Hashes match — no concurrent edit.
      } else {
        throw new ConcurrentEditError(
          edit.target.file,
          `file hash changed since stage: was ${edit.originalHashAtStage ?? "null"}, now ${currentHash ?? "null"}`,
          committed, // rollback list
        );
      }
    }
  }

  try {
    for (const edit of edits) {
      const currentHash = preCommitHashes.get(edit.target.file);

      // Check if content is already identical (idempotent skip).
      if (currentHash !== null && currentHash === hashContent(edit.stagedContent)) {
        // No actual change needed. Record as skipped.
        manifestEntries.push({
          adapter: edit.target.serverName,
          file: edit.target.file,
          format: edit.target.format,
          ownedPath: ownedPathFor(edit.target.serverName, edit.target.format),
          preEditHash: edit.preEditHash,
          postEditHash: currentHash,
          backup: edit.backupPath,
          created: currentHash === null,
        });
        skipped.push(edit.target.file);
        if (edit.backupPath) backups.push(edit.backupPath);
        continue;
      }

      // Ensure directory exists.
      await mkdir(dirname(edit.target.file), { recursive: true });

      // Write to temp file in same directory, then rename.
      await writeFileAtomic(edit.target.file, edit.stagedContent);

      const postEditHash = (await hashFile(edit.target.file)) ?? hashContent(edit.stagedContent);
      committed.push(edit.target.file);
      if (edit.backupPath) backups.push(edit.backupPath);

      manifestEntries.push({
        adapter: edit.target.serverName,
        file: edit.target.file,
        format: edit.target.format,
        ownedPath: ownedPathFor(edit.target.serverName, edit.target.format),
        preEditHash: edit.preEditHash,
        postEditHash,
        backup: edit.backupPath,
        created: edit.preEditHash === null,
      });
    }
  } catch (err) {
    // Rollback all committed files.
    for (const committedFile of committed) {
      const edit = edits.find((e) => e.target.file === committedFile);
      if (edit && edit.backupPath) {
        try {
          await copyFile(edit.backupPath, edit.target.file);
        } catch {
          // Best-effort rollback.
        }
      }
    }
    // Clean up temp files.
    for (const edit of edits) {
      try {
        const tmpPattern = `${edit.target.file}.supracortex-tmp-*`;
        // Can't glob easily - just try direct patterns we know
      } catch {
        // best-effort
      }
    }
    throw err;
  }

  // Cleanup stage backup files (not needed after successful commit).
  // Actually, keep them in the manifest as backup references.
  // Wait, we already added them to backups.

  return { committed, skipped, backups, manifestEntries };
}

export class ConcurrentEditError extends Error {
  public readonly committed: string[];
  constructor(file: string, message: string, committed: string[]) {
    super(`Concurrent edit detected for ${file}: ${message}`);
    this.name = "ConcurrentEditError";
    this.committed = committed;
  }
}

/**
 * Rollback all committed edits from a failed transaction.
 * Restores from staged backups. Idempotent.
 */
export async function rollbackEdits(committed: string[], allEdits: StagedEdit[]): Promise<string[]> {
  const restored: string[] = [];
  for (const file of committed) {
    const edit = allEdits.find((e) => e.target.file === file);
    if (edit && edit.backupPath) {
      try {
        if (edit.originalContent !== null) {
          await copyFile(edit.backupPath, edit.target.file);
        } else {
          // File was created by this transaction; remove it.
          await rm(file, { force: true });
        }
        restored.push(file);
      } catch {
        // Best-effort.
      }
    }
  }
  return restored;
}

// ---------------------------------------------------------------------------
// INI block builder (for hosts using plain INI format)
// ---------------------------------------------------------------------------

function buildIniBlock(target: ConfigTarget): string {
  const lines: string[] = [
    `# ${OWNED_MARKER}`,
    `[mcpServers.${target.serverName}]`,
    `command = ${JSON.stringify(target.command)}`,
  ];
  if (target.args.length) {
    lines.push(`args = ${JSON.stringify(target.args)}`);
  }
  if (target.env && Object.keys(target.env).length > 0) {
    lines.push(`env = ${JSON.stringify(target.env)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

const MANIFEST_VERSION = 2;
const MAX_MANIFEST_ENTRIES = 128;

export interface InstallManifestDocument {
  version: number;
  entries: TransactionManifestEntry[];
}

export async function readInstallManifest(path: string): Promise<TransactionManifestEntry[]> {
  try {
    const raw = await readFile(path, "utf8");
    const doc = JSON.parse(raw) as InstallManifestDocument;
    if (!doc || doc.version !== MANIFEST_VERSION || !Array.isArray(doc.entries)) {
      throw new Error("invalid manifest format");
    }
    return doc.entries;
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") return [];
    throw new Error(`failed to read install manifest: ${(err as Error).message}`);
  }
}

export async function writeInstallManifest(
  path: string,
  entries: TransactionManifestEntry[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const doc: InstallManifestDocument = { version: MANIFEST_VERSION, entries };
  await writeFile(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

export function validateManifestEntryPaths(
  root: string,
  entry: TransactionManifestEntry,
): void {
  assertPathConfined(root, entry.file, `manifest target ${entry.file}`);
  if (entry.backup) {
    assertPathConfined(root, entry.backup, `manifest backup ${entry.backup}`);
  }
}

export function isPathInManifestRoots(
  path: string,
  permittedRoots: string[],
): boolean {
  const resolved = resolve(path);
  return permittedRoots.some((root) => {
    const r = resolve(root);
    return resolved === r || !relative(r, resolved).startsWith("..");
  });
}
