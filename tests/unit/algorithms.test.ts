/**
 * Algorithmic correctness & tricky boundary tests. These target exact behaviors
 * that are easy to get subtly wrong: ranking order, duplicate precision,
 * JSONC edge cases, compaction safety, budget accounting, and porcelain parsing.
 */
import test from "node:test";
import assert from "node:assert";
import {
  buildQueryContext,
  scoreMemory,
  scoreFile,
  retrieveMemory,
  detectDuplicateTasks,
  detectOverlaps,
  parallelSafety,
  compactMemory,
  buildContextPacket,
  planOwnership,
} from "../../packages/core/src/index.ts";
import { tokenize } from "../../packages/core/src/memory/ranking.ts";
import type { MemoryEntry, IndexedFile, PlannedTask } from "../../packages/core/src/index.ts";
import { stripJsonc } from "../../packages/opencode/src/config-loader.ts";
import { parsePorcelain } from "../../packages/opencode/src/lifecycle.ts";

function mem(partial: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  const now = new Date().toISOString();
  return {
    kind: "fact",
    createdAt: now,
    updatedAt: now,
    confidence: 0.8,
    status: "active",
    sourceReferences: [],
    relatedFiles: [],
    relatedSymbols: [],
    tags: [],
    invalidationRules: [],
    ...partial,
  };
}

test("ranking: constraint outranks a fact with identical lexical match", () => {
  const ctx = buildQueryContext("database migration", [], [], []);
  const now = Date.now();
  const fact = mem({ id: "f", kind: "fact", content: "database migration uses flyway" });
  const constraint = mem({ id: "c", kind: "constraint", content: "database migration uses flyway" });
  assert.ok(
    scoreMemory(constraint, ctx, now) > scoreMemory(fact, ctx, now),
    "constraint kind weight boosts it above an identical fact",
  );
});

test("ranking: disputed entry is excluded from automatic retrieval", () => {
  const ctx = buildQueryContext("auth flow", [], [], []);
  const now = Date.now();
  const active = mem({ id: "a", content: "auth flow uses jwt", status: "active" });
  const disputed = mem({ id: "d", content: "auth flow uses jwt", status: "disputed" });
  assert.ok(scoreMemory(active, ctx, now) > 0);
  assert.equal(scoreMemory(disputed, ctx, now), 0);
});

test("tokenize preserves Unicode words, CJK terms, and camelCase identifier parts", () => {
  const tokens = tokenize("إدارة المستخدم userSessionToken 用户认证");
  assert.ok(tokens.includes("إدارة"));
  assert.ok(tokens.includes("المستخدم"));
  assert.ok(tokens.includes("user"));
  assert.ok(tokens.includes("session"));
  assert.ok(tokens.includes("token"));
  assert.ok(tokens.includes("用"));
  assert.ok(tokens.includes("认"));
});

test("ranking: recency breaks ties between otherwise-identical entries", () => {
  const ctx = buildQueryContext("cache layer", [], [], []);
  const now = Date.now();
  const fresh = mem({ id: "n", content: "cache layer redis", updatedAt: new Date(now).toISOString() });
  const old = mem({
    id: "o",
    content: "cache layer redis",
    updatedAt: new Date(now - 25 * 86400000).toISOString(),
  });
  assert.ok(scoreMemory(fresh, ctx, now) > scoreMemory(old, ctx, now));
});

test("retrieval: respects maxEntries and maxTokens simultaneously", () => {
  const ctx = buildQueryContext("widget", [], [], []);
  const entries = Array.from({ length: 50 }, (_, i) =>
    mem({ id: `e${i}`, content: `widget handler number ${i} does widget things` }),
  );
  const res = retrieveMemory(entries, ctx, { maxEntries: 5, maxTokens: 100000 });
  assert.ok(res.selected.length <= 5, "entry cap honored");
  const tokenCapped = retrieveMemory(entries, ctx, { maxEntries: 999, maxTokens: 30 });
  const total = tokenCapped.selected.reduce((a, s) => a + s.estimatedTokens, 0);
  assert.ok(total <= 30, "token cap honored");
});

