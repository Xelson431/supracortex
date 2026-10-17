/**
 * File selection for context packets.
 *
 * Given the repository index, a query context, cached summaries and a token
 * budget, choose which files to include as full content, as summaries, or as
 * bare references. Every decision (include or omit) is explained.
 */

import type {
  ContextOmission,
  FileSelection,
  FileSummary,
  IndexedFile,
  SummarySelection,
} from "../types.ts";
import { fileQueryTokens, scoreFile, type QueryContext } from "../memory/ranking.ts";
import { TokenBudget } from "./token-budget.ts";

export interface SelectorOptions {
  maxRecommendedReads: number;
  summaryThresholdTokens: number;
  preferChangedFiles: boolean;
  minScore?: number;
  /**
   * Compaction trigger inputs (all params, never hardcoded by callers):
   * fire when used tokens reach `contextWindow - reserveTokensForSummary`.
   * `reserveTokensForSummary` may be overridden by `SUPRACORTEX_RESERVE_TOKENS`;
   * `contextWindow` may be overridden by `SUPRACORTEX_CONTEXT_WINDOW`.
   */
  contextWindow?: number;
  reserveTokensForSummary?: number;
  /** Minimum tokens that must remain even after clamping. Default 1000. */
  floorBufferTokens?: number;
  modelHint?: string;
}

export interface SelectorInput {
  index: Record<string, IndexedFile>;
  summaries: Record<string, FileSummary>;
  ctx: QueryContext;
  budget: TokenBudget;
  options: SelectorOptions;
}

export interface SelectorResult {
  files: FileSelection[];
  summaries: SummarySelection[];
  omissions: ContextOmission[];
  filesConsidered: number;
  staleSummariesRejected: number;
  /**
   * Billed planning charge: every recommended read counts its FULL source
   * tokens as billed fresh on the second (agent) read — never a free
   * reference. Reference framing on the wire is metadata only.
   */
  billedEstimate: number;
  /** True: billedEstimate derives from heuristic estimates, not measurement. */
  estimated: boolean;
  /** Present when used tokens reached the compaction threshold. No savings claim. */
  triggerReason?: string;
  /** Resolved compaction threshold (contextWindow - reserve), when known. */
  compactionThreshold?: number;
}

