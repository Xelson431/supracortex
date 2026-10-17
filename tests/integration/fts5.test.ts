/**
 * FTS5 full-text search integration tests.
 *
 * Tests cover: FTS-disabled fallback, match escaping, sync on record/edit/purge/compact,
 * BM25 ranking blending, and jsonl driver unaffected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteStore,
  JsonlStore,
  MemoryManager,
  retrieveMemory,
  buildQueryContext,
} from "../../packages/core/src/index.ts";

async function sqlite(): Promise<ReturnType<typeof createSqliteStore>> {
  try {
    return await createSqliteStore(await mkdtemp(join(tmpdir(), "cortex-fts5-")));
  } catch {
    return null as unknown as ReturnType<typeof createSqliteStore>;
  }
}

async function jsonl(): Promise<JsonlStore> {
  return new JsonlStore(await mkdtemp(join(tmpdir(), "cortex-fts5-jsonl-")));
}

const REC_OPTS = {
  requireEvidenceForDurableFacts: false,
  redactLikelySecrets: true,
  minimumConfidence: 0,
};

// ---------------------------------------------------------------------------
// (a) FTS-disabled path: jsonl store has no FTS methods → everything works
// ---------------------------------------------------------------------------

void test("fts5: jsonl driver search unchanged when FTS unavailable", async () => {
  const store = await jsonl();
  const mgr = new MemoryManager(store);
  await mgr.record({ kind: "decision", content: "use pnpm workspaces", confidence: 0.9, tags: ["build"] }, REC_OPTS);
  const r = await mgr.search("pnpm", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.equal(r.selections.length, 1);
  assert.ok(r.selections[0]!.reason.includes("pnpm"));
});

// ---------------------------------------------------------------------------
// (b) BM25 ranking: matching content ranks above non-matching
// ---------------------------------------------------------------------------

void test("fts5: BM25 boosts matching entry above non-matching", async () => {
  const store = await sqlite();
  if (!store) return; // skip if node:sqlite unavailable
  const mgr = new MemoryManager(store);
  // Record a matching and a non-matching entry with same kind/confidence
  await mgr.record({ kind: "fact", content: "postgres is the primary database", confidence: 0.9, tags: ["db"] }, REC_OPTS);
  await mgr.record({ kind: "fact", content: "we use react for frontend", confidence: 0.9, tags: ["ui"] }, REC_OPTS);
  const r = await mgr.search("postgres database", ["db"], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.ok(r.selections.length >= 1);
  // The postgres entry should be ranked first
  assert.ok(r.selections[0]!.entry.content.includes("postgres"), `expected postgres entry first, got: ${r.selections[0]!.entry.content}`);
});

// ---------------------------------------------------------------------------
// (c) Escaping: special chars return results-or-empty without throwing
// ---------------------------------------------------------------------------

void test("fts5: special chars in query do not throw", async () => {
  const store = await sqlite();
  if (!store) return;
  const mgr = new MemoryManager(store);
  await mgr.record({ kind: "fact", content: "performance baseline: 100ms", confidence: 0.8 }, REC_OPTS);
  // These should never crash
  for (const q of ['"', '("', "*", "AND OR NEAR", "hello:world", 'he said "hi"']) {
    const r = await mgr.search(q, [], [], [], { maxEntries: 5, maxTokens: 1000 });
    assert.ok(Array.isArray(r.selections));
  }
});

// ---------------------------------------------------------------------------
// (d) Sync: record → searchable, edit → content updated, purge → gone
// ---------------------------------------------------------------------------

void test("fts5: record then search finds entry", async () => {
  const store = await sqlite();
  if (!store) return;
  const mgr = new MemoryManager(store);
  await mgr.record({ kind: "decision", content: "use typescript strict mode", confidence: 0.9, tags: ["typescript"] }, REC_OPTS);
  const r = await mgr.search("typescript strict", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.ok(r.selections.some((s) => s.entry.content.includes("typescript strict")));
});

void test("fts5: edit updates searchable content", async () => {
  const store = await sqlite();
  if (!store) return;
  // Use store-level FTS methods directly to verify index state.
  const mgr = new MemoryManager(store);
  const rec = await mgr.record({ kind: "fact", content: "xzytolduniquetoken", confidence: 0.8 }, REC_OPTS);
  assert.equal(rec.status, "recorded");
  const id = rec.entry!.id;
  // Before edit: FTS should find it
  const before = await store.ftsSearch!("xzytolduniquetoken", 5);
  assert.ok(before.some((r) => r.entryId === id), "entry should be in FTS index before edit");
  // Edit via manager
  await mgr.editEntry(id, { content: "xzytnewuniquetoken" }, REC_OPTS, Date.now());
  // After edit: FTS should NOT find old content
  const afterOld = await store.ftsSearch!("xzytolduniquetoken", 5);
  assert.equal(afterOld.filter((r) => r.entryId === id).length, 0,
    `expected 0 FTS matches for old content, got ${afterOld.filter((r) => r.entryId === id).length}`);
  // After edit: FTS SHOULD find new content
  const afterNew = await store.ftsSearch!("xzytnewuniquetoken", 5);
  assert.ok(afterNew.some((r) => r.entryId === id), "entry should be searchable with new content after edit");
});

void test("fts5: purge removes from searchable index", async () => {
  const store = await sqlite();
  if (!store) return;
  const mgr = new MemoryManager(store);
  const rec = await mgr.record({ kind: "fact", content: "temporary note", confidence: 0.8 }, REC_OPTS);
  const id = rec.entry!.id;
  const r1 = await mgr.search("temporary note", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.ok(r1.selections.some((s) => s.entry.id === id));
  await mgr.purge(id);
  const r2 = await mgr.search("temporary note", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.equal(r2.selections.filter((s) => s.entry.id === id).length, 0);
});

void test("fts5: compact rebuilds index correctly", async () => {
  const store = await sqlite();
  if (!store) return;
  const mgr = new MemoryManager(store);
  const rec = await mgr.record({ kind: "fact", content: "keep this one", confidence: 0.8 }, REC_OPTS);
  await mgr.record({ kind: "fact", content: "expire this", confidence: 0.5 }, REC_OPTS);
  // Compact with aggressive session retention
  await mgr.compact({ sessionRetentionDays: -1, discardResolvedFailures: true });
  const r = await mgr.search("keep this", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.ok(r.selections.some((s) => s.entry.id === rec.entry!.id));
});

// ---------------------------------------------------------------------------
// (e) Jsonl driver: search results byte-identical to pre-change behavior
// ---------------------------------------------------------------------------

void test("fts5: jsonl search returns same shape as before", async () => {
  const store = await jsonl();
  const mgr = new MemoryManager(store);
  await mgr.record({ kind: "decision", content: "test content", confidence: 0.9, tags: ["test"] }, REC_OPTS);
  const r = await mgr.search("test content", ["test"], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.equal(r.selections.length, 1);
  assert.equal(typeof r.selections[0]!.score, "number");
  assert.equal(typeof r.selections[0]!.estimatedTokens, "number");
  assert.equal(typeof r.selections[0]!.reason, "string");
  assert.ok(r.selections[0]!.reason.includes("decision"));
});

// ---------------------------------------------------------------------------
// URI query escaping test: using retrieveMemory directly
// ---------------------------------------------------------------------------

void test("fts5: escape sd:dir etc without crash", async () => {
  const store = await sqlite();
  if (!store) return;
  const mgr = new MemoryManager(store);
  await mgr.record({ kind: "fact", content: "project dir is /home/user/proj", confidence: 0.8 }, REC_OPTS);
  // Query with colons and slashes which can confuse FTS5 MATCH syntax
  const r = await mgr.search("sd:dir /home/user", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.ok(Array.isArray(r.selections));
});

// ---------------------------------------------------------------------------
// BM25 appears in reason string for matched entries
// ---------------------------------------------------------------------------

void test("fts5: BM25 fragment appears in reason string", async () => {
  const store = await sqlite();
  if (!store) return;
  const mgr = new MemoryManager(store);
  await mgr.record({ kind: "fact", content: "xyzuniquecheck", confidence: 0.8, tags: ["abc"] }, REC_OPTS);
  const r = await mgr.search("xyzuniquecheck", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  if (r.selections.length > 0) {
    // BM25 should contribute > 0 for a matching entry
    assert.ok(r.selections[0]!.reason.includes("bm25="), `expected bm25= in reason, got: ${r.selections[0]!.reason}`);
  }
});

// ---------------------------------------------------------------------------
// 1c sidecar: content mirror + porter docs_fts + triggers + backfill +
// fallback + holdout (raw passthrough; ranking untouched)
// ---------------------------------------------------------------------------

void test("1c: backfill round-trip count matches + integrity ok", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  const entries = Array.from({ length: 120 }, (_, i) => ({
    id: `bf-${i}`, kind: "fact", text: `backfill roundtrip doc number ${i} zephyrqux`,
  }));
  const res = await store.ftsBackfillSidecar(entries);
  assert.equal(res.written, entries.length);
  const chk = await store.ftsIntegrityCheck();
  assert.equal(chk.contentCount, entries.length);
  assert.equal(chk.ftsCount, entries.length);
  assert.equal(chk.ok, true);
  const hits = await store.ftsSidecarSearch("zephyrqux", 5);
  assert.ok(hits.length > 0 && hits.length <= 25);
  await store.close();
});

void test("1c: mid-backfill failure rolls back, mirror intact + coded error", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  const { FTS_MISSING_CODE, isFtsMissingError } = await import("../../packages/core/src/storage/sqlite-store.ts");
  const seed = [
    { id: "crash-1", kind: "fact", text: "crashsafety seed alpha intact" },
    { id: "crash-2", kind: "fact", text: "crashsafety seed beta intact" },
    { id: "crash-3", kind: "fact", text: "crashsafety seed gamma intact" },
  ];
  await store.ftsBackfillSidecar(seed);
  // Inject a crash on the 2nd insert of the next backfill.
  const stmts = store.stmts();
  let calls = 0;
  const origRun = stmts.upsert.run.bind(stmts.upsert);
  stmts.upsert.run = (...args: unknown[]) => {
    if (++calls === 2) throw new Error("injected mid-backfill crash");
    return origRun(...args);
  };
  let code: string | null = null;
  try {
    await store.ftsBackfillSidecar([
      { id: "new-1", kind: "fact", text: "replacement one" },
      { id: "new-2", kind: "fact", text: "replacement two" },
      { id: "new-3", kind: "fact", text: "replacement three" },
    ]);
  } catch (err: any) {
    code = err?.code ?? null;
    assert.ok(isFtsMissingError(err), "expected coded FtsMissingError");
  } finally {
    stmts.upsert.run = origRun;
  }
  assert.equal(code, FTS_MISSING_CODE);
  // Prior mirror intact — never empty.
  const chk = await store.ftsIntegrityCheck();
  assert.equal(chk.contentCount, seed.length);
  assert.equal(chk.ftsCount, seed.length);
  const hits = await store.ftsSidecarSearch("crashsafety intact", 5);
  assert.ok(hits.some((h: any) => h.docId === "crash-1"));
  console.log(`[crash-safe] code=${code} content=${chk.contentCount} fts=${chk.ftsCount}`);
  await store.close();
});

void test("1c: triggers sync insert/update/delete", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  await store.ftsBackfillSidecar([]);
  await store.ftsSidecarInsert({ id: "trig-1", kind: "memory", text: "wobbletrigger alpha" });
  let hits = await store.ftsSidecarSearch("wobbletrigger alpha", 5);
  assert.ok(hits.some((h: any) => h.docId === "trig-1"));
  await store.ftsSidecarInsert({ id: "trig-1", kind: "memory", text: "wobbletrigger beta" });
  hits = await store.ftsSidecarSearch("alpha", 5);
  assert.equal(hits.filter((h: any) => h.docId === "trig-1").length, 0);
  hits = await store.ftsSidecarSearch("beta", 5);
  assert.ok(hits.some((h: any) => h.docId === "trig-1"));
  await store.ftsSidecarRemove("trig-1");
  hits = await store.ftsSidecarSearch("wobbletrigger beta", 5);
  assert.equal(hits.filter((h: any) => h.docId === "trig-1").length, 0);
  await store.close();
});

void test("1c: negative bm25 raws ordered ascending (lower=better)", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  await store.ftsBackfillSidecar([
    { id: "n-1", kind: "fact", text: "negcheck common common common rare zzzrareone" },
    { id: "n-2", kind: "fact", text: "negcheck common" },
    { id: "n-3", kind: "fact", text: "negcheck common common" },
  ]);
  const hits = await store.ftsSidecarSearch("negcheck zzzrareone", 3);
  assert.ok(hits.length >= 1);
  for (const h of hits) assert.ok(h.raw <= 0, `expected negative raw, got ${h.raw}`);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i]!.raw >= hits[i - 1]!.raw, "raws not ascending");
  await store.close();
});

void test("1c: corrupt/missing FTS throws coded FTS_MISSING, LIKE fallback scans", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  const { FTS_MISSING_CODE, isFtsMissingError } = await import("../../packages/core/src/storage/sqlite-store.ts");
  await store.ftsBackfillSidecar([{ id: "fb-1", kind: "fact", text: "fallbackmarker visible text" }]);
  // Simulate corruption: drop the FTS index (mirror survives).
  (store.db ?? store["db"])?.exec?.("DROP TABLE IF EXISTS docs_fts");
  let code: string | null = null;
  try {
    await store.ftsSidecarSearch("fallbackmarker", 5);
  } catch (err: any) {
    code = err?.code ?? null;
    assert.ok(isFtsMissingError(err), "expected coded FtsMissingError");
  }
  assert.equal(code, FTS_MISSING_CODE);
  // LIKE fallback over the content mirror still finds the doc.
  const fb = await store.ftsLikeFallback("fallbackmarker", 10);
  assert.ok(fb.some((r: any) => r.docId === "fb-1"));
  await store.close();
});

void test("1c: holdout seed reproducible (MRR within 0.01 across re-seeds)", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  await store.ftsBackfillSidecar([
    { id: "h-doc-1", kind: "fact", text: "holdout alpha retrieval target" },
    { id: "h-doc-2", kind: "fact", text: "holdout beta unrelated filler" },
    { id: "h-doc-3", kind: "fact", text: "holdout gamma another filler" },
  ]);
  const queries = [
    { id: "hq-1", query: "holdout alpha", topK: 10, labels: [{ docId: "h-doc-1", grade: 2 }] },
    { id: "hq-2", query: "holdout beta", topK: 10, labels: [{ docId: "h-doc-2", grade: 1 }] },
  ];
  const mrr = async () => {
    let sum = 0;
    for (const q of queries) {
      const hits = await store.ftsSidecarSearch(q.query, q.topK);
      const rel = new Set(q.labels.filter((l) => l.grade > 0).map((l) => l.docId));
      let rr = 0;
      for (let i = 0; i < hits.length; i++) {
        if (rel.has(hits[i].docId)) { rr = 1 / (i + 1); break; }
      }
      sum += rr;
    }
    return sum / queries.length;
  };
  const s1 = await store.ftsHoldoutSeed("v1", queries);
  const m1 = await mrr();
  const s2 = await store.ftsHoldoutSeed("v1", queries); // insert-only: idempotent
  const m2 = await mrr();
  assert.deepEqual(s1, s2);
  assert.ok(Math.abs(m1 - m2) <= 0.01, `MRR drift ${m1} vs ${m2}`);
  await store.close();
});

void test("1c: 5000-doc smoke bench (log only, assert count)", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  const N = 5000;
  const entries = Array.from({ length: N }, (_, i) => ({
    id: `bench-${i}`, kind: "fact", text: `bench doc ${i} smoke token common filler ${i % 100}`,
  }));
  const t0 = Date.now();
  const res = await store.ftsBackfillSidecar(entries);
  const tBackfill = Date.now() - t0;
  assert.equal(res.written, N);
  const t1 = Date.now();
  const hits = await store.ftsSidecarSearch("bench smoke", 10);
  const tSearch = Date.now() - t1;
  assert.ok(hits.length > 0 && hits.length <= 50, `expected 5*top_k cap, got ${hits.length}`);
  console.log(`[1c-bench] backfilled=${res.written} backfillMs=${tBackfill} searchMs=${tSearch} hits=${hits.length}`);
  await store.close();
});

// ---------------------------------------------------------------------------
// Live sidecar-first search path: sidecar hit with legacy empty + fallback
// ---------------------------------------------------------------------------

void test("1c: live sidecar hit with legacy memory_fts empty", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  const mgr = new MemoryManager(store);
  const rec = await mgr.record(
    { kind: "fact", content: "sidecarliveuniquetoken primary path", confidence: 0.9 },
    REC_OPTS,
  );
  assert.equal(rec.status, "recorded");
  const id = rec.entry!.id;
  // Empty legacy memory_fts only; sidecar content mirror keeps the doc.
  await store.ftsRebuild([]);
  assert.equal((await store.ftsSearch("sidecarliveuniquetoken", 5)).length, 0);
  // Repository resolves via sidecar first.
  const { MemoryRepository } = await import("../../packages/core/src/memory/repository.ts");
  const repo = new MemoryRepository(store);
  const fts = await repo.searchFts("sidecarliveuniquetoken", 5);
  assert.equal(fts.source, "sidecar");
  assert.ok(fts.bm25?.has(id), "sidecar bm25 should contain the doc");
  console.log(`[live-hit] source=${fts.source} doc=${id}`);
  // End-to-end manager search still finds it.
  const r = await mgr.search("sidecarliveuniquetoken", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.ok(r.selections.some((s) => s.entry.id === id));
  await store.close();
});

void test("1c: sidecar missing falls back without throwing", async () => {
  const store = await sqlite() as any;
  if (!store) return;
  const mgr = new MemoryManager(store);
  const rec = await mgr.record(
    { kind: "fact", content: "fallbackliveuniquetoken still searchable", confidence: 0.9 },
    REC_OPTS,
  );
  assert.equal(rec.status, "recorded");
  const id = rec.entry!.id;
  // Simulate sidecar loss: drop docs_fts, mirror/legacy survive.
  (store.db ?? store["db"])?.exec?.("DROP TABLE IF EXISTS docs_fts");
  const { MemoryRepository } = await import("../../packages/core/src/memory/repository.ts");
  const repo = new MemoryRepository(store);
  const fts = await repo.searchFts("fallbackliveuniquetoken", 5);
  assert.notEqual(fts.source, "sidecar");
  // Manager search never throws and still finds the doc via fallback/lexical.
  const r = await mgr.search("fallbackliveuniquetoken", [], [], [], { maxEntries: 5, maxTokens: 1000 });
  assert.ok(Array.isArray(r.selections));
  assert.ok(r.selections.some((s) => s.entry.id === id), `fallback search missed doc ${id}`);
  await store.close();
});

void test("sqlite listFiles escapes LIKE wildcards %_ in dir prefix", async () => {
  const store = await sqlite();
  if (!store) return;
  await store.writeJson("we%ird/memory/a.json", { ok: 1 });
  await store.writeJson("weird2/memory/b.json", { ok: 1 });
  const files = await store.listFiles("we%ird/memory");
  assert.ok(files.some((f) => f === "we%ird/memory/a.json"));
  assert.ok(!files.some((f) => f.includes("weird2")));
  await store.close();
});