test("scoreFile: hinted file always outranks a same-lexical non-hinted file", () => {
  const ctx = buildQueryContext("parser", [], ["src/parser.ts"], []);
  const hinted = scoreFile({ path: "src/parser.ts", symbols: ["parse"] }, ctx, true);
  const other = scoreFile({ path: "lib/parser.ts", symbols: ["parse"] }, ctx, true);
  assert.ok(hinted > other, "caller hint dominates");
});

test("file scoring ignores task prose so a checkout path survives selection", () => {
  const ctx = buildQueryContext("Locate the checkout payment flow and the file that creates the payment session", [], [], []);
  const checkout = scoreFile({ path: "blueprint/specs/04-checkout.md", symbols: [] }, ctx, true);
  const unrelated = scoreFile({ path: "src/lib/ghost.ts", symbols: [] }, ctx, true);
  assert.ok(checkout >= 0.15, `checkout path score ${checkout} must reach selector threshold`);
  assert.equal(unrelated, 0);
  const changed = buildQueryContext(ctx.query, [], [], ["package-lock.json"]);
  assert.equal(scoreFile({ path: "package-lock.json", symbols: [] }, changed, true), 0);
});

test("duplicate detection: near-identical objectives grouped, distinct ones not", () => {
  const tasks: PlannedTask[] = [
    pt("a", "research the authentication and session handling in the codebase"),
    pt("b", "research the authentication and session handling in the codebase thoroughly"),
    pt("c", "completely unrelated: optimize the image resizing pipeline"),
  ];
  const groups = detectDuplicateTasks(tasks);
  assert.equal(groups.length, 1, "one duplicate group");
  assert.ok(groups[0]!.taskIds.includes("a") && groups[0]!.taskIds.includes("b"));
  assert.ok(!groups[0]!.taskIds.includes("c"), "distinct task not grouped");
});

test("parallel-safety: transitive write/read chains are all flagged unsafe", () => {
  const a = pt("a", "", ["shared.ts"]);
  a.writeScope = ["shared.ts"];
  const b = pt("b", "", []);
  b.readScope = ["shared.ts"];
  b.writeScope = ["b.ts"];
  const safeA = parallelSafety(a, [a, b]);
  const safeB = parallelSafety(b, [a, b]);
  assert.ok(!safeB.safe, "reader of a written file is unsafe");
  // a writes shared.ts and b reads it: a alone (no deps, unique write) is safe.
  assert.ok(safeA.safe, "sole writer with no deps is safe");
});

test("overlap detection is symmetric and complete for N tasks", () => {
  const tasks = [pt("a", "", []), pt("b", "", []), pt("c", "", [])];
  tasks[0]!.writeScope = ["x.ts", "y.ts"];
  tasks[1]!.writeScope = ["y.ts"];
  tasks[2]!.writeScope = ["z.ts"];
  const overlaps = detectOverlaps(tasks);
  // Only a<->b overlap on y.ts.
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0]!.files, ["y.ts"]);
});

test("planOwnership: a file is assigned to exactly one task, rest are conflicts", () => {
  const { assignments, conflicts } = planOwnership([
    { id: "a", writeScope: ["shared.ts", "a-only.ts"] },
    { id: "b", writeScope: ["shared.ts"] },
    { id: "c", writeScope: ["shared.ts"] },
  ]);
  assert.ok(assignments.a!.includes("shared.ts"), "first claimant owns it");
  assert.ok(!assignments.b!.includes("shared.ts"));
  const shared = conflicts.find((c) => c.path === "shared.ts");
  assert.ok(shared, "conflict recorded");
  assert.ok(shared!.taskIds.includes("a") && shared!.taskIds.includes("b") && shared!.taskIds.includes("c"));
});

