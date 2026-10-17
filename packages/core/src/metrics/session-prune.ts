/**
 * Session-metric retention pruning.
 *
 * Daily session snapshots (`metrics/session-YYYY-MM-DD.json`) are the only
 * uncapped store in the project. This module removes files older than
 * `retentionDays` so the metrics directory cannot grow without bound.
 *
 * Pruning is strictly best-effort: missing directory, unreadable entries and
 * per-file removal failures are tolerated and never throw. Only entries whose
 * filename exactly matches `session-YYYY-MM-DD.json` are ever considered for
 * removal, so unrelated files are never touched.
 */

import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const SESSION_FILE = /^session-(\d{4})-(\d{2})-(\d{2})\.json$/;

/** Default line-budget guard for session files (durable MEMORY.md is separate). */
export const MAX_LINES = 1000;

export interface PruneFs {
  readdir(dir: string): Promise<string[]>;
  /** Resolve whether a path is a symbolic link. Tolerant — failure means "not a regular file to remove". */
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  rm(path: string, opts: { force?: boolean }): Promise<void>;
}

export interface PruneResult {
  /** Names of files that were deleted. */
  deleted: string[];
  /** Session files examined (past retention boundary or not). */
  considered: number;
}

export interface PruneSessionMetricsOptions {
  /** Absolute path to the `metrics/` directory. */
  metricsDir: string;
  /** Days retained. 0 disables pruning (keep forever). Negative is guarded defensively. */
  retentionDays: number;
  /** Timestamp (ms) to treat as "now". Defaults to Date.now(). */
  now?: number;
  /** Optional debug logger. */
  logger?: { debug(msg: string): void };
  /** Injectable fs for tests. Defaults to node:fs/promises. */
  fs?: PruneFs;
  /**
   * Opt-in line-budget guard: after date pruning, keep at most `maxFiles`
   * session files, deleting oldest-by-timestamp first. Defaults to MAX_LINES.
   * Undefined/<=0 disables the budget (date pruning only).
   */
  maxFiles?: number;
}

export const defaultPruneFs: PruneFs = { readdir, rm, lstat };

/** Parse a session filename's date. Returns Date or null for any non-match. */
export function sessionFileDate(name: string): Date | null {
  const m = SESSION_FILE.exec(name);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Reject impossible dates (e.g. month 13) that Date.UTC would otherwise fold.
  if (
    date.getUTCFullYear() !== Number(m[1]) ||
    date.getUTCMonth() !== Number(m[2]) - 1 ||
    date.getUTCDate() !== Number(m[3])
  ) {
    return null;
  }
  return date;
}

/**
 * Prune session-metric files older than `retentionDays` from `metricsDir`.
 * Never throws. Returns the names of removed files and how many session files
 * were considered.
 */
export async function pruneSessionMetrics(opts: PruneSessionMetricsOptions): Promise<PruneResult> {
  const { metricsDir, retentionDays, now = Date.now(), logger } = opts;
  const fs = opts.fs ?? defaultPruneFs;
  const result: PruneResult = { deleted: [], considered: 0 };
  if (retentionDays <= 0 && !(opts.maxFiles !== undefined && opts.maxFiles > 0)) return result;

  let names: string[];
  try {
    names = await fs.readdir(metricsDir);
  } catch {
    logger?.debug(`session metrics prune: cannot list ${metricsDir}; skipping`);
    return result;
  }

  const cutoff = now - retentionDays * 86_400_000;
  const datePruneEnabled = retentionDays > 0;
  for (const name of names) {
    const date = sessionFileDate(name);
    if (!date) continue;
    result.considered++;
    if (datePruneEnabled && date.getTime() < cutoff) {
      const target = join(metricsDir, name);
      // Only ever remove a regular file. A matching dir name must be left
      // intact; failure to stat also means "do not remove" (best-effort).
      try {
        const st = await fs.lstat(target);
        if (!st.isFile() || st.isSymbolicLink()) continue;
      } catch {
        logger?.debug(`session metrics prune: cannot stat ${name}; skipping`);
        continue;
      }
      try {
        await fs.rm(target, { force: true });
        result.deleted.push(name);
      } catch {
        logger?.debug(`session metrics prune: failed to remove ${name}`);
      }
    }
  }

  // Line-budget guard: beyond `maxFiles`, delete oldest-by-timestamp first.
  // Date pruning above already removed expired files; this caps total count.
  const budget = opts.maxFiles !== undefined ? opts.maxFiles : undefined;
  if (budget !== undefined && budget > 0) {
    const survivors = names
      .map((name) => ({ name, date: sessionFileDate(name) }))
      .filter((x): x is { name: string; date: Date } => x.date !== null)
      .filter((x) => !result.deleted.includes(x.name))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    // `considered` counts session files examined across both passes.
    const overflow = survivors.length - budget;
    if (overflow > 0) {
      for (const victim of survivors.slice(0, overflow)) {
        const target = join(metricsDir, victim.name);
        try {
          const st = await fs.lstat(target);
          if (!st.isFile() || st.isSymbolicLink()) continue;
        } catch {
          logger?.debug(`session metrics prune: cannot stat ${victim.name}; skipping`);
          continue;
        }
        try {
          await fs.rm(target, { force: true });
          result.deleted.push(victim.name);
        } catch {
          logger?.debug(`session metrics prune: failed to remove ${victim.name}`);
        }
      }
    }
  }
  return result;
}

/**
 * Pure line-budget selection: given session filenames, return the oldest names
 * to delete so at most `maxFiles` remain (delete-by-timestamp, oldest first).
 */
export function selectBudgetOverflow(names: string[], maxFiles: number = MAX_LINES): string[] {
  const dated = names
    .map((name) => ({ name, date: sessionFileDate(name) }))
    .filter((x): x is { name: string; date: Date } => x.date !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const overflow = dated.length - maxFiles;
  if (overflow <= 0) return [];
  return dated.slice(0, overflow).map((x) => x.name);
}
