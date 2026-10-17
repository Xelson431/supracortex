import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore, JsonlStore } from "../../packages/core/src/index.ts";
import { status } from "../../packages/opencode/src/cli-core.ts";
import { createMcpServer } from "../../src/mcp.ts";

/** Run `fn` with isolated host/storage env, restoring it afterwards. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function isolatedEnv(scratch: string): Record<string, string | undefined> {
  return {
    HOME: join(scratch, "home"),
    XDG_CONFIG_HOME: join(scratch, "xdg"),
    SUPRACODE_HOME: join(scratch, "supracode"),
    SUPRACODE_REAL_XDG_CONFIG_HOME: undefined,
  };
}

async function project(t: { after(fn: () => Promise<void>): void }, config: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sc-status-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(join(root, ".supracortex", "config.jsonc"), JSON.stringify(config), "utf8");
  return root;
}

const sweep = "2026-10-17T00:00:00.000Z";
const injection = "2026-10-17T01:00:00.000Z";

/** Structurally valid MemoryEntry (core validation accepts this shape). */
function memoryEntry(id: string, status: string, content: string) {
  const ts = "2026-10-17T00:00:00.000Z";
  return {
    id,
    kind: "fact",
    content,
    createdAt: ts,
    updatedAt: ts,
    confidence: 0.9,
    status,
    sourceReferences: [],
    relatedFiles: [],
    relatedSymbols: [],
    tags: [],
    invalidationRules: [],
  };
}

test("status reads memory and health through the SQLite adapter", async (t) => {
  const root = await project(t, { storage: { driver: "sqlite" } });
  const storage = join(root, ".supracortex");

  let store: Awaited<ReturnType<typeof createSqliteStore>>;
  try {
    store = await createSqliteStore(storage);
  } catch {
    // node:sqlite unavailable in this runtime; nothing to assert.
    return;
  }
  await store.appendJsonl("memory/durable.jsonl", [
    { id: "m1", kind: "fact", content: "one" },
    { id: "m2", kind: "fact", content: "two" },
  ]);
  await store.appendJsonl("cache/summaries.jsonl", [{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
  await store.writeJson("tasks/active.json", { tasks: [{ id: "t1" }, { id: "t2" }] });
  await store.writeJson("index/repository.json", { generatedAt: "2026-10-16T00:00:00.000Z" });
  await store.writeJson("state/health.json", {
    version: "test",
    schemaVersion: 1,
    updatedAt: sweep,
    lastSweepAt: sweep,
    lastInjectionAt: injection,
  });
  await store.close();

  // The adapter is the only writer: no logical log or health mirror on disk.
  await assert.rejects(access(join(storage, "memory", "durable.jsonl")));
  await assert.rejects(access(join(storage, "state", "health.json")));

  const report = await status(root);
  assert.equal(report.memoryCounts["memory/durable.jsonl"], 2);
  assert.equal(report.memoryCounts["memory/decisions.jsonl"], 0);
  assert.equal(report.cacheEntries, 3);
  assert.equal(report.activeTasks, 2);
  assert.equal(report.indexFreshness, "2026-10-16T00:00:00.000Z");
  assert.equal(report.lastSweepAt, sweep);
  assert.equal(report.lastInjectionAt, injection);
  assert.equal(report.lastError, null);
});

test("status reports deduped logical memory alongside raw JSONL line counts", async (t) => {
  const root = await project(t, { storage: { driver: "jsonl" } });
  const storage = join(root, ".supracortex");

  const store = new JsonlStore(storage);
  // Same logical entry appended twice: the second row is a correction (status
  // change). Raw line counts see 3; the logical view sees 2 unique ids.
  await store.appendJsonl("memory/durable.jsonl", [
    memoryEntry("m1", "candidate", "first draft"),
    memoryEntry("m2", "stale", "needs reverify"),
  ]);
  await store.appendJsonl("memory/durable.jsonl", [memoryEntry("m1", "active", "corrected")]);

  const report = await status(root);
  assert.equal(report.memoryCounts["memory/durable.jsonl"], 3);
  assert.equal(report.memoryEntries.total, 2);
  assert.deepEqual(report.memoryEntries.byStatus, { active: 1, stale: 1 });
  assert.equal(report.lastError, null);
});

test("status reports deduped logical memory through the SQLite adapter", async (t) => {
  const root = await project(t, { storage: { driver: "sqlite" } });
  const storage = join(root, ".supracortex");

  let store: Awaited<ReturnType<typeof createSqliteStore>>;
  try {
    store = await createSqliteStore(storage);
  } catch {
    // node:sqlite unavailable in this runtime; nothing to assert.
    return;
  }
  await store.appendJsonl("memory/durable.jsonl", [
    memoryEntry("m1", "candidate", "first draft"),
    memoryEntry("m2", "stale", "needs reverify"),
  ]);
  await store.appendJsonl("memory/durable.jsonl", [memoryEntry("m1", "active", "corrected")]);
  await store.close();

  const report = await status(root);
  assert.equal(report.memoryCounts["memory/durable.jsonl"], 3);
  assert.equal(report.memoryEntries.total, 2);
  assert.deepEqual(report.memoryEntries.byStatus, { active: 1, stale: 1 });
  assert.equal(report.lastError, null);
});

test("status reports zero logical memory for empty or missing storage without adding an error", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "sc-status-empty-home-"));
  const missingRoot = await mkdtemp(join(tmpdir(), "sc-status-missing-"));
  t.after(async () => {
    await rm(scratch, { recursive: true, force: true });
    await rm(missingRoot, { recursive: true, force: true });
  });

  await withEnv(isolatedEnv(scratch), async () => {
    // No .supracortex at all: status must not create storage.
    const missing = await status(missingRoot);
    assert.deepEqual(missing.memoryEntries, { total: 0, byStatus: {} });
    assert.equal(missing.lastError, null);

    // Configured project with an empty storage root (config exists, no logs).
    const root = await project(t, { storage: { driver: "jsonl" } });
    const empty = await status(root);
    assert.deepEqual(empty.memoryEntries, { total: 0, byStatus: {} });
    assert.equal(empty.lastError, null);
  });
});

