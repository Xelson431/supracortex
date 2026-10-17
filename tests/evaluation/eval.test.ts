/**
 * Smoke test for the evaluation corpus + harness.
 *
 * Checks:
 *   1. Corpus integrity: counts, unique IDs, label references, holdout disjoint.
 *   2. Mini-run (10 queries) of harness against both retrievers: metrics in [0,1],
 *      zero harmful/stale rate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_VERSION = "1.0.1";

interface CorpusEntry {
  id: string;
  kind: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  confidence: number;
  status: string;
  sourceReferences: Array<{ kind: string; value: string; hash?: string }>;
  relatedFiles: string[];
  relatedSymbols: string[];
  tags: string[];
  invalidationRules: Array<{ kind: string; target?: string; expiresAt?: string }>;
  supersedes?: string[];
  origin?: string;
}

interface LabeledQuery {
  id: string;
  query: string;
  relevantEntryIds: string[];
  harmfulEntryIds: string[];
  annotator: string;
  rationale: string;
  isHoldout: boolean;
  queryClass: string;
}

interface CorpusFile {
  version: string;
  generatedAt: string;
  totalEntries: number;
  totalQueries: number;
  holdoutQueries: number;
  negativeQueries: number;
  entries: CorpusEntry[];
  queries: LabeledQuery[];
}

// ---------------------------------------------------------------------------
// Corpus integrity
// ---------------------------------------------------------------------------

void test("eval: corpus meets minimum counts", () => {
  const corpus = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}.json`), "utf8"),
  ) as CorpusFile;
  const holdout = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}-holdout.json`), "utf8"),
  ) as LabeledQuery[];

  assert.equal(corpus.version, CORPUS_VERSION, "corpus version mismatch");

  const totalQueries = corpus.totalQueries + holdout.length;
  assert.ok(totalQueries >= 200, `total queries ${totalQueries} < 200`);
  assert.ok(holdout.length >= 50, `holdout queries ${holdout.length} < 50`);
  assert.ok(
    corpus.negativeQueries >= 100,
    `negative queries ${corpus.negativeQueries} < 100`,
  );

  // All holdout queries marked isHoldout
  for (const q of holdout) {
    assert.ok(q.isHoldout, `holdout query ${q.id} not marked holdout`);
  }
});

void test("eval: all entry IDs are unique", () => {
  const corpus = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}.json`), "utf8"),
  ) as CorpusFile;
  const ids = corpus.entries.map((e) => e.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "duplicate entry IDs found");
});

void test("eval: all query IDs are unique", () => {
  const corpus = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}.json`), "utf8"),
  ) as CorpusFile;
  const holdout = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}-holdout.json`), "utf8"),
  ) as LabeledQuery[];
  const qIds = [...corpus.queries.map((q: LabeledQuery) => q.id), ...holdout.map((q) => q.id)];
  const unique = new Set(qIds);
  assert.equal(unique.size, qIds.length, "duplicate query IDs found");
});

void test("eval: label references point to existing entries", () => {
  const corpus = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}.json`), "utf8"),
  ) as CorpusFile;
  const holdout = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}-holdout.json`), "utf8"),
  ) as LabeledQuery[];

  const entryIds = new Set(corpus.entries.map((e) => e.id));
  const allQueries = [...corpus.queries, ...holdout] as LabeledQuery[];

  for (const q of allQueries) {
    for (const id of q.relevantEntryIds) {
      assert.ok(entryIds.has(id), `query ${q.id} references nonexistent relevant entry ${id}`);
    }
    for (const id of q.harmfulEntryIds) {
      assert.ok(entryIds.has(id), `query ${q.id} references nonexistent harmful entry ${id}`);
    }
  }
});

void test("eval: no harmful label refers to an active entry", () => {
  const corpus = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}.json`), "utf8"),
  ) as CorpusFile;
  const holdout = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}-holdout.json`), "utf8"),
  ) as LabeledQuery[];

  const statusById = new Map(corpus.entries.map((e) => [e.id, e.status]));
  const allQueries = [...corpus.queries, ...holdout] as LabeledQuery[];

  for (const q of allQueries) {
    for (const id of q.harmfulEntryIds) {
      assert.notEqual(
        statusById.get(id),
        "active",
        `query ${q.id} labels active entry ${id} as harmful; active corrective facts belong in relevantEntryIds`,
      );
    }
  }
});

void test("eval: label arrays contain no duplicate ids", () => {
  const corpus = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}.json`), "utf8"),
  ) as CorpusFile;
  const holdout = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}-holdout.json`), "utf8"),
  ) as LabeledQuery[];

  const allQueries = [...corpus.queries, ...holdout] as LabeledQuery[];
  for (const q of allQueries) {
    assert.equal(
      new Set(q.relevantEntryIds).size,
      q.relevantEntryIds.length,
      `query ${q.id} has duplicate relevant ids`,
    );
    assert.equal(
      new Set(q.harmfulEntryIds).size,
      q.harmfulEntryIds.length,
      `query ${q.id} has duplicate harmful ids`,
    );
  }
});

void test("eval: holdout queries are disjoint from tuning set", () => {
  const corpus = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}.json`), "utf8"),
  ) as CorpusFile;
  const holdout = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}-holdout.json`), "utf8"),
  ) as LabeledQuery[];

  const tuningIds = new Set(corpus.queries.map((q: LabeledQuery) => q.id));
  for (const q of holdout) {
    assert.ok(!tuningIds.has(q.id), `holdout query ${q.id} also exists in tuning set`);
  }
});

void test("eval: entries cover all kinds and statuses", () => {
  const corpus = JSON.parse(
    readFileSync(join(here, `corpus-${CORPUS_VERSION}.json`), "utf8"),
  ) as CorpusFile;

  const kinds = new Set(corpus.entries.map((e) => e.kind));
  const statuses = new Set(corpus.entries.map((e) => e.status));

  for (const k of ["fact", "decision", "convention", "failure", "constraint", "task-outcome"]) {
    assert.ok(kinds.has(k), `missing kind: ${k}`);
  }
  for (const s of ["active", "stale", "superseded", "disputed", "candidate", "forgotten"]) {
    assert.ok(statuses.has(s), `missing status: ${s}`);
  }
});

// ---------------------------------------------------------------------------
// Mini harness smoke test (schema v2: answerable-only headlines)
// ---------------------------------------------------------------------------

void test("eval: mini-run deterministic retriever yields sane v2 metrics", async () => {
  const { evaluate } = await import("../../benchmarks/eval.ts");
  const result = await evaluate("deterministic", CORPUS_VERSION, {
    maxEntries: 5,
    maxTokens: 4000,
  });

  assert.equal(result.metricSchemaVersion, 2, "metric schema must be v2");
  assert.equal(result.retrieval.fts, null, "deterministic run must not claim FTS diagnostics");

  const agg = result.tuning.answerable;
  assert.equal(agg.n, 51, "tuning answerable query count");
  assert.ok(agg.hitRateAt1 >= 0 && agg.hitRateAt1 <= 1, "hit-rate@1 out of range");
  assert.ok(agg.recallAt1 >= 0 && agg.recallAt1 <= 1, "recall@1 out of range");
  assert.ok(agg.recallAt5 >= 0 && agg.recallAt5 <= 1, "recall@5 out of range");
  assert.ok(agg.recallAt10 >= 0 && agg.recallAt10 <= 1, "recall@10 out of range");
  assert.ok(agg.mrr >= 0 && agg.mrr <= 1, "MRR out of range");
  assert.ok(agg.ndcgAt5 >= 0 && agg.ndcgAt5 <= 1, "nDCG@5 out of range");
  assert.ok(agg.medianFirstRelevantRank >= 1, "median first rank out of range");

  const holdAgg = result.holdout.answerable;
  assert.equal(holdAgg.n, 38, "holdout answerable query count");
  assert.ok(holdAgg.recallAt5 >= 0 && holdAgg.recallAt5 <= 1, "holdout recall@5 out of range");
  assert.ok(holdAgg.ndcgAt5 >= 0 && holdAgg.ndcgAt5 <= 1, "holdout nDCG@5 out of range");

  // Negatives exclude the zero-label queries from quality and report them
  // separately instead of diluting the headline.
  assert.equal(result.tuning.negatives.n, 104, "tuning negative query count");
  assert.equal(result.holdout.negatives.n, 13, "holdout negative query count");
  assert.equal(result.tuning.negatives.harmfulRate, 0, "tuning harmful-rate must be 0");
  assert.equal(result.tuning.negatives.staleRate, 0, "tuning stale-rate must be 0");
  assert.equal(result.holdout.negatives.harmfulRate, 0, "holdout harmful-rate must be 0");
  assert.equal(result.holdout.negatives.staleRate, 0, "holdout stale-rate must be 0");
  // Conflict rate counts active entries labeled harmful. Active corrective
  // facts are labeled relevant, so this must be zero rather than merely bounded;
  // if a future corpus regresses, the gate must fail instead of hiding it.
  assert.equal(result.tuning.negatives.conflictRate, 0, "tuning conflict-rate must be 0");
  assert.equal(result.holdout.negatives.conflictRate, 0, "holdout conflict-rate must be 0");
  assert.equal(result.gate.conflictRate, result.tuning.negatives.conflictRate);
  assert.equal(result.gate.holdoutConflictRate, result.holdout.negatives.conflictRate);
  assert.equal(result.gate.conflictRateOk, true);
  assert.equal(result.gate.answerableQualityOk, true, "holdout answerable quality gate");
  assert.equal(result.gate.harmfulRateOk, true, "tuning harmful gate");
  assert.equal(result.gate.staleRateOk, true, "tuning stale gate");

  // Ceiling is computed over answerable queries only.
  assert.ok(result.tuning.ceiling.precisionAt5 > 0 && result.tuning.ceiling.precisionAt5 <= 1);
  assert.ok(result.holdout.ceiling.precisionAt5 > 0 && result.holdout.ceiling.precisionAt5 <= 1);

  // Legacy all-query aggregates remain available, but are diluted by zeros.
  assert.equal(result.tuning.legacy.totalQueries, 155);
  assert.equal(result.holdout.legacy.totalQueries, 51);
  assert.ok(
    result.tuning.legacy.recallAt5Avg < result.tuning.answerable.recallAt5,
    "legacy all-query recall should be lower than answerable recall",
  );

  // Required per-class breakdown keys are always present.
  for (const cls of ["long", "contradiction", "changed-file", "typo", "multilingual"]) {
    assert.ok(result.tuning.byQueryClass[cls], `missing tuning class ${cls}`);
    assert.ok(result.holdout.byQueryClass[cls], `missing holdout class ${cls}`);
  }
  assert.ok(result.tuning.legacy.peakRssMb >= 0, "peak RSS negative");
  assert.ok(result.tuning.legacy.latencyP50Ms >= 0, "latency P50 negative");
});

void test("eval: mini-run fts5 retriever proves the sidecar path is live", async () => {
  const { evaluate } = await import("../../benchmarks/eval.ts");
  const result = await evaluate("fts5", CORPUS_VERSION, {
    maxEntries: 5,
    maxTokens: 4000,
  });

  const fts = result.retrieval.fts;
  assert.ok(fts, "fts diagnostics missing");
  assert.equal(fts.sidecarBackfilled, true, "sidecar was not backfilled");
  assert.ok(fts.contentCount > 0, "sidecar content table is empty");
  assert.ok(fts.ftsCount > 0, "sidecar docs_fts is empty");
  assert.equal(fts.sources.legacy, 0, "legacy memory_fts fallback must never fire");
  assert.ok(fts.sidecarQueries > 0, "no query resolved source === sidecar");
  assert.equal(fts.assertion, "passed");

  const agg = result.tuning.answerable;
  assert.equal(agg.n, 51, "tuning answerable query count");
  assert.ok(agg.recallAt5 >= 0 && agg.recallAt5 <= 1, "recall@5 out of range");
  assert.ok(agg.ndcgAt5 >= 0 && agg.ndcgAt5 <= 1, "nDCG@5 out of range");
  assert.ok(result.holdout.answerable.recallAt5 >= 0 && result.holdout.answerable.recallAt5 <= 1);
  assert.equal(result.tuning.negatives.harmfulRate, 0, "tuning harmful-rate must be 0");
  assert.equal(result.tuning.negatives.staleRate, 0, "tuning stale-rate must be 0");
  assert.equal(result.holdout.negatives.harmfulRate, 0, "holdout harmful-rate must be 0");
  assert.equal(result.holdout.negatives.staleRate, 0, "holdout stale-rate must be 0");
  assert.equal(result.tuning.negatives.conflictRate, 0, "tuning conflict-rate must be 0");
  assert.equal(result.holdout.negatives.conflictRate, 0, "holdout conflict-rate must be 0");
});

void test("eval: recall uses deduped relevant labels", async () => {
  const { evaluate } = await import("../../benchmarks/eval.ts");
  const result = await evaluate("deterministic", CORPUS_VERSION, {
    maxEntries: 5,
    maxTokens: 4000,
  });

  const tuningDup = result.perQuery.find((q) => q.queryId === "q-long-005");
  assert.ok(tuningDup, "q-long-005 missing");
  assert.equal(tuningDup.relevantCount, 3, "corpus labels are deduped");
  assert.equal(tuningDup.uniqueRelevantCount, 3, "deduped label count");
  assert.ok(tuningDup.recallAt5 <= 1, "deduped recall must never exceed 1");

  const holdoutDup = result.holdoutPerQuery.find((q) => q.queryId === "q-para-004");
  assert.ok(holdoutDup, "q-para-004 missing");
  assert.equal(holdoutDup.relevantCount, 1, "deduped holdout label count");
  assert.equal(holdoutDup.uniqueRelevantCount, 1, "deduped holdout label count");
});

void test("eval: bootstrap intervals are deterministic and bounded", async () => {
  const { bootstrapCI } = await import("../../benchmarks/eval.ts");
  const values = [0, 0.5, 1, 0.25, 0.75];
  const a = bootstrapCI(values);
  const b = bootstrapCI(values);
  assert.deepEqual(a, b, "bootstrap must be deterministic for a fixed seed");
  assert.ok(a.lower >= 0 && a.upper <= 1, "bootstrap interval out of [0,1]");
  assert.ok(a.lower <= a.upper, "bootstrap lower > upper");
  assert.equal(a.resamples, 1000);
});

void test("eval: baseline comparison refuses retired metric schemas", async () => {
  const { assertMetricSchemaCompatibility, compareBaseline } = await import(
    "../../benchmarks/eval.ts"
  );
  assert.doesNotThrow(() => assertMetricSchemaCompatibility(2));
  assert.throws(
    () => assertMetricSchemaCompatibility(1),
    /not comparable|retired/,
    "v1 baseline must be rejected",
  );
  assert.throws(
    () => assertMetricSchemaCompatibility(undefined),
    /not comparable|retired/,
    "unknown baseline schema must be rejected",
  );

  const dir = mkdtempSync(join(tmpdir(), "sc-baseline-"));
  const baselinePath = join(dir, `deterministic-${CORPUS_VERSION}-20200101T000000.json`);
  writeFileSync(
    baselinePath,
    JSON.stringify({ metricSchemaVersion: 1, corpus: { version: CORPUS_VERSION } }),
    "utf8",
  );
  try {
    assert.throws(
      () =>
        compareBaseline(
          "deterministic",
          CORPUS_VERSION,
          "0.0.0",
          {} as never,
          {} as never,
          5,
          dir,
        ),
      /metric schema v1/,
    );
  } finally {
    rmSync(baselinePath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// Frozen mini-holdout: RRF fusion beats the old additive blend by >= 0.05 MRR.
// Fixture pins the production failure mode (FTS returns a subset; the lexical
// top doc is absent from FTS so additive keeps the distractor on top).
void test("eval: frozen mini-holdout RRF vs additive MRR delta >= 0.05", async () => {
  const { rrfFuse } = await import("../../packages/core/src/memory/retrieval.ts");
  const queries = [
    { lex: ["d1", "rel1"], lexScores: { d1: 1.5, rel1: 1.0 }, fts: ["rel1"], rel: "rel1" },
    { lex: ["rel2", "d2"], lexScores: { rel2: 1.6, d2: 1.2 }, fts: ["rel2", "d2"], rel: "rel2" },
    { lex: ["d3", "d4", "rel3"], lexScores: { d3: 1.7, d4: 1.4, rel3: 1.1 }, fts: ["rel3"], rel: "rel3" },
  ];
  const rr = (order: string[], rel: string) => {
    const i = order.indexOf(rel);
    return i < 0 ? 0 : 1 / (i + 1);
  };
  let addSum = 0;
  let rrfSum = 0;
  for (const q of queries) {
    const ftsRank = new Map(q.fts.map((id, i) => [id, i]));
    const scores = q.lexScores as unknown as Record<string, number>;
    const additive = [...q.lex].sort(
      (a, b) =>
        scores[b]! + (ftsRank.has(b) ? 0.5 / (1 + ftsRank.get(b)!) : 0) -
        (scores[a]! + (ftsRank.has(a) ? 0.5 / (1 + ftsRank.get(a)!) : 0)),
    );
    addSum += rr(additive, q.rel);
    const fused = rrfFuse([q.lex, q.fts], 60);
    rrfSum += rr([...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id), q.rel);
  }
  const delta = rrfSum / queries.length - addSum / queries.length;
  assert.ok(delta >= 0.05, `mini-holdout RRF MRR delta ${delta.toFixed(3)} < 0.05`);
});
