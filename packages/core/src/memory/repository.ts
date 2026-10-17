/**
 * Memory persistence over a StorageAdapter.
 *
 * Durable memory is partitioned into kind-specific JSONL files so a team can
 * choose to commit only durable knowledge (facts/decisions/conventions/
 * constraints) while leaving volatile session data ignored by Git. Sessions
 * live under memory/sessions.
 */

import type { MemoryEntry, MemoryKind } from "../types.ts";
import type { HistoryManager, StorageAdapter } from "../storage/storage-adapter.ts";
import { isValidMemoryEntry } from "./schemas.ts";

/**
 * Ownership boundary: `tasks/completed.jsonl` belongs exclusively to the task
 * subsystem (Reconciler/Sweeper trimCompleted). Its rows are TaskOutcome
 * records, not MemoryEntry rows, so the memory repository must never read or
 * rewrite that file. A persisted outcome memory (kind "task-outcome") is a
 * MemoryEntry and lives with the other memory files in memory/outcomes.jsonl.
 */
const FILE_BY_KIND: Record<MemoryKind, string> = {
  fact: "memory/durable.jsonl",
  constraint: "memory/durable.jsonl",
  decision: "memory/decisions.jsonl",
  convention: "memory/conventions.jsonl",
  failure: "memory/failures.jsonl",
  "task-outcome": "memory/outcomes.jsonl",
};

const ALL_FILES = Array.from(new Set(Object.values(FILE_BY_KIND)));

export interface LoadResult {
  entries: MemoryEntry[];
  corruptLines: number;
}

/** Coded marker when the sidecar FTS path is missing/corrupt (mirrors manager + store). */
const FTS_MISSING = "FTS_MISSING";

/** Where a repository-level FTS lookup resolved. */
export type FtsSearchSource = "sidecar" | "legacy" | "like" | "none";

export class MemoryRepository {
  private store: StorageAdapter;
  /** Narrow history view: the repository only needs the HistoryManager log. */
  readonly history: HistoryManager;

  constructor(store: StorageAdapter) {
    this.store = store;
    this.history = store;
  }

  fileForKind(kind: MemoryKind): string {
    return FILE_BY_KIND[kind];
  }

  async append(entry: MemoryEntry): Promise<void> {
    await this.history.appendHistory(this.fileForKind(entry.kind), [entry]);
  }

  async loadAll(): Promise<LoadResult> {
    const seen = new Map<string, MemoryEntry>();
    let corruptLines = 0;
    for (const file of ALL_FILES) {
      const res = await this.history.readHistory<MemoryEntry>(file);
      corruptLines += res.corruptLines;
      for (const e of res.entries) {
        if (!isValidMemoryEntry(e)) {
          corruptLines++;
          continue;
        }
        // Last write wins (append-only log with in-place logical updates).
        seen.set(e.id, e);
      }
    }
    return { entries: Array.from(seen.values()), corruptLines };
  }

  async loadKind(kind: MemoryKind): Promise<MemoryEntry[]> {
    const res = await this.history.readHistory<MemoryEntry>(this.fileForKind(kind));
    return res.entries.filter(isValidMemoryEntry);
  }

  /**
   * Rewrite a memory file with a new set of entries (used by compaction and
   * status updates). Groups by file since multiple kinds may share a file.
   */
  async rewriteAll(entries: MemoryEntry[]): Promise<void> {
    const byFile = new Map<string, MemoryEntry[]>();
    for (const file of ALL_FILES) byFile.set(file, []);
    for (const e of entries) {
      const file = this.fileForKind(e.kind);
      const list = byFile.get(file);
      if (list) list.push(e);
    }
    for (const [file, list] of byFile) {
      await this.history.rewriteHistory(file, list);
    }
  }

  async count(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const file of ALL_FILES) {
      const res = await this.history.readHistory<MemoryEntry>(file);
      counts[file] = res.entries.length;
    }
    return counts;
  }

  /**
   * Triple-read FTS fallback shared by all search callers: sidecar
   * docs_fts first (weighted bm25, 5x LIMIT inside the store), then legacy
   * memory_fts (read-only), then a LIKE scan over the content mirror, then
   * none (caller uses pure lexical retrieval). Logs FTS_MISSING whenever
   * the sidecar path is unavailable. Never throws to the caller.
   */
  async searchFts(
    queryText: string,
    maxEntries: number,
  ): Promise<{ bm25?: Map<string, number>; source: FtsSearchSource }> {
    const topK = Math.max(1, maxEntries);
    if (this.store.ftsSidecarSearch) {
      try {
        const available = this.store.ftsSidecarAvailable
          ? await this.store.ftsSidecarAvailable()
          : true;
        if (available) {
          const rows = await this.store.ftsSidecarSearch(queryText, topK);
          if (rows.length > 0) {
            return { bm25: new Map(rows.map((r) => [r.docId, r.raw])), source: "sidecar" };
          }
        } else {
          console.warn(`[${FTS_MISSING}] sidecar unavailable; trying legacy memory_fts`);
        }
      } catch (err) {
        console.warn(`[${FTS_MISSING}] sidecar search failed, falling back: ${(err as Error)?.message ?? err}`);
      }
    }
    if (this.store.ftsSupported) {
      try {
        const supported = await this.store.ftsSupported();
        if (supported) {
          const candidateLimit = Math.max(topK * 4, 40);
          const ftsResults = await this.store.ftsSearch!(queryText, candidateLimit);
          if (ftsResults.length > 0) {
            return { bm25: new Map(ftsResults.map((r) => [r.entryId, r.bm25Score])), source: "legacy" };
          }
          if (this.store.ftsLikeFallback) {
            try {
              const fb = await this.store.ftsLikeFallback(queryText, topK);
              if (fb.length > 0) {
                return { bm25: new Map(fb.map((r) => [r.docId, 0])), source: "like" };
              }
            } catch (err) {
              console.warn(`[${FTS_MISSING}] LIKE fallback failed: ${(err as Error)?.message ?? err}`);
            }
            console.warn(`[${FTS_MISSING}] no FTS hits; lexical-only retrieval`);
          }
        }
      } catch (err) {
        console.warn(`[${FTS_MISSING}] legacy FTS check failed: ${(err as Error)?.message ?? err}`);
      }
    }
    return { source: "none" };
  }
}
