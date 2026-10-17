/**
 * Optional SQLite-backed StorageAdapter.
 *
 * JSONL is the default and the tested driver. SQLite is provided so teams with
 * measured concurrency/query needs can opt in via `storage.driver: "sqlite"`.
 *
 * The engine runs under two runtimes: Node (the CLI and the stdio MCP server)
 * and Bun (OpenCode's binary, which hosts the native plugin). Node exposes the
 * built-in `node:sqlite`; Bun intentionally does NOT implement `node:sqlite`
 * (oven-sh/bun#31402) and instead ships `bun:sqlite`. The two expose the same
 * small surface this adapter needs — `exec`, `prepare().run/get/all`, `close` —
 * so we load whichever exists at runtime and drive the same on-disk store. That
 * keeps ONE store identity across both hosts instead of forking JSONL vs SQLite.
 *
 * If neither module is available, construction throws a clear, actionable error
 * so the caller can fall back to JSONL rather than crashing.
 *
 * The adapter emulates the same JSON/JSONL surface:
 *  - JSON docs live in a `kv(path TEXT PRIMARY KEY, value TEXT)` table.
 *  - JSONL files live in `jsonl(path TEXT, seq INTEGER, value TEXT)` rows.
 * This keeps the StorageAdapter contract identical across drivers.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireFileLock } from "./file-lock.ts";
import type { JsonlAppendResult, JsonlReadResult, StorageAdapter } from "./storage-adapter.ts";

type SqliteStatement = {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
};
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

/**
 * Resolve a SQLite driver constructor for the CURRENT runtime.
 *   Node -> node:sqlite  DatabaseSync
 *   Bun  -> bun:sqlite   Database  (same subset: exec/prepare/run/get/all/close)
 * Both are imported dynamically and by a variable specifier so neither the Node
 * build nor the Bun build hard-fails on the other's module at load time, and no
 * bundler tries to resolve the foreign specifier.
 *
 * `Bun` exposes SQLite through its own native module, not `node:sqlite`.
 */