test("compaction: durable entries survive sessionRetentionDays past the window", () => {
  const now = Date.now();
  const old = new Date(now - 30 * 86400000).toISOString(); // 30 days ago
  const entries: MemoryEntry[] = [
    mem({
      id: "old-fact",
      kind: "fact",
      content: "old but durable fact",
      createdAt: old,
    }),
    mem({
      id: "old-candidate",
      kind: "fact",
      content: "old session scoped",
      createdAt: old,
      status: "candidate",
    }),
    mem({
      id: "old-forgotten",
      kind: "failure",
      content: "forgotten failure",
      createdAt: old,
      status: "forgotten",
    }),
  ];
  const res = compactMemory(entries, { sessionRetentionDays: 7, now });
  // Durable fact kept untouched
  const fact = res.kept.find((e) => e.id === "old-fact");
  assert.ok(fact, "durable fact kept");
  assert.equal(fact!.status, "active", "durable fact unchanged");
  // Session-scoped candidate expired
  const cand = res.kept.find((e) => e.id === "old-candidate");
  assert.ok(cand, "candidate still reviewable");
  assert.equal(cand!.status, "stale", "candidate expired to stale");
  const forg = res.kept.find((e) => e.id === "old-forgotten");
  assert.ok(forg, "forgotten still reviewable");
  assert.equal(forg!.status, "stale", "forgotten expired to stale");
  assert.equal(res.expired, 2, "two session-scoped entries expired");
});

test("compaction: discardResolvedFailures prunes old resolved failures", () => {
  const now = Date.now();
  const old = new Date(now - 30 * 86400000).toISOString();
  const entries: MemoryEntry[] = [
    mem({
      id: "old-stale-failure",
      kind: "failure",
      content: "old stale failure",
      status: "stale",
      createdAt: old,
    }),
    mem({
      id: "active-failure",
      kind: "failure",
      content: "active failure never pruned",
      createdAt: old,
    }),
  ];
  const res = compactMemory(entries, { sessionRetentionDays: 7, discardResolvedFailures: true, now });
  assert.ok(!res.kept.some((e) => e.id === "old-stale-failure"), "old stale failure pruned");
  assert.ok(res.kept.some((e) => e.id === "active-failure"), "active failure kept");
  assert.ok(res.auditTrail.some((a) => a.id === "old-stale-failure" && a.action === "pruned"), "pruned audit trail");
});

test("compaction NEVER drops unresolved failures/constraints even when expired", () => {
  const now = Date.now();
  const past = new Date(now - 1000).toISOString();
  const entries: MemoryEntry[] = [
    mem({
      id: "f",
      kind: "failure",
      content: "flaky test on CI",
      invalidationRules: [{ kind: "time-elapsed", expiresAt: past }],
    }),
    mem({
      id: "c",
      kind: "constraint",
      content: "never touch prod db",
      invalidationRules: [{ kind: "time-elapsed", expiresAt: past }],
    }),
    mem({
      id: "x",
      kind: "fact",
      content: "temporary fact",
      invalidationRules: [{ kind: "time-elapsed", expiresAt: past }],
    }),
  ];
  const res = compactMemory(entries, { sessionRetentionDays: 14, now });
  const keptIds = res.kept.map((e) => e.id);
  assert.ok(keptIds.includes("f"), "expired failure kept (as stale)");
  assert.ok(keptIds.includes("c"), "expired constraint kept (as stale)");
  assert.equal(res.expired, 3, "all expired entries transition without physical deletion");
  assert.ok(keptIds.includes("x"), "expired fact remains reviewable as stale");
});

test("compaction marks explicitly-superseded entries and preserves audit trail", () => {
  const entries: MemoryEntry[] = [
    mem({ id: "old", content: "we use webpack" }),
    mem({ id: "new", content: "we use vite now", supersedes: ["old"] }),
  ];
  const res = compactMemory(entries, { sessionRetentionDays: 14 });
  const old = res.kept.find((e) => e.id === "old")!;
  assert.equal(old.status, "superseded");
  assert.ok(res.auditTrail.some((a) => a.id === "old" && a.action === "superseded"));
});

