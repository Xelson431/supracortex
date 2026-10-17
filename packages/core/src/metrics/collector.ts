/**
 * In-memory metrics collector. Snapshots can be persisted by the engine to
 * `.supracortex/metrics/`. All counters are additive within a session.
 */

import type { MetricsSnapshot } from "../types.ts";

/**
 * Measurement-honesty extras kept alongside the snapshot without changing its
 * schema. Billed (measured) and estimated traffic are disjoint by construction:
 * estimates are recorded only via `recordEstimatedToolTokens`, never derived
 * from billed counters. No savings claim is computed from estimates.
 */
export interface MeasurementExtras {
  /** Labeled-estimate tool traffic. Never billed, never a savings basis. */
  estimatedToolTokens: number;
  /** Count of observed compaction operations (measured, not tokens saved). */
  compactionsObserved: number;
  mainInputTokens: number;
  mainOutputTokens: number;
  subInputTokens: number;
  subOutputTokens: number;
}

export function emptyExtras(): MeasurementExtras {
  return {
    estimatedToolTokens: 0,
    compactionsObserved: 0,
    mainInputTokens: 0,
    mainOutputTokens: 0,
    subInputTokens: 0,
    subOutputTokens: 0,
  };
}

function cleanCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function emptySnapshot(): MetricsSnapshot {
  return {
    eventsCaptured: 0,
    handoffsCreated: 0,
    resumesConsumed: 0,
    evidenceStaleMarked: 0,
    filesConsidered: 0,
    filesOpened: 0,
    unchangedFilesSkipped: 0,
    cacheHits: 0,
    cacheMisses: 0,
    staleSummariesRejected: 0,
    duplicateReadsDetected: 0,
    duplicateAssignmentsDetected: 0,
    estimatedTokensSelected: 0,
    estimatedTokensExcluded: 0,
    memoryEntriesConsidered: 0,
    memoryEntriesSelected: 0,
    contextPacketTokens: 0,
    skillsConsidered: 0,
    skillsRecommended: 0,
    duplicateSkillLoadsAvoided: 0,
    mcpServersConsidered: 0,
    mcpServersSelected: 0,
    mcpToolsSelected: 0,
    duplicateResearchAvoided: 0,
    rawFindingsPersisted: 0,
    jevDecisionsApplied: 0,
    jevFallbacks: 0,
    jevCalls: 0,
    jevCacheHits: 0,
    jevInputTokens: 0,
    jevOutputTokens: 0,
    hostInputTokens: 0,
    hostOutputTokens: 0,
    hostReasoningTokens: 0,
    providerCacheReadTokens: 0,
    providerCacheWriteTokens: 0,
    hostReportedCost: 0,
  };
}

export class MetricsCollector {
  private snap: MetricsSnapshot = emptySnapshot();
  private extras: MeasurementExtras = emptyExtras();

  add(patch: Partial<MetricsSnapshot>): void {
    for (const key of Object.keys(patch) as Array<keyof MetricsSnapshot>) {
      const v = patch[key];
      if (typeof v === "number") this.snap[key] += v;
    }
  }

  set(patch: Partial<MetricsSnapshot>): void {
    for (const key of Object.keys(patch) as Array<keyof MetricsSnapshot>) {
      const v = patch[key];
      if (typeof v === "number") this.snap[key] = v;
    }
  }

  snapshot(): MetricsSnapshot {
    return { ...this.snap };
  }

  reset(): void {
    this.snap = emptySnapshot();
    this.extras = emptyExtras();
  }

  // -- Measurement-honesty extras (Wave 2, items 2d + 9a) -------------------
  // Separate from MetricsSnapshot so the snapshot schema stays stable.
  // All values are additive within a session; NaN is coerced to 0.

  /** Labeled-estimate tool traffic (chars/4 or estimator path), never billed. */
  recordEstimatedToolTokens(tokens: number): void {
    this.extras.estimatedToolTokens += cleanCount(tokens);
  }

  /** Observed compaction operations (measured count, not savings). */
  recordCompaction(count = 1): void {
    this.extras.compactionsObserved += cleanCount(count);
  }

  /** Measured host input/output attributed to main vs subagent traffic. */
  recordAgentUsage(
    role: "main" | "subagent",
    inputTokens: number,
    outputTokens: number,
  ): void {
    if (role === "main") {
      this.extras.mainInputTokens += cleanCount(inputTokens);
      this.extras.mainOutputTokens += cleanCount(outputTokens);
    } else {
      this.extras.subInputTokens += cleanCount(inputTokens);
      this.extras.subOutputTokens += cleanCount(outputTokens);
    }
  }

  /**
   * Measured billed-in tokens: input + cacheRead + cacheWrite, all disjoint
   * host-observed counters. Estimates never enter this sum.
   */
  billedInputTokens(): number {
    return (
      this.snap.hostInputTokens +
      this.snap.providerCacheReadTokens +
      this.snap.providerCacheWriteTokens
    );
  }

  extrasSnapshot(): MeasurementExtras {
    return { ...this.extras };
  }
}