/** Reserve-aware compaction trigger. Pure: thresholds are params, not hardcoded. */
export interface CompactionTrigger {
  threshold: number;
  contextWindow: number;
  reserve: number;
  windowUnknown: boolean;
  clamped: boolean;
  triggerReason?: string;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_RESERVE_TOKENS = 8_000;
/** Guaranteed minimum usable budget below the trigger; callers pass their own. */
export const DEFAULT_FLOOR_BUFFER_TOKENS = 0;

function envInt(name: string): number | null {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw == null || raw === "") return null;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Resolve the compaction trigger: fires at `contextWindow - reserve`.
 * Window unknown → safe default + reason. Reserve > window → clamp + warn.
 */
export function resolveCompactionTrigger(
  usedTokens: number,
  options: Pick<SelectorOptions, "contextWindow" | "reserveTokensForSummary" | "floorBufferTokens"> = {},
): CompactionTrigger {
  const floor = Math.max(0, options.floorBufferTokens ?? DEFAULT_FLOOR_BUFFER_TOKENS);
  let contextWindow = options.contextWindow ?? envInt("SUPRACORTEX_CONTEXT_WINDOW") ?? -1;
  const windowUnknown = contextWindow <= 0;
  if (windowUnknown) contextWindow = DEFAULT_CONTEXT_WINDOW;
  const maxReserve = Math.max(0, contextWindow - floor);
  let reserve = envInt("SUPRACORTEX_RESERVE_TOKENS") ?? options.reserveTokensForSummary ?? DEFAULT_RESERVE_TOKENS;
  let clamped = false;
  if (reserve > maxReserve) {
    reserve = maxReserve;
    clamped = true;
    console.warn(
      `[context] reserveTokensForSummary clamped to ${reserve} (window ${contextWindow}, floor ${floor})`,
    );
  }
  const threshold = Math.max(0, contextWindow - reserve);
  let triggerReason: string | undefined;
  if (usedTokens >= threshold) {
    triggerReason =
      `compaction-trigger: used ${usedTokens} >= window ${contextWindow} - reserve ${reserve}` +
      (windowUnknown ? " (window unknown, safe default)" : "");
  } else if (windowUnknown) {
    triggerReason = undefined;
  }
  return { threshold, contextWindow, reserve, windowUnknown, clamped, triggerReason };
}

export function selectFiles(input: SelectorInput): SelectorResult {
  const { index, summaries, ctx, budget, options } = input;
  const minScore = options.minScore ?? 0.15;

  const scored = Object.values(index)
    .map((f) => ({ file: f, score: scoreFile({ path: f.path, symbols: f.symbols }, ctx, options.preferChangedFiles) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const files: FileSelection[] = [];
  const summarySelections: SummarySelection[] = [];
  const omissions: ContextOmission[] = [];
  let fullCount = 0;
  let staleRejected = 0;

  for (const { file, score } of scored) {
    const est = file.estimatedTokens;
    const summary = summaries[file.path];
    const summaryValid = summary && summary.sourceHash === file.hash;
    const summaryStale = summary && summary.sourceHash !== file.hash;

    // Prefer exact hash-bound summary text when available. It is the only file
    // evidence this selector can honestly place on the wire without source IO.
    if (summaryValid) {
      const sEst = summary.estimatedTokens;
      if (budget.tryConsume(sEst)) {
        summarySelections.push({
          path: file.path,
          summary: summary.summary,
          sourceHash: summary.sourceHash,
          verified: true,
          estimatedTokens: sEst,
          reason: buildFileReason(file, ctx, score, "summary"),
        });
        continue;
      }
    }

    if (summaryStale) {
      staleRejected++;
      // Track the stale rejection, but defer the omission: if the file is
      // subsequently selected as a read recommendation, the omission is removed
      // so a path is never both selected and omitted.
      // Try to include a reference instead if budget allows.
    }

    // A source body is not available here. Recommend a future read and charge
    // only its metadata framing, while retaining the separate source estimate.
    const refTokens = estimateReferenceTokens(file.path);
    const canRecommend = fullCount < options.maxRecommendedReads &&
      (est <= options.summaryThresholdTokens || score >= 0.4);
    if (canRecommend && budget.tryConsume(refTokens)) {
      files.push({
        path: file.path,
        mode: "reference",
        estimatedTokens: refTokens,
        estimatedSourceTokens: est,
        score: round2(score),
        reason: buildFileReason(file, ctx, score, "read-recommended"),
        hash: file.hash,
      });
      fullCount++;
      continue;
    }

    if (summaryStale) {
      omissions.push({
        path: file.path,
        reason: "unchanged-cached",
        detail: "cached summary rejected: source hash changed (stale)",
      });
    } else {
      omissions.push({
        path: file.path,
        reason: budget.remaining <= 0 ? "budget-exhausted" : "low-relevance",
        detail: `score ${round2(score)}, est ${est} tokens`,
      });
    }
  }

  // Billed planning charge: a recommended read is NOT free. The reference
  // framing on the wire is metadata only; the second (agent) read bills the
  // full source body fresh. Estimates here are heuristic → labeled estimated.
  budget.markEstimated();
  const billedEstimate =
    files.reduce((acc, f) => acc + Math.max(0, f.estimatedSourceTokens ?? f.estimatedTokens), 0) +
    summarySelections.reduce((acc, s) => acc + Math.max(0, s.estimatedTokens), 0);
  const trigger = resolveCompactionTrigger(budget.usedTokens, options);

  return {
    files,
    summaries: summarySelections,
    omissions,
    filesConsidered: scored.length,
    staleSummariesRejected: staleRejected,
    billedEstimate,
    estimated: true,
    ...(trigger.triggerReason ? { triggerReason: trigger.triggerReason } : {}),
    compactionThreshold: trigger.threshold,
  };
}

function buildFileReason(
  file: IndexedFile,
  ctx: QueryContext,
  score: number,
  mode: string,
): string {
  const bits: string[] = [];
  const matched = fileQueryTokens(ctx.tokens).filter(
    (t) => file.path.toLowerCase().includes(t) || file.symbols.some((s) => s.toLowerCase().includes(t)),
  );
  if (matched.length) bits.push(`matches "${matched.slice(0, 3).join(", ")}"`);
  if (ctx.hintFiles.includes(file.path)) bits.push("caller hint");
  if (ctx.changedFiles.includes(file.path)) bits.push("git-changed");
  bits.push(`${mode}, ~${file.estimatedTokens}tok`);
  return `${bits.join("; ")} (score ${round2(score)})`;
}

function estimateReferenceTokens(path: string): number {
  return Math.max(3, Math.ceil(path.length / 4) + 4);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
