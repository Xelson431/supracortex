/**
 * Storage adapter interface. Implementations must provide atomic-ish writes and
 * corrupt-line tolerance. The core depends only on this interface so the driver
 * (jsonl now, sqlite later) can be swapped without rewrites.
 */

export interface JsonlAppendResult {
  written: number;
}

export interface JsonlReadResult<T> {
  entries: T[];
  corruptLines: number;
}

/**
 * HistoryManager: swappable history-log interface over append-only JSONL
 * history files. The JSONL drivers (filesystem + sqlite) implement this core;
 * the FTS sidecar only indexes ranked content and never owns history writes.
 * StorageAdapter extends it so callers can depend on the narrow interface.
 */
export interface HistoryManager {
  /** Append history rows to a logical JSONL log. */
  appendHistory(relPath: string, entries: unknown[]): Promise<JsonlAppendResult>;
  /** Read all history rows from a logical JSONL log. */
  readHistory<T>(relPath: string): Promise<JsonlReadResult<T>>;
  /** Atomically replace a logical JSONL log. */
  rewriteHistory(relPath: string, entries: unknown[]): Promise<void>;
}

export interface StorageAdapter extends HistoryManager {
  /** Absolute root directory this adapter writes under. */
  readonly root: string;

  ensureDir(relDir: string): Promise<void>;

  readJson<T>(relPath: string): Promise<T | null>;
  writeJson(relPath: string, value: unknown): Promise<void>;

  appendJsonl(relPath: string, entries: unknown[]): Promise<JsonlAppendResult>;
  readJsonl<T>(relPath: string): Promise<JsonlReadResult<T>>;
  /** Read at most the newest `limit` valid/invalid JSONL rows in original order. */
  readJsonlTail<T>(relPath: string, limit: number): Promise<JsonlReadResult<T>>;
  /** Rewrite a jsonl file atomically with the provided entries. */
  rewriteJsonl(relPath: string, entries: unknown[]): Promise<void>;

  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>;
  /** List direct regular-file children beneath a logical directory. */
  listFiles(relDir: string): Promise<string[]>;
  /** Total size in bytes of everything under the storage root. */
  totalSizeBytes(): Promise<number>;

  /** Acquire a best-effort advisory lock. Returns a release function. */
  acquireLock(
    name: string,
    opts?: { staleMs?: number; retryMs?: number; timeoutMs?: number },
  ): Promise<() => Promise<void>>;

  /** Release handles held by the backend. Safe to call more than once. */
  close(): Promise<void>;

  // ---------------------------------------------------------------------------
  // Optional FTS5 full-text search (SQLite driver only).
  // ---------------------------------------------------------------------------

  /** Whether the backend supports FTS5 full-text search. */
  ftsSupported?(): Promise<boolean>;

  /** Rebuild the FTS index from all entries. */
  ftsRebuild?(entries: Array<{ id: string; content: string; kind: string; tags: string[] }>): Promise<void>;

  /** Insert or update a single entry in the FTS index. */
  ftsSync?(entry: { id: string; content: string; kind: string; tags: string[] }): Promise<void>;

  /** Remove a single entry from the FTS index. */
  ftsRemove?(entryId: string): Promise<void>;

  /**
   * Full-text search returning matching entry IDs and raw BM25 scores.
   * Lower BM25 score = better match. Results sorted by BM25 ascending.
   */
  ftsSearch?(queryText: string, maxResults: number): Promise<Array<{ entryId: string; bm25Score: number }>>;

  // ---------------------------------------------------------------------------
  // Optional 1c sidecar: rebuildable content mirror + porter docs_fts.
  // JSONL stays the source of truth; the sidecar never owns history writes.
  // Legacy memory_fts is retained as a read-only fallback until the sidecar
  // path is verified live. All methods are optional (SQLite driver only).
  // ---------------------------------------------------------------------------

  /** Idempotent sidecar DDL (content + docs_fts + triggers + holdout). */
  ensureFtsSidecar?(): Promise<void>;
  /** True when docs_fts + content exist and FTS5 is available. */
  ftsSidecarAvailable?(): Promise<boolean>;
  /** Single upsert into the content mirror (triggers sync docs_fts). */
  ftsSidecarInsert?(entry: { id: string; kind: string; text: string; updatedAt?: string }): Promise<void>;
  /** Single delete from the content mirror (triggers sync docs_fts). */
  ftsSidecarRemove?(id: string): Promise<void>;
  /** Crash-safe rebuild from JSONL truth (single txn; rollback never empty). */
  ftsBackfillSidecar?(
    entries: Array<{ id: string; kind: string; text: string; updatedAt?: string }>,
    batchSize?: number,
  ): Promise<{ written: number }>;
  /**
   * Weighted sidecar search (raw bm25, lower=better, LIMIT 5x topK).
   * Throws coded FTS_MISSING when docs_fts is missing/corrupt.
   */
  ftsSidecarSearch?(
    queryText: string,
    topK: number,
  ): Promise<Array<{ rowid: number; docId: string; raw: number }>>;
  /** LIKE scan over the content mirror when FTS is unavailable. */
  ftsLikeFallback?(queryText: string, limit: number): Promise<Array<{ docId: string; text: string }>>;
  /** Post-backfill integrity evidence (mirror vs FTS counts). */
  ftsIntegrityCheck?(): Promise<{ ok: boolean; contentCount: number; ftsCount: number; integrity: string }>;
}