test("budget: total estimated tokens never exceed maxTokens; oversized memory is omitted", () => {
  // A single constraint far larger than the budget must NOT be force-selected;
  // memory retrieval is capped at min(maxRetrievedTokens, remaining budget).
  const bigConstraint = mem({
    id: "c",
    kind: "constraint",
    content: "build ".repeat(1000), // ~ >1000 tokens
    tags: ["build"],
  });
  const smallConstraint = mem({
    id: "s",
    kind: "constraint",
    content: "keep build under budget",
    tags: ["build"],
  });
  const index: Record<string, IndexedFile> = {
    "a.ts": {
      path: "a.ts",
      hash: "h",
      sizeBytes: 4000,
      estimatedTokens: 1000,
      symbols: ["build"],
      imports: [],
      indexedAt: new Date().toISOString(),
      mtimeMs: 1,
    },
  };
  const maxTokens = 60;
  const res = buildContextPacket({
    task: { query: "build config", tags: ["build"] },
    config: {
      maxTokens,
      maxRetrievedEntries: 10,
      maxRetrievedTokens: 100000,
      maxRecommendedReads: 6,
      summaryThresholdTokens: 3000,
      preferChangedFiles: true,
    },
    index,
    summaries: {},
    memory: [bigConstraint, smallConstraint],
    cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
  });
  // The oversized constraint cannot fit and must be omitted from memory.
  assert.ok(
    !res.packet.selectedMemory.some((m) => m.entry.id === "c"),
    "oversized constraint omitted",
  );
  // The small one fits.
  assert.ok(res.packet.selectedMemory.some((m) => m.entry.id === "s"), "small constraint selected");
  // Total estimated tokens stay within budget.
  assert.ok(res.packet.estimatedTokens <= maxTokens, "budget never exceeded");
  // budget snapshot is internally consistent.
  assert.equal(
    res.packet.budget.usedTokens + res.packet.budget.remainingTokens,
    res.packet.budget.maxTokens,
  );
});

// ---- JSONC torture ----
test("stripJsonc handles comments/strings/trailing commas without corrupting data", () => {
  const input = `{
    // line comment with "quotes" and { braces }
    "url": "https://example.com/path?a=1&b=2", /* inline */ 
    "regex": "a//b/*c*/d",           // string containing comment-like sequences
    "escaped": "quote \\" and slash \\\\",
    "nested": { "arr": [1, 2, 3,], }, /* trailing commas */
    "last": true,
  }`;
  const parsed = JSON.parse(stripJsonc(input));
  assert.equal(parsed.url, "https://example.com/path?a=1&b=2");
  assert.equal(parsed.regex, "a//b/*c*/d", "comment-like content inside strings preserved");
  assert.equal(parsed.escaped, 'quote " and slash \\');
  assert.deepEqual(parsed.nested.arr, [1, 2, 3]);
  assert.equal(parsed.last, true);
});

test("stripJsonc does not strip a URL's // inside a string value", () => {
  const parsed = JSON.parse(stripJsonc('{"u":"http://a.com","v":1}'));
  assert.equal(parsed.u, "http://a.com");
  assert.equal(parsed.v, 1);
});

// ---- git porcelain parsing ----
test("parsePorcelain classifies staged/unstaged/untracked and branch", () => {
  const out = [
    "## main...origin/main [ahead 1]",
    "M  staged-only.ts",
    " M unstaged.ts",
    "MM both.ts",
    "?? new-file.ts",
    "A  added.ts",
  ].join("\n");
  const g = parsePorcelain(out);
  assert.equal(g.branch, "main");
  assert.ok(g.staged.includes("staged-only.ts"));
  assert.ok(g.staged.includes("added.ts"));
  assert.ok(g.untracked.includes("new-file.ts"));
  assert.ok(g.changedFiles.includes("both.ts"));
  assert.ok(!g.changedFiles.includes("new-file.ts"), "untracked not in changed");
});

