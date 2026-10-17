/**
 * Human-readable metrics reporting. Produces a compact multi-line summary. All
 * Estimated context traffic and observed provider usage are labeled separately.
 */

import type { MetricsSnapshot } from "../types.ts";
import type { MeasurementExtras } from "./collector.ts";

export function formatMetrics(s: MetricsSnapshot, extras?: MeasurementExtras): string {
  const reduction =
    s.estimatedTokensSelected + s.estimatedTokensExcluded > 0
      ? Math.round(
          (s.estimatedTokensExcluded / (s.estimatedTokensSelected + s.estimatedTokensExcluded)) *
            100,
        )
      : 0;
  const lines = [
    "supracortex metrics (estimated context; observed usage separately)",
    "",
    "Retrieval:",
    `  events captured:            ${s.eventsCaptured}`,
    `  handoffs created:           ${s.handoffsCreated}`,
    `  resumes consumed:          ${s.resumesConsumed}`,
    `  evidence stale-marked:     ${s.evidenceStaleMarked}`,
    `  files considered:          ${s.filesConsidered}`,
    `  files opened:              ${s.filesOpened}`,
    `  unchanged files skipped:   ${s.unchangedFilesSkipped}`,
    `  memory entries considered: ${s.memoryEntriesConsidered}`,
    `  memory entries selected:   ${s.memoryEntriesSelected}`,
    "",
    "Cache:",
    `  hits:                      ${s.cacheHits}`,
    `  misses:                    ${s.cacheMisses}`,
    `  stale summaries rejected:  ${s.staleSummariesRejected}`,
    "",
    "Efficiency:",
    `  duplicate reads detected:      ${s.duplicateReadsDetected}`,
    `  duplicate assignments detected:${s.duplicateAssignmentsDetected}`,
    `  duplicate skill loads avoided: ${s.duplicateSkillLoadsAvoided}`,
    `  duplicate research avoided:    ${s.duplicateResearchAvoided}`,
    "",
    "Skills & MCP:",
    `  skills considered:   ${s.skillsConsidered}`,
    `  skills recommended:  ${s.skillsRecommended}`,
    `  mcp servers considered: ${s.mcpServersConsidered}`,
    `  mcp servers selected:   ${s.mcpServersSelected}`,
    `  mcp tools selected:     ${s.mcpToolsSelected}`,
    "",
    "Jev (this process; HTTP count includes validated responses only):",
    `  HTTP responses:        ${s.jevCalls}`,
    `  cache hits:            ${s.jevCacheHits}`,
    `  decisions applied:     ${s.jevDecisionsApplied}`,
    `  no-client fallbacks:   ${s.jevFallbacks}`,
    `  input/output tokens:   ${s.jevInputTokens}/${s.jevOutputTokens}`,
    "",
    "Tokens (estimated):",
    `  selected:  ${s.estimatedTokensSelected}`,
    `  excluded:  ${s.estimatedTokensExcluded}`,
    `  last packet: ${s.contextPacketTokens}`,
    `  estimated context reduction: ${reduction}%`,
    `  raw findings persisted to durable memory: ${s.rawFindingsPersisted}`,
    "",
    "Host-observed usage:",
    `  input tokens:          ${s.hostInputTokens}`,
    `  output tokens:         ${s.hostOutputTokens}`,
    `  reasoning tokens:      ${s.hostReasoningTokens}`,
    `  provider cache reads:  ${s.providerCacheReadTokens}`,
    `  provider cache writes: ${s.providerCacheWriteTokens}`,
    `  host-reported cost:    ${s.hostReportedCost}`,
    "",
    ...formatBilledVsEstimated(s, extras),
  ];
  return lines.join("\n");
}

/**
 * One billed-vs-estimated output block (Wave 2, item 9a). Billed figures are
 * measured host-observed counters; the estimate is labeled and is never used
 * as a savings basis. Without extras the billed line still renders from the
 * snapshot; the estimate is reported as unavailable, never 0-by-default in a
 * way that implies measurement.
 */
export function formatBilledVsEstimated(
  s: MetricsSnapshot,
  extras?: MeasurementExtras,
): string[] {
  const billedIn =
    s.hostInputTokens + s.providerCacheReadTokens + s.providerCacheWriteTokens;
  const estimated =
    extras?.estimatedToolTokens ??
    s.estimatedTokensSelected + s.estimatedTokensExcluded;
  const estimatedLabel = extras
    ? "estimated tool traffic (labeled estimate, not billing)"
    : "estimated context traffic (labeled estimate, not billing)";
  const lines = [
    "Tokens billed (measured) vs estimated:",
    `  billed-in (measured): ${billedIn} = input ${s.hostInputTokens} + cache reads ${s.providerCacheReadTokens} + cache writes ${s.providerCacheWriteTokens}`,
    `  billed-out (measured): ${s.hostOutputTokens}`,
    `  ${estimatedLabel}: ${estimated}`,
  ];
  if (extras) {
    lines.push(
      `  main vs subagent input (measured): main ${extras.mainInputTokens} / subagent ${extras.subInputTokens}`,
      `  main vs subagent output (measured): main ${extras.mainOutputTokens} / subagent ${extras.subOutputTokens}`,
      `  compactions observed (counted, not tokens saved): ${extras.compactionsObserved}`,
    );
  }
  return lines;
}
