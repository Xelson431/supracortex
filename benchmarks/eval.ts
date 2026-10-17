/**
 * Retrieval evaluation harness (metric schema v2).
 *
 * Loads a versioned corpus, runs every query through a named retriever path
 * (deterministic=jsonl without FTS, fts5=sqlite with FTS), and reports:
 *
 *   - answerable quality (queries with >= 1 relevant label), with a deduped
 *     relevance denominator, bootstrap 95% CIs, and a p@5/recall ceiling;
 *   - negative/abstention safety (queries with no relevant label);
 *   - per-query-class breakdowns;
 *   - the retired all-query aggregates under an explicit `legacy` block.
 *
 * Gate mode asserts answerable recall@5 / nDCG@5 on the holdout split plus
 * zero harmful/stale/conflict on labeled negatives. It deliberately does not
 * gate on the diluted all-query average.
 *
 * Usage:
 *   node benchmarks/eval.ts --retriever fts5 --corpus 1.0.1 --out benchmarks/results/<name>.json
 *   node benchmarks/eval.ts --retriever deterministic --corpus 1.0.1 --gate
 *
 * Output JSON schema:
 *   { metricSchemaVersion, run, corpus, config, retrieval, tuning, holdout, gate, baselineComparison }
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Metric schema
// ---------------------------------------------------------------------------

/** Bump only with a corresponding test + README change. v1 baselines are retired. */
export const METRIC_SCHEMA_VERSION = 2 as const;
export const BOOTSTRAP_SEED = 0x5eedc0de;
export const BOOTSTRAP_RESAMPLES = 1000;
export const BOOTSTRAP_CONFIDENCE = 0.95;
export const ANSWERABLE_RECALL_AT5_GATE = 0.4;
export const ANSWERABLE_NDCG_AT5_GATE = 0.4;

export const REQUIRED_QUERY_CLASSES = [
  "long",
  "contradiction",
  "changed-file",
  "typo",
  "multilingual",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  entries: CorpusEntry[];
  queries: LabeledQuery[];
}

interface PerQueryMetrics {
  queryId: string;
  query: string;
  queryClass: string;
  /** Raw label count (may contain duplicate ids in legacy corpus rows). */
  relevantCount: number;
  /** Deduped label count: the honest recall denominator. */
  uniqueRelevantCount: number;
  harmfulLabelCount: number;
  retrievedRelevant: number;
  retrievedHarmful: number;
  retrievedConflicting: number;
  retrievedStale: number;
  hitAt1: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  precisionAt5: number;
  reciprocalRank: number;
  ndcgAt5: number;
  firstRelevantRank: number | null;
  latencyMs: number;
  resultCount: number;
  tokensUsed: number;
  topIds: string[];
  /** FTS source for fts5 runs; "n/a" for deterministic runs. */
  ftsSource: string;
}

interface BootstrapInterval {
  lower: number;
  upper: number;
  confidence: number;
  resamples: number;
  seed: number;
  method: string;
}

interface AnswerableMetrics {
  /** Number of queries with at least one (deduped) relevant label. */
  n: number;
  hitRateAt1: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt5: number;
  /**
   * Median 1-based rank of the first relevant result. Misses are assigned
   * maxEntries + 1 so the median never flatters a retriever that returns
   * fewer than k results.
   */
  medianFirstRelevantRank: number;
  /** Answerable queries where no relevant result appeared in the ranked list. */
  misses: number;
  bootstrap95: {
    recallAt5: BootstrapInterval;
    ndcgAt5: BootstrapInterval;
  };
}

interface NegativeMetrics {
  /** Queries with zero relevant labels (no positive answer expected). */
  n: number;
  nWithHarmfulLabels: number;
  harmfulHits: number;
  staleHits: number;
  conflictHits: number;
  topSlots: number;
  harmfulRate: number;
  staleRate: number;
  conflictRate: number;
  abstained: number;
  abstentionRate: number;
}

interface CeilingMetrics {
  nAnswerable: number;
  /** Mean max achievable p@5: sum(min(uniqueRelevant, 5) / 5) / nAnswerable. */
  precisionAt5: number;
  /** Mean max achievable recall@5, accounting for labels beyond k. */
  recallAt5: number;
  queriesWithRelevantOver5: number;
}

interface LegacyAggregate {
  /** Retired headline. All-query denominator, deliberately not quality. */
  precisionAt5Avg: number;
  recallAt5Avg: number;
  mrr: number;
  ndcgAt5Avg: number;
  harmfulRate: number;
  conflictRate: number;
  staleRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  peakRssMb: number;
  totalTokensAvg: number;
  totalBytesAvg: number;
  totalQueries: number;
  queriesWithResults: number;
}

interface QueryClassMetrics {
  answerable: AnswerableMetrics;
  ceiling: CeilingMetrics;
  negatives: NegativeMetrics;
}

interface EvaluationBlock {
  answerable: AnswerableMetrics;
  negatives: NegativeMetrics;
  ceiling: CeilingMetrics;
  byQueryClass: Record<string, QueryClassMetrics>;
  legacy: LegacyAggregate;
}

interface FtsDiagnostics {
  enabled: boolean;
  sidecarBackfilled: boolean;
  written: number;
  contentCount: number;
  ftsCount: number;
  integrity: string;
  sources: Record<string, number>;
  sidecarQueries: number;
  legacyFallbackQueries: number;
  likeFallbackQueries: number;
  noFtsMatchQueries: number;
  assertion: "passed";
}