function pt(id: string, objective: string, read: string[] = []): PlannedTask {
  return {
    id,
    title: id,
    objective: objective || id,
    dependencies: [],
    readScope: read,
    writeScope: [],
    contextBudgetTokens: 1000,
    parallelSafe: true,
    parallelSafetyReason: "",
    completionCriteria: [],
  };
}

// ---- Real BM25 + RRF fusion (1a scorer + 1b blender) ----
// Reason for new tests: old suite covered BoW ordering only; these pin the
// ATIRE/Robertson BM25 core, rank-only RRF fusion, FTS sign handling, and the
// rank-cutoff that replaces the arbitrary 0.05/0.15 thresholds.

test("bm25: short exact doc outranks long padded doc with same terms (length-norm beats BoW)", async () => {
  const { buildCorpusStats, scoreMemory: sm, buildQueryContext: bqc } = await import(
    "../../packages/core/src/memory/ranking.ts"
  );
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const short = mem({ id: "short", content: "quasarturbine manual", updatedAt: iso });
  const long = mem({
    id: "long",
    content: `quasarturbine ${"filler words about everything ".repeat(60)} manual`,
    updatedAt: iso,
  });
  const stats = buildCorpusStats([short, long]);
  const ctx = bqc("quasarturbine manual", [], [], []);
  const sShort = sm(short, ctx, now, stats);
  const sLong = sm(long, ctx, now, stats);
  assert.ok(sShort > sLong, `BM25 length-norm must prefer concise match (${sShort} vs ${sLong})`);
  // Old BoW baseline (count/queryLen) ties or favors the padded doc — prove the flip.
  const bow = (c: string) => ["quasarturbine", "manual"].filter((t) => c.includes(t)).length / 2;
  assert.ok(bow(long.content) >= bow(short.content), "fixture check: BoW cannot separate them");
});

test("bm25: Robertson IDF downweights ubiquitous terms", async () => {
  const { bm25Idf } = await import("../../packages/core/src/memory/ranking.ts");
  assert.ok(bm25Idf(100, 100) < bm25Idf(1, 100), "rare term must score higher IDF");
  assert.ok(Number.isFinite(bm25Idf(0, 0)) && bm25Idf(0, 0) === 0, "empty corpus → 0, no NaN");
});

test("rrf: beats additive blend MRR by >=0.05 on mini-holdout fixture", async () => {
  const { rrfFuse } = await import("../../packages/core/src/memory/retrieval.ts");
  // Frozen 2-query fixture: FTS returns a subset (lexical top doc absent from
  // FTS). Old additive blend (lexScore + 0.5/(1+rank), absent → +0) keeps the
  // distractor on top; rank-only RRF lifts the doc ranked well in both.
  const queries = [
    { lex: ["d1", "rel1"], lexScores: { d1: 1.5, rel1: 1.0 }, fts: ["rel1"], rel: "rel1" },
    { lex: ["rel2", "d2"], lexScores: { rel2: 1.6, d2: 1.2 }, fts: ["rel2", "d2"], rel: "rel2" },
  ];
  const rr = (order: string[], rel: string) => {
    const i = order.indexOf(rel);
    return i < 0 ? 0 : 1 / (i + 1);
  };
  let addSum = 0;
  let rrfSum = 0;
  for (const q of queries) {
    // Additive baseline (old production formula).
    const ftsRank = new Map(q.fts.map((id, i) => [id, i]));
    const additive = [...q.lex].sort(
      (a, b) =>
        (q.lexScores[b as keyof typeof q.lexScores] ?? 0) +
          (ftsRank.has(b) ? 0.5 / (1 + ftsRank.get(b)!) : 0) -
          ((q.lexScores[a as keyof typeof q.lexScores] ?? 0) + (ftsRank.has(a) ? 0.5 / (1 + ftsRank.get(a)!) : 0)),
    );
    addSum += rr(additive, q.rel);
    // RRF fusion (k=60 default).
    const fused = rrfFuse([q.lex, q.fts], 60);
    const rrfOrder = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    rrfSum += rr(rrfOrder, q.rel);
  }
  const mrrAdd = addSum / queries.length;
  const mrrRrf = rrfSum / queries.length;
  assert.ok(mrrRrf - mrrAdd >= 0.05, `RRF MRR ${mrrRrf} must beat additive ${mrrAdd} by >=0.05`);
});

