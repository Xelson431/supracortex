import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore, Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";
import { safeReadFile } from "../../packages/core/src/diagnostics/index.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await mkdtemp(join(tmpdir(), "sc-hardening-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  const store = new JsonlStore(join(root, ".supracortex"));
  const { config } = resolveConfig({ project: { enabled: true, supraspace: { enabled: false } } });
  const engine = new Engine({ config, store, projectRoot: root, pluginVersion: "test" });
  t.after(() => engine.close());
  return { base, root, outside, store, engine };
}

test("diagnostics accepts a project-root alias but rejects descendant links", async (t) => {
  const { base, root, outside } = await fixture(t);
  const alias = join(base, "project-alias");
  await symlink(await realpath(root), alias, "dir");
  await writeFile(join(root, "config.json"), "{}");
  assert.equal(await safeReadFile(alias, join(alias, "config.json")), "{}");
  assert.equal(await safeReadFile(root, join(root, "config.json")), "{}");
  await symlink(outside, join(root, "linked"), "dir");
  await assert.rejects(() => safeReadFile(alias, join(alias, "linked", "config.json")), /symlink/i);
  await assert.rejects(() => safeReadFile(alias, join(outside, "config.json")), /outside/i);
});

for (const operation of ["write", "append", "rewrite", "read", "readJsonl", "mkdir", "remove", "lock"] as const) {
  test(`JSONL ${operation} rejects a linked storage directory`, async (t) => {
    const { outside, store } = await fixture(t);
    await store.ensureDir(".");
    await writeFile(join(outside, "probe.json"), '{"original":true}\n');
    await symlink(outside, join(store.root, "linked"), "dir");
    const path = "linked/probe.json";
    const actions = {
      write: () => store.writeJson(path, { replaced: true }),
      append: () => store.appendJsonl(path, [{ appended: true }]),
      rewrite: () => store.rewriteJsonl(path, [{ replaced: true }]),
      read: () => store.readJson(path),
      readJsonl: () => store.readJsonl(path),
      mkdir: () => store.ensureDir("linked/new-dir"),
      remove: () => store.remove(path),
      lock: async () => {
        await symlink(outside, join(store.root, "state"), "dir");
        const release = await store.acquireLock("fixture", { timeoutMs: 50 });
        await release();
      },
    };
    await assert.rejects(actions[operation], /symlink/i);
    assert.equal(await readFile(join(outside, "probe.json"), "utf8"), '{"original":true}\n');
    await assert.rejects(() => stat(join(outside, "new-dir")), { code: "ENOENT" });
  });
}

test("JSONL refuses linked files, linked roots and whole-root removal", async (t) => {
  const { root, outside, store } = await fixture(t);
  await store.ensureDir(".");
  await writeFile(join(outside, "probe.json"), "{}");
  await symlink(join(outside, "probe.json"), join(store.root, "linked.json"), "file");
  await assert.rejects(() => store.readJson("linked.json"), /symlink/i);
  await assert.rejects(() => store.appendJsonl("linked.json", [{}]), /symlink/i);
  await assert.rejects(() => store.writeJson("linked.json", {}), /symlink/i);
  await assert.rejects(() => store.remove("."), /root/i);
  const linkedRoot = join(root, "linked-store");
  await symlink(outside, linkedRoot, "dir");
  await assert.rejects(() => new JsonlStore(linkedRoot).writeJson("probe.json", {}), /symlink/i);
});

test("JSONL size ignores links and cycles without reading their targets", async (t) => {
  const { outside, store } = await fixture(t);
  await store.ensureDir(".");
  await writeFile(join(store.root, "own.txt"), "abc");
  await writeFile(join(outside, "large.txt"), "x".repeat(1024));
  await symlink(outside, join(store.root, "linked"), "dir");
  assert.equal(await store.totalSizeBytes(), 3);
  await symlink(store.root, join(store.root, "cycle"), "dir");
  assert.equal(await store.totalSizeBytes(), 3);
});

test("verified refresh detects equal-size restored-mtime edits and deletions", async (t) => {
  const { root, engine } = await fixture(t);
  const file = join(root, "auth.ts");
  const original = "export function originalAuth() { return true; }\n";
  const updated = "export function replacedAuth() { return true; }\n";
  assert.equal(original.length, updated.length);
  await writeFile(file, original);
  await engine.prepareContext({ query: "auth", hintFiles: ["auth.ts"] });
  const before = await engine.ensureIndex();
  const timestamps = await stat(file);
  await writeFile(file, updated);
  await utimes(file, timestamps.atime, timestamps.mtime);
  // An equal-size edit with a restored mtime is only observable with explicit
  // verification: the default fast path trusts mtime+size, and the in-memory
  // TTL serves repeat turns without a re-walk.
  const after = await engine.ensureIndex(true);
  assert.notEqual(after.files["auth.ts"]?.hash, before.files["auth.ts"]?.hash);
  const packet = await engine.prepareContext({ query: "auth", hintFiles: ["auth.ts"] });
  assert.ok(packet);
  assert.ok(!JSON.stringify(packet).includes("originalAuth"));
  const warm = await engine.prepareContext({ query: "auth", hintFiles: ["auth.ts"] });
  assert.ok(JSON.stringify(warm).includes("replacedAuth"));
  await rm(file);
  // Deletion likewise requires an explicit refresh to leave the in-memory cache.
  assert.equal((await engine.ensureIndex(true)).files["auth.ts"], undefined);
  const deleted = await engine.prepareContext({ query: "auth" });
  assert.ok(!JSON.stringify(deleted).includes("replacedAuth"));
});