interface GateResult {
  passed: boolean;
  answerableQualityOk: boolean;
  tuningNegativesOk: boolean;
  holdoutNegativesOk: boolean;
  harmfulRateOk: boolean;
  staleRateOk: boolean;
  conflictRateOk: boolean;
  harmfulRate: number;
  staleRate: number;
  conflictRate: number;
  holdoutHarmfulRate: number;
  holdoutStaleRate: number;
  holdoutConflictRate: number;
  holdoutRecallAt5: number;
  holdoutNdcgAt5: number;
  recallAt5Threshold: number;
  ndcgAt5Threshold: number;
}

interface EvalResult {
  metricSchemaVersion: typeof METRIC_SCHEMA_VERSION;
  run: {
    retriever: string;
    startedAt: string;
    finishedAt: string;
  };
  corpus: {
    version: string;
    entries: number;
    tuningQueries: number;
    holdoutQueries: number;
    negativeQueries: number;
  };
  config: {
    codeVersion: string;
    maxEntries: number;
    maxTokens: number;
    minScore: number;
  };
  retrieval: {
    fts: FtsDiagnostics | null;
  };
  perQuery: PerQueryMetrics[];
  holdoutPerQuery: PerQueryMetrics[];
  tuning: EvaluationBlock;
  holdout: EvaluationBlock;
  gate: GateResult;
  baselineComparison: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(): {
  retriever: "deterministic" | "fts5";
  corpus: string;
  out: string;
  gate: boolean;
} {
  const r: { retriever: "deterministic" | "fts5"; corpus: string; out: string; gate: boolean } = {
    retriever: "deterministic",
    corpus: "1.0.1",
    out: "",
    gate: false,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--retriever") {
      const v = process.argv[++i];
      if (v !== "deterministic" && v !== "fts5") throw new Error(`bad retriever: ${v}`);
      r.retriever = v;
    } else if (a === "--corpus") {
      r.corpus = process.argv[++i] ?? r.corpus;
    } else if (a === "--out") {
      r.out = process.argv[++i] ?? "";
    } else if (a === "--gate") {
      r.gate = true;
    }
  }
  return r;
}

function loadCorpus(version: string, dir: string): { corpus: CorpusFile; holdout: LabeledQuery[] } {
  const corpusPath = join(dir, `../tests/evaluation/corpus-${version}.json`);
  const holdoutPath = join(dir, `../tests/evaluation/corpus-${version}-holdout.json`);
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusFile;
  const holdout = JSON.parse(readFileSync(holdoutPath, "utf8")) as LabeledQuery[];
  return { corpus, holdout };
}

function getCodeVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return (pkg as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(p * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)]!;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function dcg(relevances: number[], k: number): number {
  let score = 0;
  for (let i = 0; i < Math.min(relevances.length, k); i++) {
    score += relevances[i]! / Math.log2(i + 2);
  }
  return score;
}

function ndcg(relevantSet: Set<string>, topIds: string[], k: number): number {
  const relevances = topIds.map((id) => (relevantSet.has(id) ? 1 : 0));
  const ideal = Array.from({ length: Math.min(k, relevantSet.size) }, () => 1);
  const dcgVal = dcg(relevances, k);
  const idcgVal = dcg(ideal, Math.min(k, relevantSet.size));
  return idcgVal > 0 ? dcgVal / idcgVal : 0;
}

/** Deterministic PRNG (mulberry32) so bootstrap intervals are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapCI(
  values: number[],
  seed = BOOTSTRAP_SEED,
  resamples = BOOTSTRAP_RESAMPLES,
): BootstrapInterval {
  if (values.length === 0) {
    return {
      lower: 0,
      upper: 0,
      confidence: BOOTSTRAP_CONFIDENCE,
      resamples,
      seed,
      method: "percentile-bootstrap",
    };
  }
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rand() * values.length)]!;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - BOOTSTRAP_CONFIDENCE) / 2;
  return {
    lower: quantile(means, alpha),
    upper: quantile(means, 1 - alpha),
    confidence: BOOTSTRAP_CONFIDENCE,
    resamples,
    seed,
    method: "percentile-bootstrap",
  };
}

/**
 * Reject baselines produced by a different metric schema. Old v1 files were
 * diluted all-query averages and are not comparable to the answerable v2
 * metrics; silently reusing them would make regressions look like improvements.
 */