export async function loadSqliteDriver(): Promise<new (path: string) => SqliteDb> {
  const specs: Array<[string, string]> = [
    ["node:sqlite", "DatabaseSync"],
    ["bun:sqlite", "Database"],
  ];
  const failures: string[] = [];
  for (const [spec, exportName] of specs) {
    try {
      const mod = (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
      const Ctor = mod[exportName];
      if (typeof Ctor === "function") return Ctor as new (path: string) => SqliteDb;
    } catch (err) {
      failures.push(`${spec}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    "storage.driver is 'sqlite' but no SQLite runtime is available. " +
      "Need Node >= 22.5 (node:sqlite) or Bun (bun:sqlite); otherwise set storage.driver to 'jsonl'. " +
      `Tried ${failures.join("; ")}`,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Best-effort POSIX mode hardening. The store must not fail to construct because
 * a chmod is unsupported (e.g. a filesystem without POSIX modes) or because a
 * WAL sidecar disappeared between the pragma and this call.
 */
async function bestEffortChmod(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // Intentionally ignored: hardening is supplementary to store availability.
  }
}

/**
 * Open an existing SQLite database without creating or mutating anything.
 *
 * This is the diagnostics path (`status`/`doctor`): it must not mkdir, run DDL,
 * or set PRAGMAs. Node and Bun are tried in the same order as
 * `loadSqliteDriver`, with each runtime's read-only option spelling.
 *
 * Node's bundled SQLite creates `-wal`/`-shm` sidecars even for a read-only
 * handle when the database is in WAL mode. We avoid that by opening through an
 * `immutable=1` URI only when no WAL or rollback-journal sidecars already exist
 * (a cleanly closed WAL database has all committed data checkpointed). If
 * sidecars do exist, a normal read-only handle is required to see committed WAL
 * frames. Bun does not accept SQLite URIs, so it always opens the plain path.
 */
export async function openSqliteReadOnly(dbPath: string): Promise<SqliteDb> {
  const abs = resolve(dbPath);
  const failures: string[] = [];

  let nodeTarget = abs;
  try {
    const hasWal = await pathExists(`${abs}-wal`);
    const hasShm = await pathExists(`${abs}-shm`);
    const hasJournal = await pathExists(`${abs}-journal`);
    if (!hasWal && !hasShm && !hasJournal) nodeTarget = `${pathToFileURL(abs).href}?immutable=1`;
  } catch {
    nodeTarget = abs;
  }

  const attempts: Array<[string, string, string, Record<string, unknown>]> = [
    ["node:sqlite", "DatabaseSync", nodeTarget, { readOnly: true }],
    ["bun:sqlite", "Database", abs, { readonly: true }],
  ];
  for (const [spec, exportName, target, options] of attempts) {
    try {
      const mod = (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
      const Ctor = mod[exportName];
      if (typeof Ctor === "function") {
        return new (Ctor as new (path: string, opts: Record<string, unknown>) => SqliteDb)(target, options);
      }
      failures.push(`${spec}: ${exportName} is not a constructor`);
    } catch (err) {
      failures.push(`${spec}: ${(err as Error).message}`);
    }
  }

  throw new Error(
    `storage.driver is 'sqlite' but the store could not be opened read-only at ${abs}. ` +
      "Need Node >= 22.5 (node:sqlite) or Bun (bun:sqlite); otherwise set storage.driver to 'jsonl'. " +
      `Tried ${failures.join("; ")}`,
  );
}

export const FTS_MISSING_CODE = "FTS_MISSING";
export const FTS_BACKFILL_BATCH = 500;

export class FtsMissingError extends Error {
  readonly code = FTS_MISSING_CODE;
  constructor(message = "docs_fts unavailable; caller should full-scan + log") {
    super(message);
    this.name = "FtsMissingError";
  }
}

/**
 * Map free-form memory kinds to the sidecar CHECK constraint.
 * Memory domain kinds (fact/decision/...) → 'memory'; passthrough for
 * 'outcome'/'entity'; anything else folds to 'memory'.
 */
export function mapSidecarKind(kind: string): "memory" | "outcome" | "entity" {
  if (kind === "outcome" || kind === "entity") return kind;
  return "memory";
}

/**
 * 1c sidecar DDL. FTS ALTER is forbidden — future tokenizer/shape changes must
 * DROP docs_fts + triggers and rebuild via ftsBackfillSidecar (documented
 * rebuild-only pattern). JSONL stays the source of truth; content is a
 * rebuildable mirror. Never drop content/holdout on downgrade.
 */
export const FTS_SIDECAR_DDL = `
CREATE TABLE IF NOT EXISTS content(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('memory','outcome','entity')),
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_kind_time ON content(kind, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  text, kind, content='content', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS content_ai AFTER INSERT ON content BEGIN
  INSERT INTO docs_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
END;
CREATE TRIGGER IF NOT EXISTS content_ad AFTER DELETE ON content BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text, kind) VALUES ('delete', old.rowid, old.text, old.kind);
END;
CREATE TRIGGER IF NOT EXISTS content_au AFTER UPDATE ON content BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text, kind) VALUES ('delete', old.rowid, old.text, old.kind);
  INSERT INTO docs_fts(rowid, text, kind) VALUES (new.rowid, new.text, new.kind);
END;
CREATE TABLE IF NOT EXISTS holdout_version(version TEXT PRIMARY KEY, created_at TEXT NOT NULL, frozen INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS holdout_query(id TEXT PRIMARY KEY, version TEXT NOT NULL, query TEXT NOT NULL, top_k INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS holdout_label(query_id TEXT NOT NULL, doc_id TEXT NOT NULL, grade INTEGER NOT NULL, PRIMARY KEY(query_id, doc_id));
CREATE VIEW IF NOT EXISTS holdout_eval AS
  SELECT q.id AS query_id, q.version AS version, q.query AS query, q.top_k AS top_k, l.doc_id AS doc_id, l.grade AS grade
  FROM holdout_label l JOIN holdout_query q ON q.id = l.query_id;
`.trim();

export function ensureFtsSidecarSchema(db: {
  exec(sql: string): void;
}): void {
  try {
    db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;");
  } catch { /* best effort */ }
  try {
    db.exec(FTS_SIDECAR_DDL);
  } catch {
    // FTS5 may be absent; callers detect via ftsSidecarAvailable + FTS_MISSING.
  }
}

export function isFtsMissingError(err: unknown): boolean {
  return (
    err instanceof FtsMissingError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === FTS_MISSING_CODE)
  );
}

export async function createSqliteStore(
  root: string,
  opts: { readOnly?: boolean } = {},
): Promise<StorageAdapter> {
  const abs = resolve(root);
  const dbPath = join(abs, "state", "store.sqlite");

  let db: SqliteDb;
  if (opts.readOnly) {
    // Read-only is the diagnostics path: never create the root/database and
    // never run DDL or PRAGMAs. A missing store is reported as ENOENT so the
    // caller can fall back to filesystem evidence instead of opening an empty
    // database.
    try {
      await stat(dbPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const missing = new Error(`SQLite store does not exist: ${dbPath}`) as NodeJS.ErrnoException;
      missing.code = "ENOENT";
      throw missing;
    }
    db = await openSqliteReadOnly(dbPath);
  } else {
    const DatabaseSync = await loadSqliteDriver();
    const stateDir = join(abs, "state");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is filtered by the umask, so tighten a pre-existing or
    // unexpectedly permissive directory only when it grants group/other access.
    try {
      if ((await stat(stateDir)).mode & 0o077) await chmod(stateDir, 0o700);
    } catch {
      // Best-effort hardening; directory creation above still gates the store.
    }
    db = new DatabaseSync(dbPath);
    await bestEffortChmod(dbPath, 0o600);
    db.exec(
      "PRAGMA busy_timeout=5000;" +
        "PRAGMA journal_mode=WAL;" +
        "PRAGMA synchronous=NORMAL;" +
        "CREATE TABLE IF NOT EXISTS kv(path TEXT PRIMARY KEY, value TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS jsonl(path TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(path, seq));" +
        "CREATE INDEX IF NOT EXISTS jsonl_path ON jsonl(path, seq);",
    );
    ensureFtsSidecarSchema(db);
    // WAL/shm sidecars inherit umask-derived modes when SQLite creates them.
    await bestEffortChmod(`${dbPath}-wal`, 0o600);
    await bestEffortChmod(`${dbPath}-shm`, 0o600);
  }

  // Probe FTS5 availability. Node's bundled SQLite normally includes FTS5, but
  // we degrade gracefully if it is absent. A read-only SELECT is safe here.
  let supportsFts5 = false;
  try {
    db.exec("SELECT fts5_source_id()");
    supportsFts5 = true;
  } catch {
    supportsFts5 = false;
  }

  return new SqliteStore(abs, db, supportsFts5);
}

class SqliteStore implements StorageAdapter {
  readonly root: string;
  private db: SqliteDb;
  private closed = false;
  private fts5: boolean;

  // Prepared statements for FTS5 sync (initialized lazily).
  private ftsDelStmt?: ReturnType<SqliteDb["prepare"]>;
  private ftsInsStmt?: ReturnType<SqliteDb["prepare"]>;
  private ftsSearchStmt?: ReturnType<SqliteDb["prepare"]>;

  constructor(root: string, db: SqliteDb, supportsFts5: boolean) {
    this.root = root;
    this.db = db;
    this.fts5 = supportsFts5;
  }

  async ensureDir(_relDir: string): Promise<void> {
    // Tables are flat; directories are logical. Nothing to create.
  }

  async readJson<T>(relPath: string): Promise<T | null> {
    const row = this.db.prepare("SELECT value FROM kv WHERE path = ?").get(relPath) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    this.db
      .prepare("INSERT INTO kv(path, value) VALUES(?, ?) ON CONFLICT(path) DO UPDATE SET value=?")
      .run(relPath, JSON.stringify(value), JSON.stringify(value));
  }

  async appendJsonl(relPath: string, entries: unknown[]): Promise<JsonlAppendResult> {
    if (entries.length === 0) return { written: 0 };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const maxRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM jsonl WHERE path = ?").get(relPath) as { m: number };
      let seq = maxRow.m;
      const stmt = this.db.prepare("INSERT INTO jsonl(path, seq, value) VALUES(?, ?, ?)");
      for (const entry of entries) stmt.run(relPath, ++seq, JSON.stringify(entry));
      this.db.exec("COMMIT");
    } catch (cause) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw cause;
    }
    return { written: entries.length };
  }

  async readJsonl<T>(relPath: string): Promise<JsonlReadResult<T>> {
    const rows = this.db
      .prepare("SELECT value FROM jsonl WHERE path = ? ORDER BY seq ASC")
      .all(relPath) as Array<{ value: string }>;
    const entries: T[] = [];
    let corruptLines = 0;
    for (const r of rows) {
      try {
        entries.push(JSON.parse(r.value) as T);
      } catch {
        corruptLines++;
      }
    }
    return { entries, corruptLines };
  }

  async readJsonlTail<T>(relPath: string, limit: number): Promise<JsonlReadResult<T>> {
    if (!Number.isSafeInteger(limit) || limit < 1) return { entries: [], corruptLines: 0 };
    const rows = this.db
      .prepare("SELECT value FROM jsonl WHERE path = ? ORDER BY seq DESC LIMIT ?")
      .all(relPath, limit) as Array<{ value: string }>;
    const entries: T[] = [];
    let corruptLines = 0;
    for (const row of rows.reverse()) {
      try { entries.push(JSON.parse(row.value) as T); }
      catch { corruptLines++; }
    }
    return { entries, corruptLines };
  }

  async rewriteJsonl(relPath: string, entries: unknown[]): Promise<void> {
    // Delete/rewrite is one transaction: readers see either the old complete
    // sequence or the new complete sequence, never an empty/intermediate set.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM jsonl WHERE path = ?").run(relPath);
      const stmt = this.db.prepare("INSERT INTO jsonl(path, seq, value) VALUES(?, ?, ?)");
      let seq = 0;
      for (const entry of entries) stmt.run(relPath, ++seq, JSON.stringify(entry));
      this.db.exec("COMMIT");
    } catch (cause) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw cause;
    }
  }

  // HistoryManager: JSONL-swappable history log (delegates to the JSONL core).
  async appendHistory(relPath: string, entries: unknown[]): Promise<JsonlAppendResult> {
    return this.appendJsonl(relPath, entries);
  }

  async readHistory<T>(relPath: string): Promise<JsonlReadResult<T>> {
    return this.readJsonl<T>(relPath);
  }

  async rewriteHistory(relPath: string, entries: unknown[]): Promise<void> {
    return this.rewriteJsonl(relPath, entries);
  }

  async exists(relPath: string): Promise<boolean> {
    const kv = this.db.prepare("SELECT 1 FROM kv WHERE path = ? LIMIT 1").get(relPath);
    if (kv) return true;
    const jl = this.db.prepare("SELECT 1 FROM jsonl WHERE path = ? LIMIT 1").get(relPath);
    return Boolean(jl);
  }

  async remove(relPath: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE path = ?").run(relPath);
    this.db.prepare("DELETE FROM jsonl WHERE path = ?").run(relPath);
  }

  async listFiles(relDir: string): Promise<string[]> {
    const prefix = `${relDir.replace(/[\\/]+$/, "")}/`;
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db.prepare("SELECT path FROM kv WHERE path LIKE ? ESCAPE '\\' ORDER BY path ASC").all(`${escaped}%`) as Array<{ path: string }>;
    return rows
      .map((row) => row.path)
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
  }

  async totalSizeBytes(): Promise<number> {
    const row = this.db
      .prepare("SELECT SUM(LENGTH(value)) AS s FROM (SELECT value FROM kv UNION ALL SELECT value FROM jsonl)")
      .get() as { s: number | null };
    return row.s ?? 0;
  }

  async acquireLock(
    name: string,
    opts?: { staleMs?: number; retryMs?: number; timeoutMs?: number },
  ): Promise<() => Promise<void>> {
    const safeName = createHash("sha256").update(name).digest("hex").slice(0, 16);
    const lockDir = join(this.root, "state", `${safeName}.lock`);
    await mkdir(dirname(lockDir), { recursive: true });
    return acquireFileLock(lockDir, opts);
  }

  // ---------------------------------------------------------------------------
  // FTS5 full-text search
  // ---------------------------------------------------------------------------

  private ensureFtsTable(): void {
    if (!this.fts5) return;
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(" +
          "entry_id UNINDEXED, content, kind UNINDEXED, tags UNINDEXED, tokenize='porter unicode61'" +
          ")",
      );
    } catch {
      this.fts5 = false;
    }
  }

  async ftsSupported(): Promise<boolean> {
    return this.fts5;
  }

  async ftsRebuild(entries: Array<{ id: string; content: string; kind: string; tags: string[] }>): Promise<void> {
    if (!this.fts5) return;
    this.ensureFtsTable();
    try {
      this.db.exec("DELETE FROM memory_fts");
      if (entries.length === 0) return;
      const stmt = this.db.prepare("INSERT INTO memory_fts(entry_id, content, kind, tags) VALUES(?, ?, ?, ?)");
      for (const e of entries) {
        stmt.run(e.id, e.content, e.kind, e.tags.join(" "));
      }
    } catch {
      this.fts5 = false;
    }
  }

  async ftsSync(entry: { id: string; content: string; kind: string; tags: string[] }): Promise<void> {
    if (!this.fts5) return;
    this.ensureFtsTable();
    try {
      if (!this.ftsDelStmt) this.ftsDelStmt = this.db.prepare("DELETE FROM memory_fts WHERE entry_id = ?");
      if (!this.ftsInsStmt) this.ftsInsStmt = this.db.prepare("INSERT INTO memory_fts(entry_id, content, kind, tags) VALUES(?, ?, ?, ?)");
      this.ftsDelStmt.run(entry.id);
      this.ftsInsStmt.run(entry.id, entry.content, entry.kind, entry.tags.join(" "));
    } catch {
      this.fts5 = false;
    }
  }

  async ftsRemove(entryId: string): Promise<void> {
    if (!this.fts5) return;
    this.ensureFtsTable();
    try {
      if (!this.ftsDelStmt) this.ftsDelStmt = this.db.prepare("DELETE FROM memory_fts WHERE entry_id = ?");
      this.ftsDelStmt.run(entryId);
    } catch {
      this.fts5 = false;
    }
  }

  async ftsSearch(queryText: string, maxResults: number): Promise<Array<{ entryId: string; bm25Score: number }>> {
    if (!this.fts5) return [];
    this.ensureFtsTable();
    try {
      // Escape MATCH input: split into terms, strip embedded quotes, wrap each in
      // double quotes, join with OR. This prevents syntax errors from user-supplied
      // special characters (", *, :, AND, OR, NEAR, etc.).
      const terms = queryText
        .split(/\s+/)
        .map((t) => t.replace(/"/g, ""))
        .filter((t) => t.length > 0)
        .map((t) => `"${t}"`);
      if (terms.length === 0) return [];
      const safeQuery = terms.join(" OR ");

      if (!this.ftsSearchStmt) {
        this.ftsSearchStmt = this.db.prepare(
          "SELECT entry_id, bm25(memory_fts, 0, 1, 1, 1) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
        );
      }
      const rows = this.ftsSearchStmt.all(safeQuery, maxResults) as Array<{ entry_id: string; rank: number }>;
      return rows.map((r) => ({ entryId: r.entry_id, bm25Score: r.rank }));
    } catch {
      // On MATCH syntax error return empty without killing the index.
      // Only flip fts5=false on structural errors (e.g. "no such table").
      try {
        this.db.exec("SELECT 1 FROM memory_fts LIMIT 1");
      } catch {
        this.fts5 = false;
      }
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // 1c sidecar: content mirror + porter docs_fts + triggers + holdout
  // Raw passthrough: rank is negative bm25 (lower=better); normalization stays
  // in the caller (retrieval/ranking), never here.
  // ---------------------------------------------------------------------------

  private sidecarReady = false;
  private sidecarUpsertStmt?: ReturnType<SqliteDb["prepare"]>;
  private sidecarDeleteStmt?: ReturnType<SqliteDb["prepare"]>;
  private sidecarSearchStmt?: ReturnType<SqliteDb["prepare"]>;
  private likeFallbackStmt?: ReturnType<SqliteDb["prepare"]>;

  /** Idempotent DDL for migrations + lazy init. Rebuild-only for FTS changes. */
  async ensureFtsSidecar(): Promise<void> {
    ensureFtsSidecarSchema(this.db);
    this.sidecarReady = true;
    this.sidecarUpsertStmt = undefined;
    this.sidecarDeleteStmt = undefined;
    this.sidecarSearchStmt = undefined;
    this.likeFallbackStmt = undefined;
  }

  private lazySidecar(): void {
    if (!this.sidecarReady) {
      ensureFtsSidecarSchema(this.db);
      this.sidecarReady = true;
    }
  }

  private sidecarTableExists(name: string): boolean {
    try {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') AND name = ?")
        .get(name) as { name?: string } | undefined;
      return Boolean(row?.name);
    } catch {
      return false;
    }
  }

  async ftsSidecarAvailable(): Promise<boolean> {
    if (!this.fts5) return false;
    this.lazySidecar();
    return this.sidecarTableExists("docs_fts") && this.sidecarTableExists("content");
  }

  private assertSidecar(): void {
    this.lazySidecar();
    if (!this.fts5 || !this.sidecarTableExists("docs_fts") || !this.sidecarTableExists("content")) {
      throw new FtsMissingError();
    }
  }

  private stmts(): {
    upsert: ReturnType<SqliteDb["prepare"]>;
    del: ReturnType<SqliteDb["prepare"]>;
  } {
    if (!this.sidecarUpsertStmt) {
      this.sidecarUpsertStmt = this.db.prepare(
        "INSERT INTO content(id, kind, text, updated_at) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, text=excluded.text, updated_at=excluded.updated_at",
      );
    }
    if (!this.sidecarDeleteStmt) {
      this.sidecarDeleteStmt = this.db.prepare("DELETE FROM content WHERE id = ?");
    }
    return { upsert: this.sidecarUpsertStmt, del: this.sidecarDeleteStmt };
  }

  /** Single insert/upsert; triggers sync docs_fts. */
  async ftsSidecarInsert(entry: { id: string; kind: string; text: string; updatedAt?: string }): Promise<void> {
    this.assertSidecar();
    try {
      this.stmts().upsert.run(entry.id, mapSidecarKind(entry.kind), entry.text, entry.updatedAt ?? new Date().toISOString());
    } catch (err) {
      if (isFtsMissingError(err)) throw err;
      throw new FtsMissingError(`sidecar insert failed: ${(err as Error).message}`);
    }
  }

  async ftsSidecarRemove(id: string): Promise<void> {
    this.assertSidecar();
    try {
      this.stmts().del.run(id);
    } catch (err) {
      if (isFtsMissingError(err)) throw err;
      throw new FtsMissingError(`sidecar delete failed: ${(err as Error).message}`);
    }
  }

  /**
   * Backfill/rebuild the mirror from JSONL truth, batched 500/txn.
   * Crash-safe: DELETE + all batched INSERTs run inside ONE txn, so a crash
   * rolls back to the prior complete mirror — never an empty index. A
   * count check before COMMIT aborts the txn on partial writes.
   * Rebuildable: triggers keep docs_fts in sync with content.
   */
  async ftsBackfillSidecar(
    entries: Array<{ id: string; kind: string; text: string; updatedAt?: string }>,
    batchSize = FTS_BACKFILL_BATCH,
  ): Promise<{ written: number }> {
    this.assertSidecar();
    const batch = Math.max(1, Math.min(batchSize, 500));
    let written = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM content");
      const { upsert } = this.stmts();
      const now = new Date().toISOString();
      for (let i = 0; i < entries.length; i += batch) {
        const slice = entries.slice(i, i + batch);
        for (const e of slice) {
          upsert.run(e.id, mapSidecarKind(e.kind), e.text, e.updatedAt ?? now);
          written++;
        }
      }
      // Integrity check inside the txn: mirror count must match input.
      const n = (this.db.prepare("SELECT count(*) AS n FROM content").get() as { n: number }).n;
      if (n !== entries.length) {
        throw new Error(`sidecar backfill count mismatch: mirror=${n} expected=${entries.length}`);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      if (isFtsMissingError(err)) throw err;
      throw new FtsMissingError(`sidecar backfill failed: ${(err as Error).message}`);
    }
    // Post-commit integrity: COUNT match (mirror vs FTS) + spot MATCH probe.
    // Mirror is committed and non-empty here; a mismatch throws a coded error
    // so the caller falls back to legacy — never an empty index.
    try {
      const cc = (this.db.prepare("SELECT count(*) AS n FROM content").get() as { n: number }).n;
      const fc = (this.db.prepare("SELECT count(*) AS n FROM docs_fts").get() as { n: number }).n;
      if (cc !== entries.length || fc !== entries.length) {
        throw new FtsMissingError(
          `sidecar backfill post-commit mismatch: content=${cc} fts=${fc} expected=${entries.length}`,
        );
      }
      if (entries.length > 0) {
        const probe = this.escapeMatch(entries[0]!.text);
        if (probe) {
          this.db.prepare("SELECT count(*) AS n FROM docs_fts WHERE docs_fts MATCH ?").get(probe);
        }
      }
    } catch (err) {
      if (isFtsMissingError(err)) throw err;
      throw new FtsMissingError(`sidecar backfill post-commit check failed: ${(err as Error).message}`);
    }
    return { written };
  }

  /** Escape user text for MATCH: quote terms, join OR. */
  private escapeMatch(queryText: string): string | null {
    const terms = queryText
      .split(/\s+/)
      .map((t) => t.replace(/"/g, ""))
      .filter((t) => t.length > 0)
      .map((t) => `"${t}"`);
    if (terms.length === 0) return null;
    return terms.join(" OR ");
  }

  /**
   * Sidecar search: SELECT rowid + raw weighted bm25(3.0,1.0), LIMIT 5*top_k.
   * Throws FtsMissingError when docs_fts is missing/corrupt → caller full-scans.
   */
  async ftsSidecarSearch(
    queryText: string,
    topK: number,
  ): Promise<Array<{ rowid: number; docId: string; raw: number }>> {
    this.assertSidecar();
    const safe = this.escapeMatch(queryText);
    if (!safe) return [];
    const k = Math.max(1, Math.floor(topK));
    const limit = 5 * k;
    try {
      if (!this.sidecarSearchStmt) {
        this.sidecarSearchStmt = this.db.prepare(
          "SELECT docs_fts.rowid AS rowid, c.id AS docId, bm25(docs_fts, 3.0, 1.0) AS raw " +
            "FROM docs_fts JOIN content c ON c.rowid = docs_fts.rowid " +
            "WHERE docs_fts MATCH ? ORDER BY raw LIMIT ?",
        );
      }
      const rows = this.sidecarSearchStmt.all(safe, limit) as Array<{ rowid: number; docId: string; raw: number }>;
      return rows.map((r) => ({ rowid: r.rowid, docId: r.docId, raw: r.raw }));
    } catch (err) {
      // Distinguish corrupt/missing FTS (coded) from syntax issues (empty).
      try {
        this.db.exec("SELECT count(*) FROM docs_fts");
      } catch {
        throw new FtsMissingError(`docs_fts missing/corrupt: ${(err as Error).message}`);
      }
      // Table exists but MATCH failed (e.g. syntax): probe integrity once.
      if (!this.sidecarTableExists("docs_fts")) throw new FtsMissingError();
      return [];
    }
  }

  /** LIKE fallback over the content mirror when FTS is unavailable. */
  async ftsLikeFallback(queryText: string, limit: number): Promise<Array<{ docId: string; text: string }>> {
    this.lazySidecar();
    if (!this.sidecarTableExists("content")) throw new FtsMissingError();
    const like = `%${queryText.replace(/[%_\\]/g, (c) => `\\${c}`).slice(0, 200)}%`;
    if (!this.likeFallbackStmt) {
      this.likeFallbackStmt = this.db.prepare(
        "SELECT id AS docId, text FROM content WHERE text LIKE ? ESCAPE '\\' LIMIT ?",
      );
    }
    const rows = this.likeFallbackStmt.all(like, Math.max(1, limit)) as Array<{ docId: string; text: string }>;
    return rows;
  }

  async ftsIntegrityCheck(): Promise<{ ok: boolean; contentCount: number; ftsCount: number; integrity: string }> {
    this.lazySidecar();
    let integrity = "unknown";
    try {
      const row = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      integrity = (row?.integrity_check ?? "ok").toLowerCase();
    } catch {
      integrity = "error";
    }
    let contentCount = -1;
    let ftsCount = -1;
    try {
      contentCount = (this.db.prepare("SELECT count(*) AS n FROM content").get() as { n: number }).n;
    } catch { /* table missing */ }
    try {
      ftsCount = (this.db.prepare("SELECT count(*) AS n FROM docs_fts").get() as { n: number }).n;
    } catch { /* fts missing */ }
    const ok = integrity === "ok" && contentCount >= 0 && contentCount === ftsCount;
    return { ok, contentCount, ftsCount, integrity };
  }

  /**
   * Versioned holdout seed: INSERT-only (OR IGNORE), never UPDATE/DELETE so
   * runs are reproducible. Returns counts of queries/labels visible.
   */
  async ftsHoldoutSeed(
    version: string,
    queries: Array<{ id: string; query: string; topK: number; labels: Array<{ docId: string; grade: number }> }>,
  ): Promise<{ version: string; queries: number; labels: number }> {
    this.lazySidecar();
    if (!this.sidecarTableExists("holdout_query")) throw new FtsMissingError("holdout tables missing");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO holdout_version(version, created_at, frozen) VALUES(?, ?, 1)").run(version, now);
      const qStmt = this.db.prepare("INSERT OR IGNORE INTO holdout_query(id, version, query, top_k) VALUES(?, ?, ?, ?)");
      const lStmt = this.db.prepare("INSERT OR IGNORE INTO holdout_label(query_id, doc_id, grade) VALUES(?, ?, ?)");
      for (const q of queries) {
        qStmt.run(q.id, version, q.query, q.topK);
        for (const l of q.labels) lStmt.run(q.id, l.docId, l.grade);
      }
      this.db.exec("COMMIT");
    } catch (cause) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw cause;
    }
    const qn = (this.db.prepare("SELECT count(*) AS n FROM holdout_query WHERE version = ?").get(version) as { n: number }).n;
    const ln = (
      this.db
        .prepare("SELECT count(*) AS n FROM holdout_label WHERE query_id IN (SELECT id FROM holdout_query WHERE version = ?)")
        .get(version) as { n: number }
    ).n;
    return { version, queries: qn, labels: ln };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