test("retrieval: FTS rank lifts relevant doc via RRF; BM25-only fallback when lexical filtered", () => {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const entries = [
    mem({ id: "d1", content: "quasarturbine overview notes", tags: ["boost"], updatedAt: iso }),
    mem({ id: "rel", content: "quasarturbine turbine calibration", updatedAt: iso }),
  ];
  const ctx = buildQueryContext("quasarturbine calibration", ["boost"], [], []);
  const plain = retrieveMemory(entries, ctx, { maxEntries: 5, maxTokens: 100000 });
  // sqlite bm25() style: negative raws, lower=better. FTS returns a subset
  // (lexical top doc d1 absent) so rank-only RRF lifts the FTS-top doc
  // instead of tying symmetrically. (Tag boost puts d1 first lexically;
  // a mirrored 2x2 list pair ties exactly under RRF by construction.)
  const withFts = retrieveMemory(entries, ctx, {
    maxEntries: 5,
    maxTokens: 100000,
    bm25: new Map([["rel", -8.2]]),
  });
  assert.equal(withFts.selected[0]!.entry.id, "rel", "RRF must surface FTS-top doc");
  assert.ok(withFts.selected[0]!.reason.includes("fts rank #1"), "reason must carry FTS rank");
  assert.ok(withFts.selected[0]!.reason.includes("rrf="), "reason must carry RRF score");
  // BM25-only fallback: lexical side fully filtered, FTS doc still retrieved.
  const fallback = retrieveMemory(entries, ctx, {
    maxEntries: 5,
    maxTokens: 100000,
    minScore: 999,
    bm25: new Map([["rel", -8.2]]),
  });
  assert.equal(fallback.selected.length, 1, "single-source fallback without fusion");
  assert.equal(fallback.selected[0]!.entry.id, "rel");
  assert.ok(fallback.selected[0]!.score > 0, "M1: fallback backfills non-zero score from ftsNorm");
  void plain;
});

test("retrieval: negative FTS raws normalize to [0,1] with best→1; ordering ascending", async () => {
  const { normalizeFtsScores, orderFtsIds } = await import(
    "../../packages/core/src/memory/retrieval.ts"
  );
  const raw = new Map([["a", -1.1], ["b", -8.2], ["c", -3.0]]);
  assert.deepEqual(orderFtsIds(raw), ["b", "c", "a"], "lower=better even when negative");
  const norm = normalizeFtsScores(raw);
  for (const v of norm.values()) assert.ok(v >= 0 && v <= 1, "normalized to [0,1]");
  assert.equal(norm.get("b"), 1, "best FTS doc → 1");
  assert.ok(norm.get("b")! > norm.get("c")! && norm.get("c")! > norm.get("a")!, "order preserved");
  // Non-negative raws (already rank-like) behave identically.
  assert.deepEqual(orderFtsIds(new Map([["x", 5], ["y", 0.2]])), ["y", "x"]);
});

test("retrieval: rankCutoff replaces arbitrary thresholds (sweep); minScore stays backward-compat", () => {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const entries = Array.from({ length: 6 }, (_, i) =>
    mem({ id: `e${i}`, content: `widget handler number ${i} does widget things`, updatedAt: iso }),
  );
  const ctx = buildQueryContext("widget", [], [], []);
  const cut1 = retrieveMemory(entries, ctx, { maxEntries: 5, maxTokens: 100000, rankCutoff: 1 });
  const cut3 = retrieveMemory(entries, ctx, { maxEntries: 5, maxTokens: 100000, rankCutoff: 3 });
  assert.equal(cut1.selected.length, 1, "rankCutoff:1 keeps top rank only");
  assert.equal(cut3.selected.length, 3, "rankCutoff:3 keeps top three");
  assert.equal(cut3.selected[0]!.entry.id, cut1.selected[0]!.entry.id, "cutoff is a prefix of fused order");
  // Default path (no rankCutoff) still honors legacy minScore pre-filter.
  const def = retrieveMemory(entries, ctx, { maxEntries: 5, maxTokens: 100000 });
  assert.ok(def.selected.length > 0, "backward-compat default still retrieves");
  assert.equal(retrieveMemory([], ctx, { maxEntries: 5, maxTokens: 100 }).considered, 0, "empty corpus → empty");
});