export function assertMetricSchemaCompatibility(version: number | undefined): void {
  if (version !== METRIC_SCHEMA_VERSION) {
    throw new Error(
      `Baseline metric schema ${version === undefined ? "unknown (legacy v1)" : `v${version}`} ` +
        `is not comparable to current schema v${METRIC_SCHEMA_VERSION}. ` +
        "Old v1 baselines are retired; delete them or regenerate with current code.",
    );
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function computeAnswerable(metrics: PerQueryMetrics[], maxEntries: number): AnswerableMetrics {
  const answerable = metrics.filter((m) => m.uniqueRelevantCount > 0);
  const n = answerable.length;
  const missRank = maxEntries + 1;
  return {
    n,
    hitRateAt1: mean(answerable.map((m) => m.hitAt1)),
    recallAt1: mean(answerable.map((m) => m.recallAt1)),
    recallAt5: mean(answerable.map((m) => m.recallAt5)),
    recallAt10: mean(answerable.map((m) => m.recallAt10)),
    mrr: mean(answerable.map((m) => m.reciprocalRank)),
    ndcgAt5: mean(answerable.map((m) => m.ndcgAt5)),
    medianFirstRelevantRank: median(
      answerable.map((m) => m.firstRelevantRank ?? missRank),
    ),
    misses: answerable.filter((m) => m.firstRelevantRank === null).length,
    bootstrap95: {
      recallAt5: bootstrapCI(answerable.map((m) => m.recallAt5)),
      ndcgAt5: bootstrapCI(answerable.map((m) => m.ndcgAt5)),
    },
  };
}

function computeNegatives(metrics: PerQueryMetrics[]): NegativeMetrics {
  const negatives = metrics.filter((m) => m.relevantCount === 0);
  const topSlots = negatives.reduce((sum, m) => sum + Math.min(5, m.resultCount), 0);
  const harmfulHits = negatives.reduce((sum, m) => sum + m.retrievedHarmful, 0);
  const staleHits = negatives.reduce((sum, m) => sum + m.retrievedStale, 0);
  const conflictHits = negatives.reduce((sum, m) => sum + m.retrievedConflicting, 0);
  const abstained = negatives.filter((m) => m.resultCount === 0).length;
  return {
    n: negatives.length,
    nWithHarmfulLabels: negatives.filter((m) => m.harmfulLabelCount > 0).length,
    harmfulHits,
    staleHits,
    conflictHits,
    topSlots,
    harmfulRate: topSlots > 0 ? harmfulHits / topSlots : 0,
    staleRate: topSlots > 0 ? staleHits / topSlots : 0,
    conflictRate: topSlots > 0 ? conflictHits / topSlots : 0,
    abstained,
    abstentionRate: negatives.length > 0 ? abstained / negatives.length : 0,
  };
}

function computeCeiling(metrics: PerQueryMetrics[]): CeilingMetrics {
  const answerable = metrics.filter((m) => m.uniqueRelevantCount > 0);
  const n = answerable.length;
  return {
    nAnswerable: n,
    precisionAt5:
      n > 0
        ? answerable.reduce(
            (sum, m) => sum + Math.min(m.uniqueRelevantCount, 5) / 5,
            0,
          ) / n
        : 0,
    recallAt5:
      n > 0
        ? answerable.reduce(
            (sum, m) => sum + Math.min(m.uniqueRelevantCount, 5) / m.uniqueRelevantCount,
            0,
          ) / n
        : 0,
    queriesWithRelevantOver5: answerable.filter((m) => m.uniqueRelevantCount > 5).length,
  };
}

function computeLegacy(
  metrics: PerQueryMetrics[],
  rssBefore: number,
  rssAfter: number,
): LegacyAggregate {
  if (metrics.length === 0) {
    return {
      precisionAt5Avg: 0,
      recallAt5Avg: 0,
      mrr: 0,
      ndcgAt5Avg: 0,
      harmfulRate: 0,
      conflictRate: 0,
      staleRate: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      peakRssMb: 0,
      totalTokensAvg: 0,
      totalBytesAvg: 0,
      totalQueries: 0,
      queriesWithResults: 0,
    };
  }

  const latencies = metrics.map((m) => m.latencyMs).sort((a, b) => a - b);
  const precisionSum = metrics.reduce((s, m) => s + m.precisionAt5, 0);
  // Legacy v1 used the raw label length (including duplicate ids) as the
  // recall denominator. Preserve that only so the retired numbers stay
  // interpretable; never use it as a headline.
  const recallSum = metrics.reduce(
    (s, m) => s + (m.relevantCount > 0 ? m.retrievedRelevant / m.relevantCount : 0),
    0,
  );
  const mrrSum = metrics.reduce((s, m) => s + m.reciprocalRank, 0);
  const ndcgSum = metrics.reduce((s, m) => s + m.ndcgAt5, 0);
  const harmfulHits = metrics.reduce((s, m) => s + m.retrievedHarmful, 0);
  const conflictingHits = metrics.reduce((s, m) => s + m.retrievedConflicting, 0);
  const staleHits = metrics.reduce((s, m) => s + m.retrievedStale, 0);
  const totalTopSlots = metrics.reduce((sum, metric) => sum + Math.min(5, metric.resultCount), 0);
  const tokensSum = metrics.reduce((s, m) => s + m.tokensUsed, 0);

  return {
    precisionAt5Avg: precisionSum / metrics.length,
    recallAt5Avg: recallSum / metrics.length,
    mrr: mrrSum / metrics.length,
    ndcgAt5Avg: ndcgSum / metrics.length,
    harmfulRate: totalTopSlots > 0 ? harmfulHits / totalTopSlots : 0,
    conflictRate: totalTopSlots > 0 ? conflictingHits / totalTopSlots : 0,
    staleRate: totalTopSlots > 0 ? staleHits / totalTopSlots : 0,
    latencyP50Ms: quantile(latencies, 0.5),
    latencyP95Ms: quantile(latencies, 0.95),
    peakRssMb: Math.max(0, (rssAfter - rssBefore) / 1024 / 1024),
    totalTokensAvg: tokensSum / metrics.length,
    totalBytesAvg: (tokensSum / metrics.length) * 4, // rough estimate
    totalQueries: metrics.length,
    queriesWithResults: metrics.filter((m) => m.resultCount > 0).length,
  };
}

function computeQueryClassBreakdown(
  metrics: PerQueryMetrics[],
  maxEntries: number,
): Record<string, QueryClassMetrics> {
  const classes = new Set<string>([
    ...REQUIRED_QUERY_CLASSES,
    ...metrics.map((m) => m.queryClass),
  ]);
  const out: Record<string, QueryClassMetrics> = {};
  for (const queryClass of [...classes].sort()) {
    const subset = metrics.filter((m) => m.queryClass === queryClass);
    out[queryClass] = {
      answerable: computeAnswerable(subset, maxEntries),
      ceiling: computeCeiling(subset),
      negatives: computeNegatives(subset),
    };
  }
  return out;
}

function computeBlock(
  metrics: PerQueryMetrics[],
  maxEntries: number,
  rssBefore: number,
  rssAfter: number,
): EvaluationBlock {
  return {
    answerable: computeAnswerable(metrics, maxEntries),
    negatives: computeNegatives(metrics),
    ceiling: computeCeiling(metrics),
    byQueryClass: computeQueryClassBreakdown(metrics, maxEntries),
    legacy: computeLegacy(metrics, rssBefore, rssAfter),
  };
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

export async function evaluate(
  retriever: "deterministic" | "fts5",
  corpusVersion: string,
  opts: { maxEntries?: number; maxTokens?: number; minScore?: number } = {},
): Promise<EvalResult> {
  const { corpus, holdout } = loadCorpus(corpusVersion, here);
  const codeVersion = getCodeVersion();
  const startedAt = nowISO();

  const maxEntries = opts.maxEntries ?? 10;
  const maxTokens = opts.maxTokens ?? 8000;
  const minScore = opts.minScore ?? 0.05;

  // Build temp store and populate entries. The harness lives outside the
  // packages workspace, so import the TypeScript sources via path.
  const corePath = join(here, "..", "packages", "core", "src", "index.ts");
  const { MemoryManager, JsonlStore, createSqliteStore } = await import(corePath);

  // Fail loudly before retrieval if the corpus cannot round-trip through the
  // production validator: silently dropping entries makes contradiction and
  // changed-file labels impossible to satisfy and invalidates every metric.
  const schemasPath = join(here, "..", "packages", "core", "src", "memory", "schemas.ts");
  const { isValidMemoryEntry } = await import(schemasPath);
  const invalidIds = corpus.entries
    .filter((entry) => !isValidMemoryEntry(entry))
    .map((entry) => entry.id);
  if (corpus.entries.length !== corpus.totalEntries || invalidIds.length > 0) {
    throw new Error(
      `Evaluation corpus ${corpusVersion} is not fully loadable: ` +
        `declared totalEntries=${corpus.totalEntries}, actual entries=${corpus.entries.length}` +
        (invalidIds.length > 0 ? `, invalid ids=[${invalidIds.join(", ")}]` : ""),
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "sc-eval-"));
  const store =
    retriever === "fts5"
      ? await createSqliteStore(tmpDir)
      : new JsonlStore(tmpDir);

  const mgr = new MemoryManager(store);

  // Bulk-load entries directly into store (bypassing record/buildMemoryEntry
  // which would overwrite corpus IDs with randomUUID). Group by kind to write
  // to the correct JSONL files.
  const FILE_BY_KIND: Record<string, string> = {
    fact: "memory/durable.jsonl",
    constraint: "memory/durable.jsonl",
    decision: "memory/decisions.jsonl",
    convention: "memory/conventions.jsonl",
    failure: "memory/failures.jsonl",
    // Mirrors MemoryRepository: promoted outcome memories live with memory.
    // `tasks/completed.jsonl` is owned by the task subsystem and is not a
    // MemoryEntry log.
    "task-outcome": "memory/outcomes.jsonl",
  };
  const byFile = new Map<string, CorpusEntry[]>();
  for (const entry of corpus.entries) {
    const file = FILE_BY_KIND[entry.kind] ?? `memory/${entry.kind}.jsonl`;
    const list = byFile.get(file) ?? [];
    list.push(entry);
    byFile.set(file, list);
  }
  for (const [file, entries] of byFile) {
    await store.appendJsonl(file, entries);
  }

  // Assert the persisted view is complete. MemoryRepository applies the same
  // validity gate as the engine; corruptLines counts rows it rejected.
  const repoPath = join(here, "..", "packages", "core", "src", "memory", "repository.ts");
  const { MemoryRepository } = await import(repoPath);
  const repository = new MemoryRepository(store);
  const loadedView = await repository.loadAll();
  if (loadedView.entries.length !== corpus.totalEntries || loadedView.corruptLines !== 0) {
    const loadedIds = new Set(loadedView.entries.map((entry: { id: string }) => entry.id));
    const missingIds = corpus.entries
      .filter((entry) => !loadedIds.has(entry.id))
      .map((entry) => entry.id);
    throw new Error(
      `Evaluation corpus ${corpusVersion} failed to load: ` +
        `loadedEntries=${loadedView.entries.length}/${corpus.totalEntries}, ` +
        `corruptLines=${loadedView.corruptLines}` +
        (missingIds.length > 0 ? `, missing ids=[${missingIds.join(", ")}]` : ""),
    );
  }

  // FTS5: always rebuild BOTH the legacy compatibility index and the live
  // sidecar before retrieval. Without the sidecar backfill every query logs
  // FTS_MISSING and silently falls back, invalidating the comparison.
  let ftsDiagnostics: FtsDiagnostics | null = null;
  if (retriever === "fts5") {
    const allEntries = await mgr.loadAll();
    if (
      typeof store.ensureFtsSidecar !== "function" ||
      typeof store.ftsBackfillSidecar !== "function" ||
      typeof store.ftsIntegrityCheck !== "function"
    ) {
      throw new Error(
        "FTS sidecar API unavailable; refusing to run an invalid FTS comparison",
      );
    }
    await store.ensureFtsSidecar();
    const entries = allEntries.map(
      (e: { id: string; kind: string; content: string; updatedAt: string }) => ({
        id: e.id,
        kind: e.kind,
        text: e.content,
        updatedAt: e.updatedAt,
      }),
    );
    const { written } = await store.ftsBackfillSidecar(entries);
    const integrity = await store.ftsIntegrityCheck();
    if (!integrity.ok || integrity.contentCount <= 0 || integrity.ftsCount <= 0) {
      throw new Error(
        `FTS sidecar backfill failed: written=${written} content=${integrity.contentCount} ` +
          `fts=${integrity.ftsCount} integrity=${integrity.integrity}. ` +
          "Refusing to fall back silently to legacy/lexical retrieval.",
      );
    }
    if (store.ftsRebuild) {
      await store.ftsRebuild(
        allEntries.map((e: { id: string; content: string; kind: string; tags: string[] }) => ({
          id: e.id,
          content: e.content,
          kind: e.kind,
          tags: e.tags,
        })),
      );
    }
    ftsDiagnostics = {
      enabled: true,
      sidecarBackfilled: true,
      written,
      contentCount: integrity.contentCount,
      ftsCount: integrity.ftsCount,
      integrity: integrity.integrity,
      sources: { sidecar: 0, legacy: 0, like: 0, none: 0 },
      sidecarQueries: 0,
      legacyFallbackQueries: 0,
      likeFallbackQueries: 0,
      noFtsMatchQueries: 0,
      assertion: "passed",
    };
  }

  // For FTS source assertions we need the same repository view the manager
  // uses. This is read-only and lets us prove which fallback tier fired.
  const repo: any = retriever === "fts5" ? repository : null;

  // Build index of entry status for stale detection.
  const entryStatus = new Map<string, string>();
  for (const e of corpus.entries) {
    entryStatus.set(e.id, e.status);
  }

  const runQuery = async (q: LabeledQuery): Promise<PerQueryMetrics> => {
    const t0 = Date.now();
    const result = await mgr.search(q.query, [], [], [], {
      maxEntries,
      maxTokens,
      minScore,
    });
    const latencyMs = Date.now() - t0;

    const topIds = result.selections.map((s: { entry: { id: string } }) => s.entry.id);
    const relevantSet = new Set(q.relevantEntryIds);
    const harmfulSet = new Set(q.harmfulEntryIds);

    let ftsSource = "n/a";
    if (repo) {
      const fts = await repo.searchFts(q.query, maxEntries);
      ftsSource = String(fts.source);
      ftsDiagnostics!.sources[ftsSource] = (ftsDiagnostics!.sources[ftsSource] ?? 0) + 1;
    }

    const topK = topIds.slice(0, 5);
    const top1 = topIds.slice(0, 1);
    const top10 = topIds.slice(0, 10);
    const retrievedRelevant = topK.filter((id: string) => relevantSet.has(id)).length;
    const retrievedRelevantAt1 = top1.filter((id: string) => relevantSet.has(id)).length;
    const retrievedRelevantAt10 = top10.filter((id: string) => relevantSet.has(id)).length;
    // The corpus uses harmful labels for two distinct cases. Non-active
    // records (candidate, stale, superseded, forgotten, disputed) are unsafe
    // automatic context. Active evidence can instead be a useful correction
    // to a contradictory user request. Track those conflicts visibly rather
    // than silently treating a correct counterexample as unsafe.
    const retrievedHarmful = topK.filter(
      (id: string) => harmfulSet.has(id) && entryStatus.get(id) !== "active",
    ).length;
    const retrievedConflicting = topK.filter(
      (id: string) => harmfulSet.has(id) && entryStatus.get(id) === "active",
    ).length;
    // stale-rate counts strictly status==="stale" entries.
    const retrievedStale = topK.filter((id: string) => entryStatus.get(id) === "stale").length;

    const uniqueRelevantCount = relevantSet.size;
    const precisionAt5 = retrievedRelevant / 5;
    const recallAt1 = uniqueRelevantCount > 0 ? retrievedRelevantAt1 / uniqueRelevantCount : 0;
    const recallAt5 = uniqueRelevantCount > 0 ? retrievedRelevant / uniqueRelevantCount : 0;
    const recallAt10 = uniqueRelevantCount > 0 ? retrievedRelevantAt10 / uniqueRelevantCount : 0;

    const firstIdx = topIds.findIndex((id: string) => relevantSet.has(id));
    const firstRelevantRank = firstIdx >= 0 ? firstIdx + 1 : null;
    const reciprocalRank = firstRelevantRank === null ? 0 : 1 / firstRelevantRank;
    const hitAt1 = top1.length > 0 && relevantSet.has(top1[0]!) ? 1 : 0;
    const ndcgVal = ndcg(relevantSet, topIds, 5);

    return {
      queryId: q.id,
      query: q.query,
      queryClass: q.queryClass,
      relevantCount: q.relevantEntryIds.length,
      uniqueRelevantCount,
      harmfulLabelCount: q.harmfulEntryIds.length,
      retrievedRelevant,
      retrievedHarmful,
      retrievedConflicting,
      retrievedStale,
      hitAt1,
      recallAt1,
      recallAt5,
      recallAt10,
      precisionAt5,
      reciprocalRank,
      ndcgAt5: ndcgVal,
      firstRelevantRank,
      latencyMs,
      resultCount: result.selections.length,
      tokensUsed: result.tokens,
      topIds,
      ftsSource,
    };
  };

  // Run all tuning queries.
  const rssBefore = process.memoryUsage().rss;
  const perQuery: PerQueryMetrics[] = [];
  for (const q of corpus.queries) {
    perQuery.push(await runQuery(q));
  }
  const rssAfter = process.memoryUsage().rss;

  // Run holdout queries.
  const holdoutPerQuery: PerQueryMetrics[] = [];
  for (const q of holdout) {
    holdoutPerQuery.push(await runQuery(q));
  }

  // Aggregate by split. `legacy` is retained only for historical context.
  const tuning = computeBlock(perQuery, maxEntries, rssBefore, rssAfter);
  const holdoutBlock = computeBlock(holdoutPerQuery, maxEntries, rssBefore, rssAfter);

  // Fail loudly if the FTS path was not actually the sidecar, or if any query
  // silently used the legacy memory_fts table. LIKE/none are recorded no-match
  // or substring fallbacks over the sidecar mirror, never silent legacy use.
  if (ftsDiagnostics) {
    const sources = ftsDiagnostics.sources;
    ftsDiagnostics.sidecarQueries = sources.sidecar ?? 0;
    ftsDiagnostics.legacyFallbackQueries = sources.legacy ?? 0;
    ftsDiagnostics.likeFallbackQueries = sources.like ?? 0;
    ftsDiagnostics.noFtsMatchQueries = sources.none ?? 0;
    if (ftsDiagnostics.legacyFallbackQueries > 0) {
      throw new Error(
        `FTS sidecar assertion failed: ${ftsDiagnostics.legacyFallbackQueries} queries fell back to ` +
          "legacy memory_fts. The FTS comparison would be invalid.",
      );
    }
    if (ftsDiagnostics.sidecarQueries === 0) {
      throw new Error(
        "FTS sidecar assertion failed: no evaluated query resolved source === \"sidecar\".",
      );
    }
    if (ftsDiagnostics.likeFallbackQueries > 0) {
      console.warn(
        `[FTS] ${ftsDiagnostics.likeFallbackQueries} queries resolved source === "like" ` +
          "(substring fallback over the sidecar content mirror; no FTS token match).",
      );
    }
    if (ftsDiagnostics.noFtsMatchQueries > 0) {
      console.warn(
        `[FTS] ${ftsDiagnostics.noFtsMatchQueries} queries had no FTS token match and used ` +
          "lexical-only retrieval (source === \"none\"); recorded as noFtsMatchQueries.",
      );
    }
  }

  // Gate: answerable holdout quality + zero harmful/stale/conflict on negatives.
  const holdoutQualityOk =
    holdoutBlock.answerable.n > 0 &&
    holdoutBlock.answerable.recallAt5 >= ANSWERABLE_RECALL_AT5_GATE &&
    holdoutBlock.answerable.ndcgAt5 >= ANSWERABLE_NDCG_AT5_GATE;
  const tuningNegativesOk =
    tuning.negatives.harmfulRate === 0 &&
    tuning.negatives.staleRate === 0 &&
    tuning.negatives.conflictRate === 0;
  const holdoutNegativesOk =
    holdoutBlock.negatives.harmfulRate === 0 &&
    holdoutBlock.negatives.staleRate === 0 &&
    holdoutBlock.negatives.conflictRate === 0;

  const gate: GateResult = {
    passed: holdoutQualityOk && tuningNegativesOk && holdoutNegativesOk,
    answerableQualityOk: holdoutQualityOk,
    tuningNegativesOk,
    holdoutNegativesOk,
    harmfulRateOk: tuning.negatives.harmfulRate === 0,
    staleRateOk: tuning.negatives.staleRate === 0,
    conflictRateOk: tuning.negatives.conflictRate === 0,
    harmfulRate: tuning.negatives.harmfulRate,
    staleRate: tuning.negatives.staleRate,
    conflictRate: tuning.negatives.conflictRate,
    holdoutHarmfulRate: holdoutBlock.negatives.harmfulRate,
    holdoutStaleRate: holdoutBlock.negatives.staleRate,
    holdoutConflictRate: holdoutBlock.negatives.conflictRate,
    holdoutRecallAt5: holdoutBlock.answerable.recallAt5,
    holdoutNdcgAt5: holdoutBlock.answerable.ndcgAt5,
    recallAt5Threshold: ANSWERABLE_RECALL_AT5_GATE,
    ndcgAt5Threshold: ANSWERABLE_NDCG_AT5_GATE,
  };

  // Baseline comparison (same retriever + corpus + metric schema only).
  const baselineComparison = compareBaseline(
    retriever,
    corpusVersion,
    codeVersion,
    tuning,
    holdoutBlock,
    maxEntries,
  );

  const result: EvalResult = {
    metricSchemaVersion: METRIC_SCHEMA_VERSION,
    run: { retriever, startedAt, finishedAt: nowISO() },
    corpus: {
      version: corpus.version,
      entries: corpus.totalEntries,
      tuningQueries: corpus.queries.length,
      holdoutQueries: holdout.length,
      negativeQueries: corpus.queries.filter((q) => q.relevantEntryIds.length === 0).length,
    },
    config: { codeVersion, maxEntries, maxTokens, minScore },
    retrieval: { fts: ftsDiagnostics },
    perQuery,
    holdoutPerQuery,
    tuning,
    holdout: holdoutBlock,
    gate,
    baselineComparison,
  };

  // Cleanup.
  await store.close();

  return result;
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

export function compareBaseline(
  retriever: string,
  corpusVersion: string,
  codeVersion: string,
  tuning: EvaluationBlock,
  holdout: EvaluationBlock,
  maxEntries: number,
  baselineDir = join(here, "results"),
): string | null {
  const files = readdirSafe(baselineDir);
  // Find most recent baseline file for this retriever + corpus version.
  const pattern = new RegExp(
    `^${retriever}-${corpusVersion.replace(/\./g, "\\.")}-\\d{8}T\\d{6}\\.json$`,
  );
  const matching = files.filter((f) => pattern.test(f)).sort().reverse();
  if (matching.length === 0) return "no prior baseline found";

  const baselinePath = join(baselineDir, matching[0]!);
  let baseline: EvalResult;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as EvalResult;
  } catch {
    return "could not read prior baseline";
  }

  assertMetricSchemaCompatibility(
    (baseline as { metricSchemaVersion?: number }).metricSchemaVersion,
  );

  if (baseline.corpus.version !== corpusVersion) {
    throw new Error(
      `Baseline corpus version mismatch: baseline=${baseline.corpus.version} current=${corpusVersion}. ` +
        "Cannot compare across different corpus versions.",
    );
  }

  const lines: string[] = [];
  lines.push("=== Baseline comparison (metric schema v2) ===");
  lines.push(`Prior run: ${baseline.run.finishedAt} (code ${baseline.config.codeVersion})`);
  lines.push(`Current:   ${codeVersion}`);

  const metrics: Array<{ name: string; prior: number; current: number }> = [
    { name: "tuning hit@1", prior: baseline.tuning.answerable.hitRateAt1, current: tuning.answerable.hitRateAt1 },
    { name: "tuning recall@5", prior: baseline.tuning.answerable.recallAt5, current: tuning.answerable.recallAt5 },
    { name: "tuning MRR", prior: baseline.tuning.answerable.mrr, current: tuning.answerable.mrr },
    { name: "tuning nDCG@5", prior: baseline.tuning.answerable.ndcgAt5, current: tuning.answerable.ndcgAt5 },
    { name: "holdout hit@1", prior: baseline.holdout.answerable.hitRateAt1, current: holdout.answerable.hitRateAt1 },
    { name: "holdout recall@5", prior: baseline.holdout.answerable.recallAt5, current: holdout.answerable.recallAt5 },
    { name: "holdout MRR", prior: baseline.holdout.answerable.mrr, current: holdout.answerable.mrr },
    { name: "holdout nDCG@5", prior: baseline.holdout.answerable.ndcgAt5, current: holdout.answerable.ndcgAt5 },
    { name: "tuning harmful-rate", prior: baseline.tuning.negatives.harmfulRate, current: tuning.negatives.harmfulRate },
    { name: "tuning stale-rate", prior: baseline.tuning.negatives.staleRate, current: tuning.negatives.staleRate },
    { name: "tuning conflict-rate", prior: baseline.tuning.negatives.conflictRate, current: tuning.negatives.conflictRate },
    { name: "holdout harmful-rate", prior: baseline.holdout.negatives.harmfulRate, current: holdout.negatives.harmfulRate },
    { name: "holdout stale-rate", prior: baseline.holdout.negatives.staleRate, current: holdout.negatives.staleRate },
    { name: "holdout conflict-rate", prior: baseline.holdout.negatives.conflictRate, current: holdout.negatives.conflictRate },
    { name: "latency P50 ms", prior: baseline.tuning.legacy.latencyP50Ms, current: tuning.legacy.latencyP50Ms },
    { name: "latency P95 ms", prior: baseline.tuning.legacy.latencyP95Ms, current: tuning.legacy.latencyP95Ms },
  ];

  void maxEntries;
  for (const m of metrics) {
    const delta = (m.current - m.prior) * 100;
    const sign = delta >= 0 ? "+" : "";
    lines.push(
      `  ${m.name.padEnd(25)} ${m.prior.toFixed(4)} → ${m.current.toFixed(4)} (${sign}${delta.toFixed(2)}%)`,
    );
  }

  return lines.join("\n");
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { retriever, corpus: corpusVersion, out, gate } = parseArgs();
  const result = await evaluate(retriever, corpusVersion);

  const tuning = result.tuning.answerable;
  const holdout = result.holdout.answerable;
  console.log(`\n=== ${retriever.toUpperCase()} evaluation (corpus v${corpusVersion}, metric schema v${result.metricSchemaVersion}) ===`);
  console.log(`  Tuning answerable:  n=${tuning.n}`);
  console.log(`  Holdout answerable: n=${holdout.n}`);
  console.log(`  recall@5:      tuning ${tuning.recallAt5.toFixed(4)} | holdout ${holdout.recallAt5.toFixed(4)}`);
  console.log(`  recall@5 95% CI: tuning [${tuning.bootstrap95.recallAt5.lower.toFixed(4)}, ${tuning.bootstrap95.recallAt5.upper.toFixed(4)}] | holdout [${holdout.bootstrap95.recallAt5.lower.toFixed(4)}, ${holdout.bootstrap95.recallAt5.upper.toFixed(4)}]`);
  console.log(`  nDCG@5:        tuning ${tuning.ndcgAt5.toFixed(4)} | holdout ${holdout.ndcgAt5.toFixed(4)}`);
  console.log(`  nDCG@5 95% CI: tuning [${tuning.bootstrap95.ndcgAt5.lower.toFixed(4)}, ${tuning.bootstrap95.ndcgAt5.upper.toFixed(4)}] | holdout [${holdout.bootstrap95.ndcgAt5.lower.toFixed(4)}, ${holdout.bootstrap95.ndcgAt5.upper.toFixed(4)}]`);
  console.log(`  MRR:           tuning ${tuning.mrr.toFixed(4)} | holdout ${holdout.mrr.toFixed(4)}`);
  console.log(`  hit-rate@1:    tuning ${tuning.hitRateAt1.toFixed(4)} | holdout ${holdout.hitRateAt1.toFixed(4)}`);
  console.log(`  median first relevant rank: tuning ${tuning.medianFirstRelevantRank} | holdout ${holdout.medianFirstRelevantRank}`);
  console.log(`  p@5 ceiling:   tuning ${result.tuning.ceiling.precisionAt5.toFixed(4)} | holdout ${result.holdout.ceiling.precisionAt5.toFixed(4)}`);
  console.log(`  negatives:     tuning n=${result.tuning.negatives.n} harmful=${result.tuning.negatives.harmfulRate.toFixed(4)} stale=${result.tuning.negatives.staleRate.toFixed(4)} conflict=${result.tuning.negatives.conflictRate.toFixed(4)} abstain=${result.tuning.negatives.abstentionRate.toFixed(4)}`);
  console.log(`                 holdout n=${result.holdout.negatives.n} harmful=${result.holdout.negatives.harmfulRate.toFixed(4)} stale=${result.holdout.negatives.staleRate.toFixed(4)} conflict=${result.holdout.negatives.conflictRate.toFixed(4)} abstain=${result.holdout.negatives.abstentionRate.toFixed(4)}`);
  console.log(`  legacy all-query recall@5 (retired): tuning ${result.tuning.legacy.recallAt5Avg.toFixed(4)} | holdout ${result.holdout.legacy.recallAt5Avg.toFixed(4)}`);
  if (result.retrieval.fts) {
    const fts = result.retrieval.fts;
    console.log(`  FTS sidecar:   content=${fts.contentCount} fts=${fts.ftsCount} sources=${JSON.stringify(fts.sources)}`);
  }
  console.log(`  latency P50:   ${result.tuning.legacy.latencyP50Ms.toFixed(1)}ms  P95: ${result.tuning.legacy.latencyP95Ms.toFixed(1)}ms`);
  console.log(`  tokens/query avg: ${result.tuning.legacy.totalTokensAvg.toFixed(1)}`);

  // Gate.
  if (gate) {
    console.log(`\nGate: ${result.gate.passed ? "PASS" : "FAIL"}`);
    if (!result.gate.answerableQualityOk) {
      console.log(
        `  ✗ holdout answerable recall@5=${result.gate.holdoutRecallAt5.toFixed(4)} ` +
          `nDCG@5=${result.gate.holdoutNdcgAt5.toFixed(4)} ` +
          `(each must be >= ${result.gate.recallAt5Threshold})`,
      );
    }
    if (!result.gate.tuningNegativesOk || !result.gate.holdoutNegativesOk) {
      console.log(
        "  ✗ labeled negatives must have zero harmful, stale, and conflict hits " +
          `(tuning harmful=${result.gate.harmfulRate} stale=${result.gate.staleRate} conflict=${result.gate.conflictRate}; ` +
          `holdout harmful=${result.gate.holdoutHarmfulRate} stale=${result.gate.holdoutStaleRate} conflict=${result.gate.holdoutConflictRate})`,
      );
    }
    if (result.baselineComparison) {
      console.log(`\n${result.baselineComparison}`);
    }
    if (!result.gate.passed) process.exit(1);
  }

  // Write output.
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
    console.log(`\nResults written to ${out}`);
  } else if (!gate) {
    // Default path: write to benchmarks/results/<retriever>-<corpus>-<date>.json
    const date = nowISO().replace(/[:-]/g, "").replace(/\.\d+Z$/, "");
    const defaultPath = join(here, "results", `${retriever}-${corpusVersion}-${date}.json`);
    mkdirSync(dirname(defaultPath), { recursive: true });
    writeFileSync(defaultPath, JSON.stringify(result, null, 2), "utf8");
    console.log(`\nResults written to ${defaultPath}`);
  }
}
