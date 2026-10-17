import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlStore,
  MemoryManager,
  compactMemory,
  enforceLineBudget,
  decideMemoryTransition,
  requiresResolution,
  selectBudgetOverflow,
  type MemoryEntry,
} from "../../packages/core/src/index.ts";

const opts = { requireEvidenceForDurableFacts: false, redactLikelySecrets: true, minimumConfidence: 0 };

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ci-lifecycle-"));
}

function entry(over: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    kind: "fact",
    content: "filler",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    confidence: 0.8,
    status: "active",
    sourceReferences: [],
    relatedFiles: [],
    relatedSymbols: [],
    tags: [],
    invalidationRules: [],
    ...over,
  };
}

test("record classifies noop on exact duplicate without appending", async () => {
  const mgr = new MemoryManager(new JsonlStore(await tmp()));
  const first = await mgr.record({ kind: "failure", content: "ci timed out twice", confidence: 0.8 }, opts);
  assert.equal(first.classification, "add");
  const dup = await mgr.record({ kind: "failure", content: "  CI TIMED OUT twice ", confidence: 0.8 }, opts);
  assert.equal(dup.classification, "noop");
  assert.equal(dup.entry?.id, first.entry?.id);
  assert.equal((await mgr.loadAll()).length, 1);
});

test("contradiction at threshold tie becomes candidate, history preserved", async () => {
  const mgr = new MemoryManager(new JsonlStore(await tmp()));
  const base = "we always use tabs for indentation in every committed source file daily";
  const rival = "we never use tabs for indentation in every committed source file daily";
  await mgr.record({ kind: "convention", content: base, confidence: 0.8 }, opts);
  const second = await mgr.record({ kind: "convention", content: rival, confidence: 0.8 }, opts);
  assert.equal(second.disputed, true);
  assert.equal(second.entry?.status, "candidate");
  assert.equal(second.entry?.supersedes, undefined);
  const all = await mgr.loadAll();
  assert.equal(all.find((e) => e.content === base)?.status, "active");
  // Resolution requires the explicit 6-state path.
  assert.equal(decideMemoryTransition("candidate", "active").allowed, true);
  assert.equal(requiresResolution("candidate"), true);
});

test("non-contradictory near-duplicate links supersedes history", async () => {
  const mgr = new MemoryManager(new JsonlStore(await tmp()));
  const first = await mgr.record({ kind: "failure", content: "flaky db test on ci runner pool", confidence: 0.8 }, opts);
  const second = await mgr.record(
    { kind: "failure", content: "flaky db test on ci runner pool again", confidence: 0.8 },
    opts,
  );
  assert.equal(second.classification, "update");
  assert.deepEqual(second.entry?.supersedes, [first.entry!.id]);
});

test("auto-forget flags pair: forgotten terminal, superseded drains to forgotten", async () => {
  assert.equal(decideMemoryTransition("active", "forgotten").allowed, true);
  assert.equal(decideMemoryTransition("forgotten", "active").allowed, false);
  assert.equal(decideMemoryTransition("superseded", "forgotten").allowed, true);
});

test("line-budget prune keeps pinned, preserves unresolved, drops oldest", () => {
  const entries = [
    entry({ id: "old", content: "old", createdAt: "2023-01-01T00:00:00.000Z" }),
    entry({ id: "mid", content: "mid", createdAt: "2023-06-01T00:00:00.000Z" }),
    entry({ id: "pinned", content: "p", createdAt: "2022-01-01T00:00:00.000Z", tags: ["pinned"] }),
    entry({ id: "cand", content: "c", createdAt: "2022-06-01T00:00:00.000Z", status: "candidate" }),
    entry({ id: "new", content: "n", createdAt: "2024-01-01T00:00:00.000Z" }),
  ];
  const r = enforceLineBudget(entries, 4);
  assert.equal(r.pruned, 1);
  assert.deepEqual(r.prunedIds, ["old"]);
  assert.ok(r.kept.some((e) => e.id === "pinned"));
  assert.ok(r.kept.some((e) => e.id === "cand"));
});

