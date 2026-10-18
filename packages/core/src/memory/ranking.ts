/**
 * Deterministic relevance scoring for memory entries and files.
 *
 * Lexical core is real BM25 (ATIRE TF + Robertson/Sparck-Jones IDF,
 * k1=1.2, b=0.75, length normalization). Document frequencies come from an
 * explicit corpus-stats param (storage-agnostic, no globals). Tag, file,
 * symbol, recency, confidence and kind signals blend on top with calibrated
 * weights; recency shape/weight are params (linear 30-day decay = default).
 */

import type { MemoryEntry, MemoryKind } from "../types.ts";

export interface QueryContext {
  /** Lowercased tokens extracted from the task query. */
  tokens: string[];
  /** Raw query string. */
  query: string;
  tags: string[];
  /** Files the caller flagged as relevant (project-relative). */
  hintFiles: string[];
  /** Files currently changed in git (project-relative). */
  changedFiles: string[];
}

const KIND_WEIGHT: Record<MemoryKind, number> = {
  constraint: 1.3,
  failure: 1.25,
  decision: 1.15,
  convention: 1.1,
  fact: 1.0,
  "task-outcome": 0.9,
};

/** BM25 constants (bm25s ATIRE / tantivy defaults). */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** Corpus statistics for IDF + length normalization. Built per query set, never global. */
export interface CorpusStats {
  docCount: number;
  avgDocLen: number;
  docFreq: Map<string, number>;
}

export interface ScoreOptions {
  /** Weight of the recency term (default 0.3). */
  recencyWeight?: number;
  /** Linear decay window in days (default 30). */
  recencyWindowDays?: number;
  /** Apply KIND_WEIGHT multiplier (default true; disable if holdout says so). */
  kindMultiplier?: boolean;
  k1?: number;
  b?: number;
}

export function tokenize(text: string): string[] {
  // Preserve Unicode words and make source identifiers searchable without a
  // separate language-specific tokenizer. CJK ideographs are emitted one at a
  // time so a query for a term inside an unspaced identifier can still match.
  const normalized = text
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{Nd}])([\p{Lu}])/gu, "$1 $2")
    .toLocaleLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const tokens: string[] = [];
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      for (const character of word) if (/\p{Script=Han}/u.test(character)) tokens.push(character);
      continue;
    }
    if (word.length >= 2) tokens.push(word);
  }
  return tokens;
}

function compactIdentifier(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Robertson/Sparck-Jones IDF: ln(1 + (N - df + 0.5) / (df + 0.5)). */
export function bm25Idf(docFreq: number, docCount: number): number {
  if (docCount <= 0) return 0;
  const df = Math.min(Math.max(docFreq, 0), docCount);
  return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
}

/** Saturating norm so unbounded BM25 (~0..10+) maps to ~0..1 and tag/file/recency still matter. */
export const BM25_SAT_K = 1.5;
export function saturateBm25(score: number, k: number = BM25_SAT_K): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return score / (score + k);
}

/** Single tokenization of the indexed field (content + tags). Reuse to avoid 2x O(NL) passes. */
export function docFieldTokens(entry: Pick<MemoryEntry, "content" | "tags">): string[] {
  return [...tokenize(entry.content), ...entry.tags.flatMap((t) => tokenize(t))];
}

/**
 * Build corpus stats from entries (content + tags are the indexed field).
 * Cost is O(N*L) tokenization; pass `outTokens` to reuse the tokenized docs
 * in scoreMemory instead of re-tokenizing (single pass). Formulas unchanged.
 */
export function buildCorpusStats(
  entries: Pick<MemoryEntry, "content" | "tags">[],
  outTokens?: string[][],
): CorpusStats {
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const toks = outTokens?.[i] ?? docFieldTokens(e);
    if (outTokens) outTokens[i] = toks;
    totalLen += toks.length;
    for (const t of new Set(toks)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const docCount = entries.length;
  return { docCount, avgDocLen: docCount ? totalLen / docCount : 0, docFreq };
}

/** ATIRE BM25 for one document: Σ idf * tf*(k1+1) / (tf + k1*(1-b+b*dl/avgdl)). */
export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  stats: CorpusStats,
  k1: number = BM25_K1,
  b: number = BM25_B,
): number {
  if (!queryTokens.length || !docTokens.length || stats.docCount === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const dl = docTokens.length;
  // Guard: non-finite or empty corpus avg falls back to this doc's length (no magic constant).
  const avg =
    Number.isFinite(stats.avgDocLen) && stats.avgDocLen > 0 ? stats.avgDocLen : dl;
  let score = 0;
  for (const q of new Set(queryTokens)) {
    const f = tf.get(q) ?? 0;
    if (!f) continue;
    const idf = bm25Idf(stats.docFreq.get(q) ?? 0, stats.docCount);
    score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avg));
  }
  return score;
}

