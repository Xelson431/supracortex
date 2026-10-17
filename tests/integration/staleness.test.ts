/**
 * Time-based staleness tests with a fully controllable clock.
 *
 * These prove the system never leaves stale areas: abandoned tasks are reaped,
 * expired ownership is released, old sessions/cache/completed-logs are pruned,
 * durable memory is re-flagged for verification, and the sweep is idempotent
 * and monotonic. A mutable `clock` object drives every time decision so results
 * are deterministic (no real waiting).
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  JsonlStore,
  Sweeper,
  resolveConfig,
  type Config,
} from "../../packages/core/src/index.ts";

const MIN = 60_000;
const DAY = 86_400_000;

function makeClock(startIso: string) {
  const state = { t: new Date(startIso).getTime() };
  return {
    now: () => state.t,
    advanceMinutes(m: number) {
      state.t += m * MIN;
    },
    advanceDays(d: number) {
      state.t += d * DAY;
    },
    set(iso: string) {
      state.t = new Date(iso).getTime();
    },
  };
}

async function makeEngine(clock: { now: () => number }, overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ci-time-"));
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({
    config,
    store,
    pluginVersion: "0.1.0",
    projectRoot: dir,
    now: clock.now,
  });
  return { dir, engine, store, config };
}

test("abandoned task (stale heartbeat) is reaped and its ownership released", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock);
  await engine.claimFiles("task-A", ["src/a.ts"], { sessionId: "sess-1" });
  assert.equal(await engine.activeTaskCount(), 1, "task registered active");

  // Advance beyond the 30-minute heartbeat timeout, then sweep.
  clock.advanceMinutes(31);
  const report = await engine.sweep("test", { force: true });
  assert.ok(report);
  assert.ok(report!.abandonedTasks.includes("task-A"), "stale task reaped");
  assert.ok(report!.releasedOwnership.includes("src/a.ts"), "its ownership released");
  assert.equal(await engine.activeTaskCount(), 0, "no active tasks remain");

  // The freed file can now be claimed by someone else.
  const claim = await engine.claimFiles("task-B", ["src/a.ts"], { sessionId: "sess-2" });
  assert.deepEqual(claim.granted, ["src/a.ts"]);
});

test("heartbeat keeps a long-running task alive across the timeout window", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock);
  await engine.claimFiles("task-long", ["src/long.ts"], { sessionId: "s" });

  // Simulate steady progress: heartbeat every 20 minutes for 2 hours.
  for (let i = 0; i < 6; i++) {
    clock.advanceMinutes(20);
    await engine.heartbeat("task-long", { sessionId: "s" });
    const r = await engine.sweep("tick", { force: true });
    assert.ok(!r!.abandonedTasks.includes("task-long"), `alive at tick ${i}`);
  }
  assert.equal(await engine.activeTaskCount(), 1, "still active after 2h with heartbeats");
});

test("ownership TTL expiry frees a file even if the task record lingers", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  // ownershipTtl 60 min, but heartbeat timeout very large so task stays 'active'.
  const { engine } = await makeEngine(clock, {
    staleness: { taskHeartbeatTimeoutMinutes: 100000, ownershipTtlMinutes: 60 },
  });
  await engine.claimFiles("task-ttl", ["src/ttl.ts"], { sessionId: "s" });

  clock.advanceMinutes(61);
  const report = await engine.sweep("test", { force: true });
  assert.ok(report!.releasedOwnership.includes("src/ttl.ts"), "expired claim released by TTL");

  // Another task can now take it.
  const claim = await engine.claimFiles("task-new", ["src/ttl.ts"], { sessionId: "s2" });
  assert.deepEqual(claim.granted, ["src/ttl.ts"]);
});

test("heartbeat renews a live ownership lease but cannot resurrect an expired one", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock, {
    staleness: { taskHeartbeatTimeoutMinutes: 100000, ownershipTtlMinutes: 60 },
  });
  await engine.claimFiles("task-live", ["src/live.ts"], { sessionId: "s" });
  clock.advanceMinutes(50);
  const renewal = await engine.heartbeat("task-live", { sessionId: "s" });
  assert.deepEqual(renewal, { renewed: ["src/live.ts"], lost: [] });

  // The renewed expiry is now 110 minutes from the original start, so the
  // lease remains held at minute 61.
  clock.advanceMinutes(11);
  const contender = await engine.claimFiles("other", ["src/live.ts"], { sessionId: "other" });
  assert.equal(contender.granted.length, 0);

  // A separate lease that has already expired cannot be revived by a late
  // heartbeat, even before a sweeper has removed its persisted record.
  await engine.claimFiles("task-late", ["src/late.ts"], { sessionId: "s" });
  clock.advanceMinutes(61);
  const late = await engine.heartbeat("task-late", { sessionId: "s" });
  assert.deepEqual(late, { renewed: [], lost: ["src/late.ts"] });
});

test("dead session reaps its tasks and ownership on session.deleted sweep", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock);
  await engine.claimFiles("t1", ["a.ts"], { sessionId: "dead-session" });
  await engine.claimFiles("t2", ["b.ts"], { sessionId: "live-session" });

  // Only "live-session" remains alive; "dead-session" is gone.
  const report = await engine.sweep("session.deleted", {
    force: true,
    liveSessionIds: new Set(["live-session"]),
  });
  assert.ok(report!.abandonedTasks.includes("t1"), "dead-session task reaped");
  assert.ok(!report!.abandonedTasks.includes("t2"), "live-session task kept");
  assert.ok(report!.releasedOwnership.includes("a.ts"));
  assert.ok(!report!.releasedOwnership.includes("b.ts"));
});

test("sweep is idempotent: a second immediate sweep is clean and changes nothing", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock);
  await engine.claimFiles("t", ["x.ts"], { sessionId: "s" });
  clock.advanceMinutes(31);
  const first = await engine.sweep("first", { force: true });
  assert.ok(!first!.clean, "first sweep did work");
  const second = await engine.sweep("second", { force: true });
  assert.ok(second!.clean, "second sweep is a no-op (idempotent)");
  const third = await engine.sweep("third", { force: true });
  assert.ok(third!.clean, "still clean");
});

test("sweep on a pristine system is always clean", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock);
  await engine.init();
  const r = await engine.sweep("pristine", { force: true });
  assert.ok(r!.clean, "nothing to sweep on a fresh system");
  assert.equal((await engine.readHealth())?.lastSweepAt, r!.ranAt, "clean sweep is visible in status");
});

test("durable memory is marked for re-verification after reverify window without demotion", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock, {
    staleness: { memoryReverifyDays: 90 },
  });
  const rec = await engine.recordMemory({
    kind: "fact",
    content: "the primary datastore is postgres 16",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "docker-compose.yml" }],
  });
  assert.equal(rec.status, "recorded");
  const id = rec.entry!.id;

  // Before the window: not flagged.
  clock.advanceDays(89);
  let r = await engine.sweep("pre", { force: true });
  assert.ok(!r!.memoryFlaggedForReverify.includes(id), "not yet due");

  type Listed = {
    id: string;
    status: string;
    updatedAt: string;
    lastVerifiedAt?: string;
    needsReverifyAt?: string;
  };
  const before = ((await engine.review({ type: "list", statuses: ["active"] })) as Listed[])
    .find((e) => e.id === id)!;

  // After the window: marked for reverify, but status and timestamps are untouched.
  clock.advanceDays(2);
  r = await engine.sweep("post", { force: true });
  assert.ok(r!.memoryFlaggedForReverify.includes(id), "flagged for reverify after 90d");

  const after = ((await engine.review({ type: "list", statuses: ["active"] })) as Listed[])
    .find((e) => e.id === id)!;
  assert.equal(after.status, "active", "age never demotes status");
  assert.ok(after.needsReverifyAt, "needsReverifyAt marker set");
  assert.equal(after.updatedAt, before.updatedAt, "updatedAt unchanged");
  assert.equal(after.lastVerifiedAt, before.lastVerifiedAt, "lastVerifiedAt unchanged");

  // The entry is still eligible for retrieval (no score penalty).
  const found = await engine.searchMemory("what datastore do we use");
  assert.ok(
    found.some((m) => m.entry.id === id),
    "marked memory remains retrievable",
  );

  // The marker is auditable through the safety brief.
  const brief = await engine.generateSafetyBrief({ changedFiles: [], staged: [], untracked: [] });
  assert.ok(
    brief!.staleEvidence.some((e) => e.id === id),
    "safety brief surfaces the reverify marker",
  );
});

test("sweep sets needsReverifyAt once and a second sweep does not move it", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock, { staleness: { memoryReverifyDays: 30 } });
  const rec = await engine.recordMemory({
    kind: "decision",
    content: "deploys go through the blue-green pipeline",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "docker-compose.yml" }],
  });
  const id = rec.entry!.id;

  clock.advanceDays(31);
  const first = await engine.sweep("first", { force: true });
  assert.ok(first!.memoryFlaggedForReverify.includes(id), "first sweep flags the entry");

  type Listed = { id: string; status: string; needsReverifyAt?: string };
  const marker = ((await engine.review({ type: "list", statuses: ["active"] })) as Listed[])
    .find((e) => e.id === id)!.needsReverifyAt;
  assert.ok(marker, "marker is set");

  clock.advanceDays(30);
  const second = await engine.sweep("second", { force: true });
  assert.ok(
    !second!.memoryFlaggedForReverify.includes(id),
    "already-marked entry is not flagged again",
  );
  const after = ((await engine.review({ type: "list", statuses: ["active"] })) as Listed[])
    .find((e) => e.id === id)!;
  assert.equal(after.status, "active");
  assert.equal(after.needsReverifyAt, marker, "marker timestamp does not move");
});

test("unresolved failures are NEVER expired by the reverify sweep", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock, { staleness: { memoryReverifyDays: 30 } });
  await engine.recordMemory({
    kind: "failure",
    content: "integration suite deadlocks under high concurrency",
    confidence: 0.9,
  });
  clock.advanceDays(400); // way past any window
  await engine.sweep("long-after", { force: true });
  const found = await engine.searchMemory("concurrency deadlock");
  assert.ok(
    found.some((m) => m.entry.kind === "failure"),
    "failure memory preserved indefinitely",
  );
});

test("completed-task audit log is trimmed past retention but recent rows kept", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine, store } = await makeEngine(clock, {
    staleness: { completedTaskRetentionDays: 30 },
  });
  // Old outcome.
  await engine.recordOutcome({
    taskId: "old",
    status: "success",
    summary: "done long ago",
    touchedFiles: [],
    recordedAt: new Date(clock.now()).toISOString(),
  });
  // Advance 40 days, add a recent outcome.
  clock.advanceDays(40);
  await engine.recordOutcome({
    taskId: "recent",
    status: "success",
    summary: "done recently",
    touchedFiles: [],
    recordedAt: new Date(clock.now()).toISOString(),
  });
  const report = await engine.sweep("trim", { force: true });
  assert.equal(report!.prunedCompletedTasks, 1, "one old row trimmed");
  const remaining = await store.readJsonl<{ taskId: string }>("tasks/completed.jsonl");
  const ids = remaining.entries.map((e) => e.taskId);
  assert.ok(ids.includes("recent"), "recent kept");
  assert.ok(!ids.includes("old"), "old trimmed");
});

test("stale summary cache entries are pruned by age during sweep", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { dir, engine } = await makeEngine(clock, {
    cache: { maxAgeDays: 30 },
    staleness: { pruneStaleCacheOnSweep: true },
  });
  await writeFile(join(dir, "app.ts"), "export const a = 1;\n", "utf8");
  await engine.ensureIndex();
  await engine.cacheSummaryFromContent("app.ts", "export const a = 1;\n");

  // Within age: not pruned.
  clock.advanceDays(29);
  let r = await engine.sweep("young", { force: true });
  assert.equal(r!.prunedCacheEntries, 0, "young cache kept");

  // Past age: pruned.
  clock.advanceDays(5);
  r = await engine.sweep("old", { force: true });
  assert.equal(r!.prunedCacheEntries, 1, "aged cache pruned");
});

test("sweep debounce prevents thrashing but force always runs", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine } = await makeEngine(clock);
  await engine.init(); // init performs an opportunistic sweep, arming the debounce

  // A non-forced sweep immediately after init is debounced (within 5s window).
  const debounced = await engine.sweep("too-soon");
  assert.equal(debounced, null, "debounced right after init sweep");

  // force always bypasses the debounce.
  const forced = await engine.sweep("forced", { force: true });
  assert.ok(forced !== null, "force bypasses debounce");

  // After the debounce window elapses, a non-forced sweep runs again.
  clock.advanceMinutes(1);
  const later = await engine.sweep("later");
  assert.ok(later !== null, "non-forced sweep runs after debounce window");
});

test("engine init runs an opportunistic sweep automatically", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  // First engine claims and abandons a task.
  const dir = await mkdtemp(join(tmpdir(), "ci-time-"));
  const { config } = resolveConfig({ project: { enabled: true } });
  const s = new JsonlStore(join(dir, ".supracortex"));
  const e1 = new Engine({ config, store: s, pluginVersion: "0.1.0", projectRoot: dir, now: clock.now });
  await e1.claimFiles("ghost", ["g.ts"], { sessionId: "s1" });

  // Time passes beyond heartbeat timeout; a NEW engine (new session) inits.
  clock.advanceMinutes(31);
  const e2 = new Engine({ config, store: s, pluginVersion: "0.1.0", projectRoot: dir, now: clock.now });
  await e2.init(); // triggers opportunistic sweep

  // Ghost task's ownership should be gone; a fresh claim succeeds.
  const claim = await e2.claimFiles("fresh", ["g.ts"], { sessionId: "s2" });
  assert.deepEqual(claim.granted, ["g.ts"], "abandoned claim cleaned on init");
});

test("legacy on-disk formats migrate without loss during sweep", async () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  const { engine, store } = await makeEngine(clock);
  await engine.init();
  // Write LEGACY ownership (path -> string) and LEGACY active ({taskIds}).
  await store.writeJson("tasks/ownership.json", {
    claims: { "legacy.ts": "legacy-task" },
    updatedAt: new Date(clock.now()).toISOString(),
  });
  await store.writeJson("tasks/active.json", {
    taskIds: ["legacy-task"],
    updatedAt: new Date(clock.now()).toISOString(),
  });
  // Legacy active task has no heartbeat => treated as started "now" on migration.
  // Advance past timeout, sweep: it should be reaped and its legacy claim freed.
  clock.advanceMinutes(31);
  const r = await engine.sweep("migrate", { force: true });
  assert.ok(r!.abandonedTasks.includes("legacy-task"), "legacy active task reaped");
  assert.ok(r!.releasedOwnership.includes("legacy.ts"), "legacy string claim released");
});
