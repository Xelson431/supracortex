/**
 * Local summary cache.
 *
 * IMPORTANT: this is a LOCAL cache of deterministic file summaries keyed by
 * source content hash. It is NOT provider-level prompt caching. We never label
 * these as provider/Anthropic cache hits. Provider prompt caching is out of
 * scope for v1 because it cannot be verified through the current OpenCode API.
 *
 * Entries persist under `.supracortex/cache/summaries.jsonl`.
 */

import type { FileSummary, IndexedFile } from "../types.ts";
import type { StorageAdapter } from "../storage/storage-adapter.ts";

const CACHE_FILE = "cache/summaries.jsonl";

interface CacheRecord extends FileSummary {
  cachedAt: string;
}

export class ContextCache {
  private store: StorageAdapter;
  private now: () => number;

  constructor(store: StorageAdapter, now: () => number = () => Date.now()) {
    this.store = store;
    this.now = now;
  }

  /**
   * Read the current committed generation from the backend.
   *
   * Cache instances deliberately do not retain a process-local snapshot. The
   * storage adapter does not expose a portable file/database revision, so a
   * retained map could never be proven current after another live process
   * commits. Reading this disposable cache is cheaper than returning a stale
   * summary and gives JSONL and SQLite identical cross-instance semantics.
   */
  private async loadCurrent(): Promise<Map<string, CacheRecord>> {
    const res = await this.store.readJsonl<CacheRecord>(CACHE_FILE);
    const map = new Map<string, CacheRecord>();
    for (const r of res.entries) {
      if (isCacheRecord(r)) {
        map.set(r.path, r); // last write wins
      }
    }
    return map;
  }

  async get(path: string): Promise<CacheRecord | null> {
    const map = await this.loadCurrent();
    return map.get(path) ?? null;
  }

  /** Return a summary only if it matches the current source hash. */
  async getValid(file: IndexedFile): Promise<FileSummary | null> {
    const rec = await this.get(file.path);
    if (rec && rec.sourceHash === file.hash) return rec;
    return null;
  }

  async set(summary: FileSummary): Promise<void> {
    await this.setMany([summary]);
  }

  /**
   * Atomically merge a batch of summaries into the current cache generation.
   *
   * The complete batch is applied under one cross-process lock and persisted
   * with one atomic rewrite. Duplicate paths use array order (the final item
   * wins), matching duplicate-row recovery in {@link loadCurrent}. An empty
   * batch is a true no-op and does not acquire the lock or rewrite the file.
   */
  async setMany(summaries: readonly FileSummary[]): Promise<void> {
    if (summaries.length === 0) return;
    const release = await this.store.acquireLock("summary-cache");
    try {
      // The current generation must be read only after acquiring the lock;
      // otherwise two acknowledged batches can overwrite one another.
      const map = await this.loadCurrent();
      const cachedAt = new Date(this.now()).toISOString();
      for (const summary of summaries) {
        const rec: CacheRecord = { ...summary, cachedAt };
        if (!isCacheRecord(rec)) {
          throw new TypeError(`Invalid cache summary for ${String(summary.path)}`);
        }
        map.set(summary.path, rec);
      }
      await this.persist(map);
    } finally {
      await release();
    }
  }

  async all(): Promise<Record<string, FileSummary>> {
    const map = await this.loadCurrent();
    // Project-relative paths are untrusted object keys (a repository may
    // legitimately contain a file named `__proto__`). A null-prototype record
    // preserves every path without invoking Object.prototype setters.
    const out = Object.create(null) as Record<string, FileSummary>;
    for (const [path, rec] of map) out[path] = rec;
    return out;
  }

  async pruneByAge(maxAgeDays: number, now?: number): Promise<number> {
    const release = await this.store.acquireLock("summary-cache");
    try {
      const map = await this.loadCurrent();
      const cutoff = (now ?? this.now()) - maxAgeDays * 86_400_000;
      let removed = 0;
      for (const [path, rec] of map) {
        const cachedAt = Date.parse(rec.cachedAt);
        if (!Number.isFinite(cachedAt) || cachedAt < cutoff) {
          map.delete(path);
          removed++;
        }
      }
      if (removed) await this.persist(map);
      return removed;
    } finally {
      await release();
    }
  }

  /** Drop cache records whose source no longer exists or hash changed. */
  async invalidateAgainstIndex(index: Record<string, IndexedFile>): Promise<number> {
    const release = await this.store.acquireLock("summary-cache");
    try {
      const map = await this.loadCurrent();
      let removed = 0;
      for (const [path, rec] of map) {
        const cur = index[path];
        if (!cur || cur.hash !== rec.sourceHash) {
          map.delete(path);
          removed++;
        }
      }
      if (removed) await this.persist(map);
      return removed;
    } finally {
      await release();
    }
  }

  async size(): Promise<number> {
    return (await this.loadCurrent()).size;
  }

  async clear(): Promise<void> {
    const release = await this.store.acquireLock("summary-cache");
    try {
      await this.store.rewriteJsonl(CACHE_FILE, []);
    } finally {
      await release();
    }
  }

  private async persist(map: ReadonlyMap<string, CacheRecord>): Promise<void> {
    await this.store.rewriteJsonl(CACHE_FILE, Array.from(map.values()));
  }
}

function isCacheRecord(value: unknown): value is CacheRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CacheRecord>;
  return (
    typeof record.path === "string" &&
    record.path.length > 0 &&
    typeof record.sourceHash === "string" &&
    record.sourceHash.length > 0 &&
    typeof record.summary === "string" &&
    typeof record.estimatedTokens === "number" &&
    Number.isFinite(record.estimatedTokens) &&
    record.estimatedTokens >= 0 &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.cachedAt === "string" &&
    Number.isFinite(Date.parse(record.cachedAt))
  );
}