export function buildQueryContext(
  query: string,
  tags: string[],
  hintFiles: string[],
  changedFiles: string[],
): QueryContext {
  return {
    tokens: Array.from(new Set(tokenize(query))),
    query,
    tags: tags.map((t) => t.toLowerCase()),
    hintFiles,
    changedFiles,
  };
}

/**
 * Score a memory entry against the query. Higher is more relevant.
 * Lexical core is BM25 over content+tags; remaining signals blend on top.
 * `stats` is optional (fallback IDF=1 per matched term preserves ordering
 * for single-doc callers); pass buildCorpusStats(entries) for true BM25.
 */
export function scoreMemory(
  entry: MemoryEntry,
  ctx: QueryContext,
  now: number,
  stats?: CorpusStats,
  opts: ScoreOptions = {},
  preTokenized?: string[],
): number {
  // A disputed assertion remains available through explicit review/detail
  // workflows, but never joins automatic task context. Presenting it as a
  // recommendation weakens the trust boundary precisely when evidence is in
  // conflict.
  if (entry.status === "superseded" || entry.status === "stale" || entry.status === "candidate" || entry.status === "forgotten" || entry.status === "disputed") return 0;

  const k1 = opts.k1 ?? BM25_K1;
  const b = opts.b ?? BM25_B;
  const docTokens = preTokenized ?? docFieldTokens(entry);
  let rawLexical: number;
  if (stats) {
    rawLexical = bm25Score(ctx.tokens, docTokens, stats, k1, b);
  } else {
    // Single-doc fallback: TF with length-norm and unit IDF (ordering-only).
    // avgdl unknown without a corpus → 100 (typical doc length), not magic 10.
    const tf = new Map<string, number>();
    for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = docTokens.length || 1;
    rawLexical = 0;
    for (const q of new Set(ctx.tokens)) {
      const f = tf.get(q) ?? 0;
      if (f) rawLexical += ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / 100 || 1)))) * 1;
    }
  }
  // Saturate unbounded BM25 to ~0..1 so tag/file/recency blends still matter.
  const lexical = saturateBm25(rawLexical);
  // Tag hits get a half-weight BM25 pass so tag-only matches still rank.
  const tagSet = new Set(entry.tags.map((t) => t.toLowerCase()));
  let tagScore = 0;
  for (const tag of ctx.tags) if (tagSet.has(tag)) tagScore += 1;
  const tagNorm = ctx.tags.length ? tagScore / ctx.tags.length : 0;

  // File overlap: related files matching hints or changed files.
  const related = new Set(entry.relatedFiles);
  let fileOverlap = 0;
  for (const f of ctx.hintFiles) if (related.has(f)) fileOverlap += 1;
  for (const f of ctx.changedFiles) if (related.has(f)) fileOverlap += 0.75;
  const fileNorm = Math.min(1, fileOverlap / 3);

  // Recency: linear decay over recencyWindowDays (default 30-day window).
  // Non-positive/non-finite window disables recency (0) instead of NaN/flip.
  const windowDays = opts.recencyWindowDays ?? 30;
  const recencyWeight = opts.recencyWeight ?? 0.3;
  const ageDays = (now - new Date(entry.updatedAt).getTime()) / 86_400_000;
  const recency =
    Number.isFinite(windowDays) && windowDays > 0 ? Math.max(0, 1 - ageDays / windowDays) : 0;

  // Symbol overlap: query tokens matching this entry's related symbols. Bounded.
  let symbolHits = 0;
  if (entry.relatedSymbols.length) {
    const symbolTokens = new Set(entry.relatedSymbols.flatMap((symbol) => [...tokenize(symbol), compactIdentifier(symbol)]));
    for (const token of ctx.tokens) if (symbolTokens.has(token) || symbolTokens.has(compactIdentifier(token))) symbolHits += 1;
  }
  const symbolBoost = Math.min(0.6, symbolHits * 0.15);

  const base =
    lexical + tagNorm * 0.6 + fileNorm * 0.8 + recency * recencyWeight + entry.confidence * 0.4 + symbolBoost;

  if (opts.kindMultiplier === false) return base;
  return base * KIND_WEIGHT[entry.kind];
}

