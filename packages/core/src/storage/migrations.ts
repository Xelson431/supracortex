/**
 * Storage schema migrations.
 *
 * The runtime directory carries a `state/version.json` file recording the
 * schema version it was written with. On startup the engine runs pending
 * migrations in order. Migrations must be idempotent and non-destructive.
 */

import type { StorageAdapter } from "./storage-adapter.ts";
import { STORAGE_SCHEMA_VERSION } from "../../../../src/version.ts";

export interface VersionFile {
  schemaVersion: number;
  pluginVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface Migration {
  to: number;
  describe: string;
  run(store: StorageAdapter): Promise<void>;
}

const VERSION_PATH = "state/version.json";
const VERSION_BACKUP_PATH = "state/version.pre-migration.json";
const MIGRATION_STATE_PATH = "state/migration.json";

/**
 * Ordered migrations. Each raises the on-disk schema to `to`. Version 1 is the
 * initial layout, so there is nothing to migrate to reach it beyond writing the
 * version file.
 */
export const MIGRATIONS: Migration[] = [
  {
    to: 2,
    describe: "activate independently versioned storage namespaces",
    run: async (store) => {
      for (const dir of ["state", "memory", "cache", "index", "tasks", "metrics", "events"]) {
        await store.ensureDir(dir);
      }
    },
  },
  {
    to: 3,
    describe: "create FTS5 full-text search index for memory",
    run: async (store) => {
      // FTS5 is SQLite-only; jsonl store silently no-ops.
      if (store.ftsRebuild) {
        // Load all existing memory entries and rebuild FTS index.
        // We read from JSONL files directly — the store adapter handles this.
        const kinds = ["memory/durable.jsonl", "memory/decisions.jsonl", "memory/conventions.jsonl", "memory/failures.jsonl", "memory/outcomes.jsonl"];
        const all: Array<{ id: string; content: string; kind: string; tags: string[] }> = [];
        for (const file of kinds) {
          try {
            const res = await store.readJsonl<{ id: string; content: string; kind: string; tags?: string[] }>(file);
            for (const entry of res.entries) {
              if (entry && entry.id && entry.content) {
                all.push({ id: entry.id, content: entry.content, kind: entry.kind ?? "fact", tags: entry.tags ?? [] });
              }
            }
          } catch {
            // File may not exist yet
          }
        }
        await store.ftsRebuild(all);
      }
    },
  },
  {
    to: 4,
    describe: "create 1c FTS5 sidecar: content mirror + porter docs_fts + triggers + idx (rebuild-only)",
    run: async (store) => {
      const s = store as unknown as {
        ensureFtsSidecar?: () => Promise<void>;
        ftsBackfillSidecar?: (entries: Array<{ id: string; kind: string; text: string }>) => Promise<unknown>;
      };
      if (s.ensureFtsSidecar) await s.ensureFtsSidecar();
      if (s.ftsBackfillSidecar) {
        const kinds = ["memory/durable.jsonl", "memory/decisions.jsonl", "memory/conventions.jsonl", "memory/failures.jsonl", "memory/outcomes.jsonl"];
        const all: Array<{ id: string; kind: string; text: string }> = [];
        for (const file of kinds) {
          try {
            const res = await store.readJsonl<{ id: string; content: string; kind: string }>(file);
            for (const entry of res.entries) {
              if (entry && entry.id && entry.content) {
                all.push({ id: entry.id, kind: entry.kind ?? "fact", text: entry.content });
              }
            }
          } catch {
            // File may not exist yet
          }
        }
        await s.ftsBackfillSidecar(all);
      }
    },
  },
  {
    to: 5,
    describe: "create frozen holdout tables + eval view (read-only, insert-only seed)",
    run: async (store) => {
      const s = store as unknown as { ensureFtsSidecar?: () => Promise<void> };
      if (s.ensureFtsSidecar) await s.ensureFtsSidecar();
    },
  },
];

export async function readVersion(store: StorageAdapter): Promise<VersionFile | null> {
  return store.readJson<VersionFile>(VERSION_PATH);
}

export async function ensureVersion(
  store: StorageAdapter,
  pluginVersion: string,
): Promise<VersionFile> {
  const existing = await readVersion(store);
  if (existing) {
    if (!Number.isInteger(existing.schemaVersion) || existing.schemaVersion < 1) {
      throw new Error("Invalid storage schema version");
    }
    return existing;
  }
  const now = new Date().toISOString();
  const vf: VersionFile = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    pluginVersion,
    createdAt: now,
    updatedAt: now,
  };
  await store.ensureDir("state");
  await store.writeJson(VERSION_PATH, vf);
  return vf;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

export async function runMigrations(
  store: StorageAdapter,
  pluginVersion: string,
): Promise<MigrationResult> {
  const vf = await ensureVersion(store, pluginVersion);
  const from = vf.schemaVersion;
  if (from > STORAGE_SCHEMA_VERSION) {
    throw new Error(
      `Storage schema ${from} is newer than supported schema ${STORAGE_SCHEMA_VERSION}; refusing downgrade`,
    );
  }
  const applied: number[] = [];
  const pending = MIGRATIONS
    .filter((m) => m.to > from && m.to <= STORAGE_SCHEMA_VERSION)
    .sort((a, b) => a.to - b.to);
  if (pending.length) await store.writeJson(VERSION_BACKUP_PATH, vf);
  let current = vf;
  for (const m of pending) {
    await store.writeJson(MIGRATION_STATE_PATH, {
      from: current.schemaVersion,
      to: m.to,
      description: m.describe,
      status: "started",
      updatedAt: new Date().toISOString(),
    });
    await m.run(store);
    current = {
      ...current,
      schemaVersion: m.to,
      pluginVersion,
      updatedAt: new Date().toISOString(),
    };
    await store.writeJson(VERSION_PATH, current);
    await store.writeJson(MIGRATION_STATE_PATH, {
      from: vf.schemaVersion,
      to: m.to,
      description: m.describe,
      status: "completed",
      updatedAt: current.updatedAt,
    });
    applied.push(m.to);
  }
  const target = Math.max(STORAGE_SCHEMA_VERSION, ...MIGRATIONS.map((m) => m.to), from);
  if (target !== from || vf.pluginVersion !== pluginVersion) {
    await store.writeJson(VERSION_PATH, {
      ...current,
      schemaVersion: target,
      pluginVersion,
      updatedAt: new Date().toISOString(),
    });
  }
  return { from, to: target, applied };
}
