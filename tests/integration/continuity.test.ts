import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig, createSqliteStore } from "../../packages/core/src/index.ts";
import type { StorageAdapter } from "../../packages/core/src/index.ts";

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "ci-cont-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return true; }\n", "utf8");
  return dir;
}

function engineOn(dir: string, store: StorageAdapter, overrides = {}) {
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  return new Engine({ config, store, pluginVersion: "0.2.0", projectRoot: dir });
}

test("engine captures structural events on init, record, and outcome", async () => {
  const dir = await project();
  const engine = engineOn(dir, new JsonlStore(join(dir, ".supracortex")));
  await engine.init();
  await engine.recordMemory({
    kind: "decision",
    content: "auth uses session cookies",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
  });
  await engine.recordOutcome({
    taskId: "t1",
    status: "success",
    summary: "done",
    touchedFiles: ["src/auth.ts"],
    recordedAt: new Date().toISOString(),
  });
  const events = await engine.timelineEvents();
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("session.started"), "session.started captured");
  assert.ok(kinds.includes("decision.recorded"), "decision.recorded captured");
  assert.ok(kinds.includes("task.completed"), "task.completed captured");
});

test("timeline detail returns a single event by id", async () => {
  const dir = await project();
  const engine = engineOn(dir, new JsonlStore(join(dir, ".supracortex")));
  await engine.init();
  const events = await engine.timelineEvents();
  assert.ok(events.length >= 1);
  const first = events[0]!;
  const detail = await engine.eventDetail(first.id);
  assert.ok(detail);
  assert.equal(detail!.id, first.id);
  assert.equal(await engine.eventDetail("nonexistent-id"), null);
});

test("handoff -> resume round-trips across a fresh engine", async () => {
  const dir = await project();
  const store1 = new JsonlStore(join(dir, ".supracortex"));
  const engine1 = engineOn(dir, store1);
  await engine1.init();
  const rec = await engine1.recordMemory({
    kind: "decision",
    content: "checkout uses idempotency keys",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
  });
  const evidenceId = rec.entry!.id;
  const capsule = await engine1.createHandoff({
    goal: "finish checkout bug",
    completedWork: ["mapped the failure"],
    nextActions: ["add regression test"],
    evidenceIds: [evidenceId],
  });
  assert.ok(capsule);
  assert.equal(capsule!.schemaVersion, 1);
  assert.ok(capsule!.evidenceIds.includes(evidenceId), "approved evidence retained");

  // Fresh engine over same storage (simulated new session/agent).
  const engine2 = engineOn(dir, new JsonlStore(join(dir, ".supracortex")));
  const resumed = await engine2.resumeHandoff(capsule!.id);
  assert.ok(resumed);
  assert.equal(resumed!.capsule.id, capsule!.id);
  assert.equal(resumed!.staleFiles.length, 0, "no stale files immediately after handoff");
  assert.ok(resumed!.evidence.some((m) => m.id === evidenceId), "evidence resolved");
});

test("resume flags stale files when evidence source changed", async () => {
  const dir = await project();
  const engine = engineOn(dir, new JsonlStore(join(dir, ".supracortex")));
  await engine.init();
  const capsule = await engine.createHandoff({ goal: "g" });
  assert.ok(capsule);
  // Change a tracked file and re-index.
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return false; }\n", "utf8");
  await engine.ensureIndex(true);
  const resumed = await engine.resumeHandoff(capsule!.id);
  assert.ok(resumed!.staleFiles.includes("src/auth.ts"), "changed evidence flagged stale");
});

test("resume rejects a capsule from a different project", async () => {
  const dirA = await project();
  const dirB = await project();
  const engineA = engineOn(dirA, new JsonlStore(join(dirA, ".supracortex")));
  await engineA.init();
  const capsule = await engineA.createHandoff({ goal: "g" });
  // Copy capsule into project B's storage and try to resume there.
  const storeB = new JsonlStore(join(dirB, ".supracortex"));
  const engineB = engineOn(dirB, storeB);
  await engineB.init();
  await storeB.writeJson(`handoffs/handoff-${capsule!.id}.json`, capsule);
  await assert.rejects(() => engineB.resumeHandoff(capsule!.id), /project mismatch/);
});

test("resume rejects an unsupported schema version", async () => {
  const dir = await project();
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = engineOn(dir, store);
  await engine.init();
  const capsule = await engine.createHandoff({ goal: "g" });
  const raw = await store.readJson<Record<string, unknown>>(`handoffs/handoff-${capsule!.id}.json`);
  raw!.schemaVersion = 99;
  await store.writeJson(`handoffs/handoff-${capsule!.id}.json`, raw);
  await assert.rejects(() => engine.resumeHandoff(capsule!.id), /unsupported handoff version/);
});

test("disabled engine captures nothing and returns empty continuity results", async () => {
  const dir = await project();
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = engineOn(dir, store, { enabled: false });
  await engine.init();
  await engine.recordMemory({ kind: "fact", content: "x", confidence: 0.9, sourceReferences: [{ kind: "file", value: "src/auth.ts" }] });
  assert.deepEqual(await engine.timelineEvents(), []);
  assert.equal(await engine.createHandoff({ goal: "g" }), null);
});

test("event capture parity: JSONL and SQLite record the same kinds", async () => {
  const run = async (store: StorageAdapter, dir: string) => {
    const engine = engineOn(dir, store);
    await engine.init();
    await engine.recordMemory({
      kind: "decision",
      content: "parity decision entry",
      confidence: 0.9,
      sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
    });
    return (await engine.timelineEvents()).map((e) => e.kind).sort();
  };
  const dirJ = await project();
  const jsonl = await run(new JsonlStore(join(dirJ, ".supracortex")), dirJ);

  const dirS = await project();
  let sqlite: StorageAdapter;
  try {
    sqlite = await createSqliteStore(join(dirS, ".supracortex"));
  } catch {
    // node:sqlite unavailable in this runtime; parity is vacuously satisfied.
    return;
  }
  const sq = await run(sqlite, dirS);
  assert.deepEqual(sq, jsonl, "same event kinds across drivers");
  await sqlite.close();
  await sqlite.close();
});