test("status is read-only in a fresh project (no storage created)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sc-status-fresh-"));
  const scratch = await mkdtemp(join(tmpdir(), "sc-status-fresh-home-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  await withEnv(isolatedEnv(scratch), async () => {
    const report = await status(root);
    assert.equal(report.lastError, null);
    await assert.rejects(access(join(root, ".supracortex")), "status must not create storage");
  });
});

test("status reports corrupt JSON documents instead of swallowing them", async (t) => {
  const root = await project(t, { storage: { driver: "jsonl" } });
  const scratch = await mkdtemp(join(tmpdir(), "sc-status-corrupt-home-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const storage = join(root, ".supracortex");

  // The adapter owns the document path; then corrupt it on disk.
  const store = new JsonlStore(storage);
  await store.writeJson("state/health.json", { version: "test", schemaVersion: 1, updatedAt: sweep });
  await writeFile(join(storage, "state", "health.json"), "{ this is not json", "utf8");

  await withEnv(isolatedEnv(scratch), async () => {
    const report = await status(root);
    assert.match(report.lastError ?? "", /storage corrupt \(state\/health\.json\)/);
  });
});

test("status reads an existing SQLite project without creating or migrating state", async (t) => {
  const root = await project(t, { storage: { driver: "sqlite" } });
  const storage = join(root, ".supracortex");

  let store: Awaited<ReturnType<typeof createSqliteStore>>;
  try {
    store = await createSqliteStore(storage);
  } catch {
    // node:sqlite unavailable in this runtime; nothing to assert.
    return;
  }
  await store.appendJsonl("memory/durable.jsonl", [{ id: "m1" }, { id: "m2" }]);
  await store.appendJsonl("cache/summaries.jsonl", [{ id: "c1" }]);
  await store.writeJson("tasks/active.json", { tasks: [{ id: "t1" }] });
  await store.close();

  const before = await access(join(storage, "state", "store.sqlite")).then(() => true, () => false);
  assert.equal(before, true);
  const stateBefore = (await readdir(join(storage, "state"))).sort();
  const report = await status(root);
  assert.equal(report.memoryCounts["memory/durable.jsonl"], 2);
  assert.equal(report.cacheEntries, 1);
  assert.equal(report.activeTasks, 1);
  assert.equal(report.lastError, null);

  // Read-only SQLite open: no WAL/SHM sidecars may be created by status.
  const stateAfter = (await readdir(join(storage, "state"))).sort();
  const created = stateAfter.filter((name) => !stateBefore.includes(name));
  assert.deepEqual(created.filter((name) => name.endsWith("-wal") || name.endsWith("-shm")), []);
  assert.deepEqual(stateAfter, stateBefore);
});

test("status refuses a symlinked storage root (no purge, no store, no outside writes)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sc-status-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "sc-status-outside-"));
  const scratch = await mkdtemp(join(tmpdir(), "sc-status-symlink-home-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  await mkdir(join(outside, "state"), { recursive: true });
  const mirror = join(outside, "state", "injection.json");
  // JSON.stringify emits the six-character `\u0000` escape: a legacy
  // prompt-bearing mirror that sanitizeLegacyInjectionMirror would purge.
  await writeFile(mirror, JSON.stringify({ lastInjectionAt: injection, requestId: "session\u0000query" }), "utf8");
  assert.match(await readFile(mirror, "utf8"), /\\u0000/);
  await symlink(outside, join(root, ".supracortex"));

  await withEnv(isolatedEnv(scratch), async () => {
    const report = await status(root);
    assert.match(report.lastError ?? "", /containment|outside.*project|project.*outside|symlink/i);
  });

  // The legacy mirror must survive (no purge through the symlink) and no
  // runtime .gitignore may be written into the external directory.
  assert.match(await readFile(mirror, "utf8"), /\\u0000/);
  await assert.rejects(access(join(outside, ".gitignore")), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
});

test("status reads a JSONL project correctly (regression)", async (t) => {
  const root = await project(t, { storage: { driver: "jsonl" } });
  const storage = join(root, ".supracortex");

  const store = new JsonlStore(storage);
  await store.appendJsonl("memory/durable.jsonl", [{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
  await store.appendJsonl("cache/summaries.jsonl", [{ id: "c1" }]);
  await store.writeJson("tasks/active.json", { tasks: [{ id: "t1" }] });
  await store.writeJson("index/repository.json", { generatedAt: "2026-10-15T00:00:00.000Z" });
  await store.writeJson("state/health.json", {
    version: "test",
    schemaVersion: 1,
    updatedAt: sweep,
    lastSweepAt: sweep,
    lastInjectionAt: injection,
  });

  const report = await status(root);
  assert.equal(report.memoryCounts["memory/durable.jsonl"], 3);
  assert.equal(report.cacheEntries, 1);
  assert.equal(report.activeTasks, 1);
  assert.equal(report.indexFreshness, "2026-10-15T00:00:00.000Z");
  assert.equal(report.lastSweepAt, sweep);
  assert.equal(report.lastInjectionAt, injection);
  assert.equal(report.lastError, null);
});

test("handshake-only MCP startup creates no storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sc-handshake-only-"));
  const scratch = await mkdtemp(join(tmpdir(), "sc-handshake-only-home-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  // Activation requires BOTH the env marker and the explicit argv flag.
  process.argv.push("--handshake-only");
  try {
    await withEnv({ ...isolatedEnv(scratch), SUPRACORTEX_HANDSHAKE_ONLY: "1" }, async () => {
      const server = await createMcpServer(root);
      try {
        await assert.rejects(
          access(join(root, ".supracortex")),
          (err: NodeJS.ErrnoException) => err.code === "ENOENT",
          "handshake-only startup must not create storage",
        );
      } finally {
        await server.close();
      }
    });
  } finally {
    const index = process.argv.lastIndexOf("--handshake-only");
    if (index >= 0) process.argv.splice(index, 1);
  }
});

test("a leaked SUPRACORTEX_HANDSHAKE_ONLY env var alone does not activate handshake mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sc-handshake-env-only-"));
  const scratch = await mkdtemp(join(tmpdir(), "sc-handshake-env-only-home-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  await withEnv({ ...isolatedEnv(scratch), SUPRACORTEX_HANDSHAKE_ONLY: "1" }, async () => {
    const server = await createMcpServer(root);
    try {
      // Without the argv flag this is a normal session: the real guard runs.
      await access(join(root, ".supracortex", ".gitignore"));
    } finally {
      await server.close();
    }
  });
});

test("normal MCP startup still initializes storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sc-mcp-normal-"));
  const scratch = await mkdtemp(join(tmpdir(), "sc-mcp-normal-home-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  await withEnv({ ...isolatedEnv(scratch), SUPRACORTEX_HANDSHAKE_ONLY: undefined }, async () => {
    const server = await createMcpServer(root);
    try {
      // Proves the real-session guard (runtime .gitignore) still runs.
      await access(join(root, ".supracortex", ".gitignore"));
    } finally {
      await server.close();
    }
  });
});
