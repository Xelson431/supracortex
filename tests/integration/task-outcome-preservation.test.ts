/**
 * Regression coverage for the P0 task-outcome data loss.
 *
 * `tasks/completed.jsonl` is owned by the task subsystem. The memory repository
 * used to include it in its read/rewrite file set, so any memory mutation
 * rewrote the task log with an empty array. These tests assert that every
 * memory mutation leaves the task log byte-identical, that the memory
 * repository reports no corruption from task rows, and that the sweep shares
 * the memory lock with MemoryManager.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  JsonlStore,
  resolveConfig,
  type MemoryEntry,
  type TaskOutcome,
} from "../../packages/core/src/index.ts";
import { MemoryRepository } from "../../packages/core/src/memory/repository.ts";

const COMPLETED_FILE = "tasks/completed.jsonl";
const PERSISTED_OUTCOMES_FILE = "memory/outcomes.jsonl";

function makeClock(startIso: string) {
  const state = { t: new Date(startIso).getTime() };
  return {
    now: () => state.t,
    advanceDays(days: number) {
      state.t += days * 86_400_000;
    },
  };
}

async function makeEngine(startIso = "2025-01-01T00:00:00.000Z") {
  const dir = await mkdtemp(join(tmpdir(), "ci-outcome-preserve-"));
  const clock = makeClock(startIso);
  const { config } = resolveConfig({
    project: {
      enabled: true,
      // Keep evidence policy out of the way: these tests exercise persistence,
      // not record validation. Source metadata is still attached below.
      memory: { requireEvidenceForDurableFacts: false },
      supraspace: { enabled: false },
    },
  });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({
    config,
    store,
    pluginVersion: "test",
    projectRoot: dir,
    now: clock.now,
  });
  await engine.init();
  return { dir, store, engine, clock };
}

async function seedOutcome(
  engine: Engine,
  clock: ReturnType<typeof makeClock>,
  taskId: string,
): Promise<void> {
  const result = await engine.recordOutcome({
    taskId,
    status: "success",
    summary: `completed ${taskId}`,
    touchedFiles: ["src/a.ts"],
    recordedAt: new Date(clock.now()).toISOString(),
  });
  assert.ok(result?.recorded, "task outcome recorded");
}

async function recordFact(engine: Engine, content: string): Promise<MemoryEntry> {
  const result = await engine.recordMemory({
    kind: "fact",
    content,
    confidence: 0.9,
    sourceReferences: [{ kind: "session", value: "session-1" }],
  });
  assert.equal(result.status, "recorded", `fact recorded: ${content}`);
  assert.ok(result.entry, "record returned an entry");
  return result.entry;
}

async function completedText(store: JsonlStore): Promise<string> {
  return readFile(join(store.root, COMPLETED_FILE), "utf8");
}

const mutations: Array<{
  name: string;
  apply: (engine: Engine, id: string) => Promise<unknown>;
}> = [
  {
    name: "pin",
    apply: (engine, id) => engine.review({ type: "pin", id }),
  },
  {
    name: "approve",
    apply: async (engine, id) => {
      await engine.review({ type: "invalidate", id });
      return engine.review({ type: "approve", id });
    },
  },
  {
    name: "invalidate",
    apply: (engine, id) => engine.review({ type: "invalidate", id }),
  },
  {
    name: "refresh-evidence",
    apply: (engine, id) => engine.review({ type: "refresh-evidence", id }),
  },
  {
    name: "compactMemory",
    apply: (engine) => engine.compactMemory(),
  },
];

for (const mutation of mutations) {
  test(`recordMemory + ${mutation.name} preserves the task outcome log byte-for-byte`, async () => {
    const { store, engine, clock } = await makeEngine();
    await seedOutcome(engine, clock, `task-${mutation.name}`);
    const before = await completedText(store);

    const fact = await recordFact(engine, `durable fact surviving ${mutation.name}`);
    await mutation.apply(engine, fact.id);

    const after = await completedText(store);
    assert.equal(after, before, "task outcome log bytes unchanged");
    const rows = await store.readJsonl<TaskOutcome>(COMPLETED_FILE);
    assert.equal(rows.entries.length, 1, "exactly one task outcome remains");
    assert.equal(rows.entries[0]?.taskId, `task-${mutation.name}`);
  });
}

test("loadAll reports zero corrupt lines with a task outcome present", async () => {
  const { store, engine, clock } = await makeEngine();
  await seedOutcome(engine, clock, "task-corrupt-check");

  const result = await new MemoryRepository(store).loadAll();
  assert.equal(result.corruptLines, 0, "task rows are not parsed as memory");
  // Task outcomes are task-subsystem records, not memory entries.
  assert.equal(result.entries.length, 0, "task outcome is not exposed as memory");

  const counts = await new MemoryRepository(store).count();
  assert.ok(!(COMPLETED_FILE in counts), "repository does not count the task log");
});

test("sweep waits on the memory lock and concurrent record/sweep writes survive", async () => {
  const { store, engine, clock } = await makeEngine();
  const oldFact = await recordFact(engine, "old fact that needs re-verification");
  clock.advanceDays(100); // past the default 90-day re-verify window
  await seedOutcome(engine, clock, "task-sweep-race");

  const release = await store.acquireLock("memory");
  let sweepSettled = false;
  const sweepPromise = engine.sweep("test", { force: true }).finally(() => {
    sweepSettled = true;
  });
  const recordPromise = recordFact(engine, "fact recorded while sweep is waiting");

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sweepSettled, false, "sweep blocks on the shared memory lock");
  const during = await new MemoryRepository(store).loadAll();
  assert.ok(
    !during.entries.some((e) => e.content === "fact recorded while sweep is waiting"),
    "concurrent record is also blocked by the shared lock",
  );

  await release();
  await sweepPromise;
  const fresh = await recordPromise;

  const after = await new MemoryRepository(store).loadAll();
  assert.equal(after.corruptLines, 0);
  const oldAfter = after.entries.find((e) => e.id === oldFact.id);
  assert.ok(oldAfter, "old fact survives the sweep rewrite");
  assert.ok(oldAfter.needsReverifyAt, "sweep actually reran and set the re-verify marker");
  assert.ok(
    after.entries.some((e) => e.id === fresh.id),
    "fact recorded during the sweep survives",
  );

  const rows = await store.readJsonl<TaskOutcome>(COMPLETED_FILE);
  assert.equal(rows.entries.length, 1, "task outcome survives the sweep");
});

test("persisted task-outcome memory survives a rewrite in memory/outcomes.jsonl", async () => {
  const { store, engine } = await makeEngine();
  const persisted = await engine.recordMemory({
    kind: "task-outcome",
    content: "persisted learning from a completed task",
    confidence: 0.8,
    sourceReferences: [{ kind: "session", value: "task-persisted" }],
  });
  assert.equal(persisted.status, "recorded");
  assert.ok(persisted.entry);

  // Any memory mutation triggers rewriteAll across the memory-owned files.
  const fact = await recordFact(engine, "unrelated fact forcing a global rewrite");
  await engine.review({ type: "pin", id: fact.id });

  const rows = await store.readJsonl<MemoryEntry>(PERSISTED_OUTCOMES_FILE);
  assert.equal(rows.entries.length, 1, "persisted outcome memory persisted");
  assert.equal(rows.entries[0]?.id, persisted.entry.id);
  assert.equal(rows.entries[0]?.kind, "task-outcome");

  const all = await new MemoryRepository(store).loadAll();
  assert.ok(all.entries.some((e) => e.id === persisted.entry!.id));
  assert.equal(all.corruptLines, 0);
});
