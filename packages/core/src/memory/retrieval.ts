/**
 * Memory retrieval: rank candidates per source, fuse with RRF, then select
 * the best entries within the configured count/token budget. Every selection
 * carries a human-readable reason.
 *
 * Fusion is rank-only RRF Σ 1/(k+r) (k=60 default) over over-fetched per-source
 * lists (5x top_k). Raw scores are never mixed across sources; score-sum is
 * reserved for [0,1]-normalized inputs only. FTS input is an entryId → raw
 * rank map where lower=better (sqlite bm25() negatives sort ascending).
 * Single-source input falls back without fusion. Final cut is a rank cutoff
 * (param, default = maxEntries); minScore stays as a backward-compat
 * pre-filter on the lexical side.
 */

import type { MemoryEntry, MemorySelection } from "../types.ts";
import { estimateTokens } from "../metrics/token-estimator.ts";
import { buildCorpusStats, scoreMemory, type QueryContext, type ScoreOptions } from "./ranking.ts";

export interface RetrievalOptions {
  maxEntries: number;
  maxTokens: number;
  /** Backward-compat lexical pre-filter (default 0.05). */
  minScore?: number;
  /** Rank cutoff on the fused list (default = maxEntries). */
  rankCutoff?: number;
  /** RRF constant k (default 60; grid 20/60/120). */
  rrfK?: number;
  /** Per-source over-fetch multiplier (default 5). */
  overFetch?: number;
  /** FTS scores from FTS5 (entryId → raw rank, lower=better, may be negative). Undefined = no FTS available. */
  bm25?: Map<string, number>;
  /** Recency/weight passthrough for the lexical scorer. */
  scoring?: ScoreOptions;
}

export interface RetrievalResult {
  selected: MemorySelection[];
  considered: number;
  tokensSelected: number;
}

/** Normalize per-query FTS raws to [0,1] (higher=better). Handles negatives by negation+min-max. */
export function normalizeFtsScores(raw: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw.size) return out;
  // sqlite bm25(): negative, lower=better → negate so higher=better, then min-max to [0,1].
  const mapped = new Map<string, number>();
  for (const [id, v] of raw) mapped.set(id, -v);
  const nums = [...mapped.values()];
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  if (hi === lo) {
    for (const [id] of mapped) out.set(id, 1);
    return out;
  }
  for (const [id, v] of mapped) out.set(id, (v - lo) / (hi - lo));
  return out;
}

/** Statuses excluded from automatic retrieval (trust boundary). Eligibility gates on this, never on score. */
export const INELIGIBLE_STATUSES = new Set(["superseded", "stale", "candidate", "forgotten", "disputed"]);
export function isEligible(entry: Pick<MemoryEntry, "status">): boolean {
  return !INELIGIBLE_STATUSES.has(entry.status);
}
/** Rank-only RRF fusion: Σ over lists of 1/(k+rank), rank 1-based. Stable. */
export function rrfFuse(rankLists: string[][], k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of rankLists) {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return fused;
}