test("m2 guards: single-pass tokens, saturated bm25, nan/zero params, sanitized explain", async () => {
  const { buildCorpusStats, saturateBm25 } = await import(
    "../../packages/core/src/memory/ranking.ts"
  );
  // BM25 saturation maps unbounded scores to ~0..1.
  assert.equal(saturateBm25(0), 0);
  assert.equal(saturateBm25(NaN), 0);
  const s = saturateBm25(10);
  assert.ok(s > 0 && s < 1, "unbounded BM25 must saturate below 1");
  // Single tokenization pass: pre-tokenized scoring matches fresh scoring.
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const entries = [
    mem({ id: "g1", content: "quasarturbine calibration rotor", updatedAt: iso }),
    mem({ id: "g2", content: "unrelated pantry inventory list", updatedAt: iso }),
  ];
  const ctx = buildQueryContext("quasarturbine calibration", [], [], []);
  const cache: string[][] = [];
  const stats = buildCorpusStats(entries, cache);
  assert.equal(cache.length, 2, "single pass fills token cache");
  assert.equal(
    scoreMemory(entries[0]!, ctx, now, stats, {}, cache[0]),
    scoreMemory(entries[0]!, ctx, now, stats),
    "pre-tokenized score must equal re-tokenized score",
  );
  // Recency window <= 0 disables recency (finite score, no NaN).
  const noRec = scoreMemory(entries[0]!, ctx, now, stats, { recencyWindowDays: 0 });
  const noRecW = scoreMemory(entries[0]!, ctx, now, stats, { recencyWeight: 0 });
  assert.ok(Number.isFinite(noRec), "recencyWindow 0 must not NaN");
  assert.equal(noRec, noRecW, "window<=0 disables recency term");
  // NaN rrfK/overFetch fall back to defaults (no throw, non-empty).
  const bad = retrieveMemory(entries, ctx, {
    maxEntries: 2,
    maxTokens: 100000,
    rrfK: NaN,
    overFetch: NaN,
  });
  assert.ok(bad.selected.length > 0, "NaN fusion params must use defaults");
  // Explain: newline with long content stays <=200 chars, single line.
  const nasty = mem({
    id: "gx",
    content: "alpha\nbeta\ngamma ".repeat(30) + "quasarturbine",
    updatedAt: iso,
  });
  const r = retrieveMemory([nasty], buildQueryContext("quasarturbine", [], [], []), {
    maxEntries: 1,
    maxTokens: 100000,
  });
  const reason = r.selected[0]!.reason;
  assert.ok(!/[\r\n\t]/.test(reason), "explain must strip newlines/tabs");
  assert.ok(reason.length <= 200, `explain must truncate to 200 (got ${reason.length})`);
});

test("m2 explain strips ANSI/control sequences to a single line", () => {
  const esc = String.fromCharCode(27);
  const nasty = mem({
    id: "ansi",
    content: `${esc}[31mred${esc}[0m quasarturbine${String.fromCharCode(1)}tail`,
    tags: [`${esc}[1mbold${esc}[0m`],
    updatedAt: new Date().toISOString(),
  });
  const r = retrieveMemory([nasty], buildQueryContext("quasarturbine", [], [], []), {
    maxEntries: 1,
    maxTokens: 100000,
  });
  const reason = r.selected[0]!.reason;
  assert.ok(!reason.includes(esc), "ANSI escape must be stripped");
  assert.ok(!/[\r\n\t]/.test(reason), "single line");
  assert.ok(reason.length <= 200, "truncate 200");
});