test("line-budget protects reviewable stale, prunes oldest terminal first", () => {
  const entries = [
    entry({ id: "term-old", content: "t", createdAt: "2022-01-01T00:00:00.000Z", status: "forgotten" }),
    entry({ id: "term-new", content: "t", createdAt: "2023-01-01T00:00:00.000Z", status: "superseded" }),
    entry({ id: "expired", content: "e", createdAt: "2021-01-01T00:00:00.000Z", status: "stale" }),
    entry({ id: "decay", content: "d", createdAt: "2021-06-01T00:00:00.000Z", status: "stale", tags: ["decay-stale"] }),
    entry({ id: "ev", content: "v", createdAt: "2021-03-01T00:00:00.000Z", status: "stale", tags: ["evidence-stale"] }),
    entry({ id: "active-new", content: "n", createdAt: "2024-01-01T00:00:00.000Z" }),
  ];
  const r = enforceLineBudget(entries, 4);
  assert.equal(r.pruned, 2);
  assert.deepEqual(r.prunedIds, ["term-old", "term-new"]);
  for (const id of ["expired", "decay", "ev"]) assert.ok(r.kept.some((e) => e.id === id), id);
});

test("compactMemory over-budget retains reviewable, logs prune reason", () => {
  const entries = [
    entry({ id: "term-old", content: "t", createdAt: "2022-01-01T00:00:00.000Z", status: "forgotten" }),
    entry({ id: "review", content: "r", createdAt: "2021-01-01T00:00:00.000Z", status: "stale" }),
    entry({ id: "a", content: "a", createdAt: "2024-01-01T00:00:00.000Z" }),
  ];
  const r = compactMemory(entries, { sessionRetentionDays: 3650, maxLines: 2 });
  assert.ok(r.kept.some((e) => e.id === "review"));
  assert.ok(!r.kept.some((e) => e.id === "term-old"));
  assert.ok(r.auditTrail.some((a) => a.action === "pruned"));
});

test("line-budget with everything protected skips prune with reason", () => {
  const entries = [
    entry({ id: "a", tags: ["pinned"] }),
    entry({ id: "b", status: "candidate" }),
  ];
  const r = enforceLineBudget(entries, 1);
  assert.equal(r.pruned, 0);
  assert.equal(r.reason, "all-pinned");
});

test("decay sweep marks old active for reverify but never demotes or touches unresolved/pinned", () => {
  const now = Date.UTC(2025, 0, 1);
  const old = "2020-01-01T00:00:00.000Z";
  const entries = [
    entry({ id: "active-old", createdAt: old, updatedAt: old }),
    entry({ id: "cand-old", createdAt: old, updatedAt: old, status: "candidate" }),
    entry({ id: "pinned-old", createdAt: old, updatedAt: old, tags: ["pinned"] }),
  ];
  const r = compactMemory(entries, { now, sessionRetentionDays: 3650, ttlDays: 30, halfLifeDays: 30 });
  const byId = new Map(r.kept.map((e) => [e.id, e]));
  const active = byId.get("active-old")!;
  assert.equal(active.status, "active", "age does not demote");
  assert.equal(active.needsReverifyAt, new Date(now).toISOString(), "marker set");
  assert.equal(active.updatedAt, old, "updatedAt unchanged");
  assert.ok(!active.tags.includes("decay-stale"), "no stale tag is applied");
  assert.equal(byId.get("cand-old")?.status, "candidate");
  assert.equal(byId.get("pinned-old")?.status, "active");
  assert.equal(byId.get("pinned-old")?.needsReverifyAt, undefined, "pinned untouched");
  assert.ok((r.decayed ?? 0) >= 1);
});

test("compaction marks time-elapsed active for reverify; candidate expiry is unchanged", () => {
  const now = Date.UTC(2025, 0, 1);
  const old = "2024-11-01T00:00:00.000Z"; // ~61 days before now
  const past = new Date(now - 1000).toISOString();
  const entries = [
    entry({
      id: "active-rule",
      createdAt: old,
      updatedAt: old,
      invalidationRules: [{ kind: "time-elapsed", expiresAt: past }],
    }),
    entry({ id: "cand-old", createdAt: old, updatedAt: old, status: "candidate" }),
  ];
  const r = compactMemory(entries, { now, sessionRetentionDays: 14 });
  const byId = new Map(r.kept.map((e) => [e.id, e]));

  const active = byId.get("active-rule")!;
  assert.equal(active.status, "active", "time-elapsed rule does not demote");
  assert.equal(active.needsReverifyAt, new Date(now).toISOString(), "marker set");
  assert.equal(active.updatedAt, old, "updatedAt unchanged");

  assert.equal(byId.get("cand-old")?.status, "stale", "candidate past retention still expires");
});

test("session budget selects oldest-by-timestamp overflow", () => {
  const names = ["session-2024-01-03.json", "session-2024-01-01.json", "session-2024-01-02.json", "notes.txt"];
  assert.deepEqual(selectBudgetOverflow(names, 2), ["session-2024-01-01.json"]);
  assert.deepEqual(selectBudgetOverflow(names, 10), []);
});