/** Order entry ids by raw FTS rank ascending (lower=better; negatives first). Stable. */
export function orderFtsIds(raw: Map<string, number>): string[] {
  return [...raw.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
}

export function retrieveMemory(
  entries: MemoryEntry[],
  ctx: QueryContext,
  opts: RetrievalOptions,
  now: number = Date.now(),
): RetrievalResult {
  if (!entries.length) return { selected: [], considered: 0, tokensSelected: 0 };
  const minScore = opts.minScore ?? 0.05;
  // Guard NaN/non-finite/non-positive RRF/fetch params → defaults (else NaN scores / empty fetch).
  const rrfKRaw = opts.rrfK ?? 60;
  const rrfK = Number.isFinite(rrfKRaw) && rrfKRaw > 0 ? rrfKRaw : 60;
  const overFetchRaw = opts.overFetch ?? 5;
  const overFetch = Number.isFinite(overFetchRaw) && overFetchRaw > 0 ? overFetchRaw : 5;
  const fetchN = Math.max(opts.maxEntries * overFetch, opts.maxEntries);
  const rankCutoff = Math.min(opts.rankCutoff ?? opts.maxEntries, opts.maxEntries);
  // Single tokenization pass: tokens built once, shared by stats + scorer (O(NL) noted in ranking.ts).
  const tokenCache: string[][] = [];
  const stats = buildCorpusStats(entries, tokenCache);

  // Lexical source: BM25-backed scoreMemory, stable-sorted desc.
  // Eligibility gates on status (trust boundary), never on score: neutral
  // 0-score active docs stay eligible via FTS and rank last instead of dropping.
  const rawScores = entries.map((entry, idx) => ({
    entry,
    idx,
    score: scoreMemory(entry, ctx, now, stats, opts.scoring, tokenCache[idx]),
  }));
  const eligible = new Set(entries.filter(isEligible).map((e) => e.id));
  const scored = rawScores
    .filter((s) => s.score > minScore)
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
  const lexicalIds = scored.slice(0, fetchN).map((s) => s.entry.id);

  const hasFts = opts.bm25 !== undefined && opts.bm25.size > 0;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const lexScore = new Map(scored.map((s) => [s.entry.id, s.score]));

  let fusedOrder: string[];
  let fused: Map<string, number> | null = null;
  let ftsRank = new Map<string, number>();
  let ftsNorm: Map<string, number> = new Map();
  if (hasFts) {
    ftsNorm = normalizeFtsScores(opts.bm25!);
    const ftsIds = orderFtsIds(opts.bm25!)
      .filter((id) => byId.has(id) && eligible.has(id))
      .slice(0, fetchN);
    ftsIds.forEach((id, i) => ftsRank.set(id, i + 1));
    if (!lexicalIds.length) {
      // BM25-only fallback: FTS is the single source, no fusion.
      fusedOrder = ftsIds;
    } else if (!ftsIds.length) {
      fusedOrder = lexicalIds;
    } else {
      fused = rrfFuse([lexicalIds, ftsIds], rrfK);
      const lexPos = new Map(lexicalIds.map((id, i) => [id, i]));
      fusedOrder = [...fused.entries()]
        .sort((a, b) => b[1] - a[1] || (lexPos.get(a[0]) ?? 1e9) - (lexPos.get(b[0]) ?? 1e9) || (a[0] < b[0] ? -1 : 1))
        .map(([id]) => id);
    }
  } else {
    fusedOrder = lexicalIds;
  }

  const cut = fusedOrder.slice(0, Math.max(0, rankCutoff));
  const selected: MemorySelection[] = [];
  let tokens = 0;
  for (const id of cut) {
    if (selected.length >= opts.maxEntries) break;
    const entry = byId.get(id)!;
    const est = estimateTokens(entry.content);
    if (tokens + est > opts.maxTokens) continue;
    tokens += est;
    // M1: single-source fallback backfills from ftsNorm (rank-derived
    // 1/(k+r) if norm missing) so fallback scores are non-zero with fts source.
    // Fusion stays rank-only RRF; no score mixing.
    const rank = ftsRank.get(id);
    const score = fused
      ? fused.get(id)!
      : (lexScore.get(id) ?? ftsNorm.get(id) ?? (rank !== undefined ? 1 / (rrfK + rank) : 0));
    selected.push({
      entry,
      score: round2(score),
      estimatedTokens: est,
      reason: explain(entry, ctx, score, ftsRank.get(id), fused !== null, ftsNorm.get(id)),
    });
  }

  return { selected, considered: entries.length, tokensSelected: tokens };
}

function explain(entry: MemoryEntry, ctx: QueryContext, score: number, ftsRank?: number, fused?: boolean, ftsNorm?: number): string {
  // Sanitize: strip ANSI SGR sequences + C0 controls, collapse to single line.
  const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  const CTRL = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]+", "g");
  const clean = (s: string) =>
    s.replace(ANSI, "").replace(CTRL, " ").replace(/[\r\n\t]+/g, " ").slice(0, 60);
  const bits: string[] = [];
  const contentLower = entry.content.toLowerCase();
  const matched = ctx.tokens.filter((t) => contentLower.includes(t)).slice(0, 4).map(clean);
  if (matched.length) bits.push(`matches "${matched.join(", ")}"`);
  const tagHit = entry.tags.filter((t) => ctx.tags.includes(t.toLowerCase())).map(clean);
  if (tagHit.length) bits.push(`tags [${tagHit.join(", ")}]`);
  const fileHit = entry.relatedFiles.filter(
    (f) => ctx.hintFiles.includes(f) || ctx.changedFiles.includes(f),
  );
  if (fileHit.length) bits.push(`related file ${clean(fileHit[0]!)}`);
  bits.push(`${entry.kind}, confidence ${entry.confidence}`);
  // NOTE: unreachable in automatic retrieval -- "disputed" is in
  // INELIGIBLE_STATUSES and disputed entries score 0 (pre-filtered). Kept for
  // direct/manual explain callers; do not change scoring here.
  if (entry.status === "disputed") bits.push("DISPUTED");
  if (ftsRank !== undefined) bits.push(`fts rank #${ftsRank}`);
  if (ftsNorm !== undefined) bits.push(`bm25=${round2(ftsNorm)}`);
  if (fused) bits.push(`rrf=${round2(score)}`);
  const out = `${bits.join("; ")} (score ${round2(score)})`
    .replace(ANSI, "").replace(CTRL, " ").replace(/[\r\n\t]+/g, " ");
  return out.length > 200 ? `${out.slice(0, 197)}...` : out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
