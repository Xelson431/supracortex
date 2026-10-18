/**
 * One-shot JSONL-filesystem -> SQLite migration for a storage root.
 *
 * Both drivers address the same logical paths (`events/events.jsonl`,
 * `state/version.json`, ...), so migration is a content copy through the
 * StorageAdapter interface: every `.json`/`.jsonl` file under the root is
 * read via JsonlStore and written into the SQLite store at the same relPath.
 *
 * Safety rules:
 * - The SQLite database itself (`state/store.sqlite*`) is never copied.
 * - Advisory-lock directories (`*.lock/`, live `owner.json` guards) are skipped.
 * - Non-JSON files (`.log`, `.gitignore`, `config.jsonc`, ...) are skipped.
 * - Idempotent: a logical path that already holds data in SQLite is skipped
 *   (for JSONL, only the missing tail is appended, so an interrupted run can
 *   resume without duplicating rows). SQLite content always wins over the
 *   older filesystem copy on conflict.
 * - Corrupt JSONL lines cannot be recovered; they are counted and reported.
 */

import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { JsonlStore } from "./jsonl-store.ts";
import { createSqliteStore } from "./sqlite-store.ts";

export interface MigrateResult {
  /** `.json` docs copied. */
  jsonCopied: number;
  /** `.jsonl` rows copied. */
  jsonlEntriesCopied: number;
  /** Logical paths skipped because SQLite already held data. */
  skipped: string[];
  /** Unparseable JSONL lines left behind (counted, not copied). */
  corruptLines: number;
  /** Logical paths copied in this run. */
  filesCopied: string[];
}

const SQLITE_PREFIX = "state/store.sqlite";
const DRY_RUN_LIMIT_ENTRIES = 0;

async function collectSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const abs = join(dir, name);
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (name.endsWith(".lock")) continue;
        await visit(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      // Store-facing logical keys are POSIX-separated on every platform (the
      // SQLite driver and all readers use `events/events.jsonl`). `relative`
      // yields `events\events.jsonl` on Windows, so normalize before use.
      const rel = relative(root, abs).split(sep).join("/");
      if (rel === SQLITE_PREFIX || rel.startsWith(`${SQLITE_PREFIX}-`)) continue;
      if (name.endsWith(".json")) out.push(rel);
      else if (name.endsWith(".jsonl")) out.push(rel);
    }
  }
  await visit(root);
  return out;
}

export async function migrateJsonlToSqlite(
  root: string,
  opts: { dryRun?: boolean } = {},
): Promise<MigrateResult> {
  const result: MigrateResult = {
    jsonCopied: 0,
    jsonlEntriesCopied: 0,
    skipped: [],
    corruptLines: 0,
    filesCopied: [],
  };
  const source = new JsonlStore(root);
  const files = await collectSourceFiles(source.root);
  if (opts.dryRun) {
    // Report what would be copied without creating the SQLite database.
    for (const rel of files) {
      if (rel.endsWith(".json")) {
        if ((await source.readJson(rel)) !== null) result.filesCopied.push(rel);
      } else {
        const read = await source.readJsonl<unknown>(rel);
        result.corruptLines += read.corruptLines;
        if (read.entries.length > DRY_RUN_LIMIT_ENTRIES) result.filesCopied.push(rel);
      }
    }
    await source.close();
    return result;
  }
  const dest = await createSqliteStore(source.root);
  try {
    for (const rel of files) {
      if (rel.endsWith(".json")) {
        if ((await dest.readJson(rel)) !== null) {
          result.skipped.push(rel);
          continue;
        }
        const value = await source.readJson(rel);
        if (value === null) continue;
        await dest.writeJson(rel, value);
        result.jsonCopied++;
        result.filesCopied.push(rel);
      } else {
        const existing = await dest.readJsonl<unknown>(rel);
        const read = await source.readJsonl<unknown>(rel);
        result.corruptLines += read.corruptLines;
        if (existing.entries.length === 0) {
          if (read.entries.length === 0) {
            result.skipped.push(rel);
            continue;
          }
          await dest.appendJsonl(rel, read.entries);
          result.jsonlEntriesCopied += read.entries.length;
          result.filesCopied.push(rel);
          continue;
        }
        // Destination already holds post-flip writes: merge any source rows
        // missing there, keeping the older filesystem rows first so history
        // stays chronological. Row-equality dedup keeps re-runs idempotent.
        const present = new Set(existing.entries.map((entry) => JSON.stringify(entry)));
        const missing = read.entries.filter((entry) => !present.has(JSON.stringify(entry)));
        if (missing.length === 0) {
          result.skipped.push(rel);
          continue;
        }
        await dest.rewriteHistory(rel, [...missing, ...existing.entries]);
        result.jsonlEntriesCopied += missing.length;
        result.filesCopied.push(rel);
      }
    }
  } finally {
    await dest.close();
    await source.close();
  }
  return result;
}