export interface FileScoreInput {
  path: string;
  symbols: string[];
}

// Task prose is not file evidence. Keeping connective/instruction words in the
// denominator made an exact checkout path match fail the minimum score for
// normal sentences (while a one-word query succeeded).
const FILE_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "in", "into", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "which", "with",
  "find", "locate", "identify", "show", "where", "file", "files", "code",
  "repository", "repo", "project", "creates", "create", "related",
  // Intent/filler words describe the task, not a repository path.
  "how", "does", "do", "did", "work", "works", "use", "uses", "using", "used",
  "can", "could", "should", "would", "what", "why", "when", "who", "need",
  "needs", "get", "gets", "make", "makes",
]);

/**
 * Generic structural path names. They still match (30% of the normal path
 * weight) so an explicit `src/app/layout.tsx` query keeps working, but they
 * cannot dominate over a specific module name such as `auth`.
 */
const LOW_SIGNAL_PATH_TOKENS = new Set([
  "app", "src", "lib", "components", "component", "pages", "page", "layout",
  "routes", "route", "api", "index", "utils", "util", "hooks", "types",
  "styles", "public", "static", "server", "client",
]);

const LOW_SIGNAL_PATH_WEIGHT = 0.3;
const PREFIX_MATCH_WEIGHT = 0.5;
const PREFIX_MATCH_MIN_LENGTH = 4;

/** Conservative prefix match: both sides >= 4 chars and the same first 4. */
function sharesLeadingPrefix(a: string, b: string): boolean {
  return (
    a.length >= PREFIX_MATCH_MIN_LENGTH &&
    b.length >= PREFIX_MATCH_MIN_LENGTH &&
    a.slice(0, PREFIX_MATCH_MIN_LENGTH) === b.slice(0, PREFIX_MATCH_MIN_LENGTH)
  );
}

/** Terms that can actually justify a file match (shared with selection reasons). */
export function fileQueryTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !FILE_QUERY_STOPWORDS.has(token));
}

/**
 * Score a repository file against the query using path tokens, symbol overlap,
 * changed-file bonus and hint bonus.
 */
export function scoreFile(
  file: FileScoreInput,
  ctx: QueryContext,
  preferChangedFiles: boolean,
): number {
  const pathTokens = new Set(tokenize(file.path));
  const symbolTokens = new Set(file.symbols.flatMap((s) => tokenize(s)));

  const queryTokens = fileQueryTokens(ctx.tokens);
  let lexical = 0;
  for (const t of queryTokens) {
    const pathExact = pathTokens.has(t);
    const symbolExact = symbolTokens.has(t);
    if (pathExact) {
      lexical += 1.2 * (LOW_SIGNAL_PATH_TOKENS.has(t) ? LOW_SIGNAL_PATH_WEIGHT : 1);
    }
    if (symbolExact) lexical += 1.0;
    // Only fall back to prefixes when there is no exact match at all, so a
    // specific token never gets counted twice. Prefixes bridge inflections
    // (auth ~ authentication) without matching unrelated roots.
    if (!pathExact && !symbolExact && t.length >= PREFIX_MATCH_MIN_LENGTH) {
      for (const p of pathTokens) {
        if (sharesLeadingPrefix(t, p)) {
          lexical +=
            1.2 *
            PREFIX_MATCH_WEIGHT *
            (LOW_SIGNAL_PATH_TOKENS.has(p) ? LOW_SIGNAL_PATH_WEIGHT : 1);
          break;
        }
      }
      for (const s of symbolTokens) {
        if (sharesLeadingPrefix(t, s)) {
          lexical += 1.0 * PREFIX_MATCH_WEIGHT;
          break;
        }
      }
    }
  }
  const lexicalNorm = queryTokens.length ? lexical / (queryTokens.length * 1.2) : 0;

  const hintBonus = ctx.hintFiles.includes(file.path) ? 1.0 : 0;
  // Changed status prioritizes relevant files; it cannot make an unrelated
  // lockfile outrank the checkout files named by the task.
  const changedBonus = preferChangedFiles && lexical > 0 && ctx.changedFiles.includes(file.path) ? 0.5 : 0;

  return lexicalNorm + hintBonus + changedBonus;
}