test("memory retrieval invalidates edited file evidence in the same engine", async (t) => {
  const { root, engine, store } = await fixture(t);
  await writeFile(join(root, "auth.ts"), "export const authMode = 'cookie';\n");
  const result = await engine.recordMemory({ kind: "decision", content: "Auth uses cookies", confidence: 0.9, sourceReferences: [{ kind: "file", value: "auth.ts" }] });
  assert.equal(result.status, "recorded");
  await writeFile(join(root, "auth.ts"), "export const authMode = 'bearer';\n");
  // Observe the edit with an explicit verified refresh; the default in-memory
  // TTL would otherwise serve the prior generation for the rest of the window.
  await engine.ensureIndex(true);
  const selections = await engine.searchMemory("Auth uses cookies");
  assert.ok(!JSON.stringify(selections).includes("Auth uses cookies"));
  const records = await store.readJsonl<{ id: string; status: string }>("memory/decisions.jsonl");
  assert.equal(records.entries.find((entry) => entry.id === result.entry?.id)?.status, "stale");
});

test("Graphify generated artifacts are excluded independently of built-in graph configuration", async (t) => {
  const { root, engine } = await fixture(t);
  await writeFile(join(root, "auth.ts"), "export const auth = true;");
  await mkdir(join(root, "graphify-out"));
  await writeFile(join(root, "graphify-out", "GRAPH_REPORT.md"), "generated auth report");
  const index = await engine.ensureIndex();
  assert.ok(index.files["auth.ts"]);
  assert.equal(index.files["graphify-out/GRAPH_REPORT.md"], undefined);
});

test("concurrent context initialization shares one index refresh and emits one startup", async (t) => {
  const { root, engine, store } = await fixture(t);
  await writeFile(join(root, "auth.ts"), "export const auth = true;");
  const indexes = await Promise.all(Array.from({ length: 8 }, () => engine.ensureIndex()));
  for (const index of indexes) assert.equal(index, indexes[0]);
  const events = await store.readJsonl<{ kind: string }>("events/events.jsonl");
  assert.equal(events.entries.filter((event) => event.kind === "session.started").length, 1);
  assert.equal(events.entries.filter((event) => event.kind === "file.changed").length, 1);
  const saved = await readFile(join(store.root, "index/repository.json"), "utf8");
  await engine.ensureIndex();
  assert.equal(await readFile(join(store.root, "index/repository.json"), "utf8"), saved, "unchanged source does not rewrite the index artifact");
});

test("forced refresh completes after a concurrent refresh", async (t) => {
  const { root, engine } = await fixture(t);
  await writeFile(join(root, "auth.ts"), "export const auth = true;");
  const first = engine.ensureIndex();
  const forced = engine.ensureIndex(true);
  await Promise.all([first, forced]);
  const before = (await first).files["auth.ts"]?.hash;
  await writeFile(join(root, "auth.ts"), "export const auth = false;");
  const refreshed = await engine.ensureIndex(true);
  assert.notEqual(refreshed.files["auth.ts"]?.hash, before);
});

test("SQLite-backed value reports and usage deduplication use the storage contract", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sc-sqlite-parity-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  await writeFile(join(root, "auth.ts"), "export const auth = true;");
  let store;
  try {
    store = await createSqliteStore(join(root, ".supracortex"));
  } catch (error) {
    if ((error as Error).message.includes("node:sqlite is unavailable")) t.skip("node:sqlite unavailable");
    throw error;
  }
  const { config } = resolveConfig({ project: { enabled: true, telemetry: { valueMeasurement: { enabled: true, maxEvents: 20_000, maxAgeDays: 30 } } } });
  const engine = new Engine({ config, store, projectRoot: root, pluginVersion: "test" });
  t.after(() => engine.close());
  await engine.recordContextInjection({ taskId: "sqlite-task", incarnationId: "sqlite-incarnation", injected: true });
  const report = await engine.valueReport();
  assert.equal(report.sample.injected, 1);
  const observation = {
    messageId: "sqlite-message",
    sessionId: "sqlite-session",
    provider: "provider",
    model: "model",
    reportedCost: 0,
    inputTokens: 10,
    outputTokens: 1,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  assert.deepEqual(await engine.recordHostUsage(observation), { recorded: true, duplicate: false });
  assert.deepEqual(await engine.recordHostUsage(observation), { recorded: false, duplicate: true });
});

test("session metric retention is equivalent for SQLite logical files", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sc-sqlite-retention-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  const store = await createSqliteStore(join(root, ".supracortex"));
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  const { config } = resolveConfig({
    project: {
      enabled: true,
      telemetry: {
        sessionMetrics: { retentionDays: 15 },
        valueMeasurement: { enabled: false, maxEvents: 20_000, maxAgeDays: 30 },
      },
    },
  });
  const engine = new Engine({ config, store, projectRoot: root, pluginVersion: "test", now: () => now });
  t.after(() => engine.close());
  await store.writeJson("metrics/session-2026-08-01.json", { old: true });
  await store.writeJson("metrics/session-2026-09-10.json", { recent: true });
  await engine.persistMetrics();
  assert.equal(await store.exists("metrics/session-2026-08-01.json"), false);
  assert.equal(await store.exists("metrics/session-2026-09-10.json"), true);
  assert.ok((await store.listFiles("metrics")).some((path) => path.endsWith("session-2026-09-11.json")));
});
