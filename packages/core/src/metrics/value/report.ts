/**
 * Value measurement report. Aggregation happens ON READ — never on write.
 *
 * Correlation key is `(taskId, incarnationId)`. Rows lacking `incarnationId`
 * (legacy) are counted only in an explicitly labelled "unattributed" bucket and
 * are never merged into a keyed group. A reused taskId with a NEW incarnationId
 * is a distinct task and never merges into the previous task's group.
 *
 * The report is segmented by `supracortex.context.injected`. A task's injected
 * flag is taken from its most recent `context_injection` row. Tasks with no
 * injection row are attributed but unclassified, and are excluded from the
 * comparison. An `inferred` outcome is NEVER counted as verified success.
 *
 * Refusal: a comparison is only rendered when BOTH segments have at least
 * MIN_SEGMENT_SAMPLE tasks. Below that it refuses and reports "not enough data".
 * Every rendered comparison carries the literal correlation label.
 */

import type { OutcomeStatus } from "../../types.ts";
import type { ProviderUsageEvent } from "../../types.ts";
import type { ValueEvent } from "./types.ts";

export const MIN_SEGMENT_SAMPLE = 20;
export const VALUE_CORRELATION_LABEL =
  "correlational — not causal; sessions with and without context are not randomized";

export interface OutcomeCounts {
  success: number;
  failure: number;
  partial: number;
}

export interface ValueSegmentStat {
  segment: "injected" | "not-injected";
  /** Number of attributed tasks (distinct (taskId, incarnationId)) in the segment. */
  taskCount: number;
  /** Agent-surfaced outcomes by status (verified). */
  outcomesAgent: OutcomeCounts;
  /** Inferred outcomes by status — reported separately, never counted as success. */
  outcomesInferred: OutcomeCounts;
  /** Number of attributed tasks with at least one recorded outcome. */
  tasksWithOutcome: number;
  /** Total tool executions in the segment. */
  toolExecutions: number;
  /** Sum of `supracortex.retry.count` across tool executions in the segment. */
  totalRetryCount: number;
  latencyMedianMs: number | null;
  latencyP90Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  reportedCost: number;
  /** Measured billed-in = inputExclCache + cacheRead + cacheWrite (disjoint). */
  billedInputTokens: number;
  /** Measured cache-read tokens (native usage fields only, never modeled). */
  cacheReadTokens: number;
  /** Measured cache-write/creation tokens (native usage fields only). */
  cacheWriteTokens: number;
  /**
   * Labeled-estimate tool traffic for the segment. Never billed, never a
   * savings basis.
   */
  estimatedTokens: number;
  /** Counted compaction tool executions (measured count, not tokens saved). */
  compactions: number;
  /** Tool executions attributed to main vs subagent traffic. */
  mainToolExecutions: number;
  subToolExecutions: number;
  /** Tool executions with no known agent role (never guessed). */
  unattributedRoleExecutions: number;
}

export interface ValueReport {
  enabled: boolean;
  /** Aggregation is over the bounded tail of the value-events file. */
  boundedTail: boolean;
  /** Legacy rows lacking `incarnationId`. Never merged into a keyed group. */
  unattributed: {
    rows: number;
    distinctTaskIds: number;
  };
  /** Attributed tasks with no known injected flag (excluded from comparison). */
  unclassifiedTasks: number;
  segments: Record<"injected" | "notInjected", ValueSegmentStat | null>;
  /** Attributed task counts per segment (the comparison sample). */
  sample: { injected: number; notInjected: number };
  comparisonRendered: boolean;
  /** When refused, a human-readable reason (contains "not enough data"). */
  refusalReason: string | null;
  /** The literal correlation label, present whenever a comparison is rendered. */
  correlationLabel: string;
}

const emptyOutcomeCounts = (): OutcomeCounts => ({ success: 0, failure: 0, partial: 0 });

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? null;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  return a === undefined || b === undefined ? null : (a + b) / 2;
}

interface TaskAccumulator {
  injected: boolean | null;
  outcomesAgent: OutcomeCounts;
  outcomesInferred: OutcomeCounts;
  hasOutcome: boolean;
  latencies: number[];
  retryCount: number;
  toolExecutions: number;
  inputTokens: number;
  outputTokens: number;
  reportedCost: number;
  billedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedTokens: number;
  compactions: number;
  mainToolExecutions: number;
  subToolExecutions: number;
  unattributedRoleExecutions: number;
}

function newTaskAccumulator(): TaskAccumulator {
  return {
    injected: null,
    outcomesAgent: emptyOutcomeCounts(),
    outcomesInferred: emptyOutcomeCounts(),
    hasOutcome: false,
    latencies: [],
    retryCount: 0,
    toolExecutions: 0,
    inputTokens: 0,
    outputTokens: 0,
    reportedCost: 0,
    billedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedTokens: 0,
    compactions: 0,
    mainToolExecutions: 0,
    subToolExecutions: 0,
    unattributedRoleExecutions: 0,
  };
}

function keyOf(taskId: string | undefined, incarnationId: string | undefined): string | null {
  if (taskId === undefined || incarnationId === undefined) return null;
  return `${taskId}\u0000${incarnationId}`;
}

function addOutcome(counts: OutcomeCounts, status: OutcomeStatus): void {
  if (status === "success") counts.success += 1;
  else if (status === "failure") counts.failure += 1;
  else counts.partial += 1;
}

export function buildValueReport(
  events: ValueEvent[],
  usageByKey: Map<string, ProviderUsageEvent>,
): ValueReport {
  const tasks = new Map<string, TaskAccumulator>();
  let unattributedRows = 0;
  const unattributedTaskIds = new Set<string>();

  for (const event of events) {
    const key = keyOf(event.taskId, event.incarnationId);
    if (key === null) {
      unattributedRows += 1;
      if (event.taskId !== undefined) unattributedTaskIds.add(event.taskId);
      continue;
    }
    let acc = tasks.get(key);
    if (!acc) {
      acc = newTaskAccumulator();
      tasks.set(key, acc);
    }

    switch (event.eventType) {
      case "context_injection": {
        // Most recent injection row wins for the task's segment flag.
        acc.injected = event.supracortex["supracortex.context.injected"];
        break;
      }
      case "tool_execution": {
        acc.toolExecutions += 1;
        acc.retryCount += event.supracortex["supracortex.retry.count"] ?? 0;
        const latency = event.supracortex["supracortex.latency_ms"];
        if (Number.isFinite(latency) && latency >= 0) acc.latencies.push(latency);
        const estimated = event.supracortex["supracortex.tokens.estimated"];
        if (typeof estimated === "number" && Number.isFinite(estimated) && estimated > 0) {
          acc.estimatedTokens += Math.floor(estimated);
        }
        const role = event.supracortex["supracortex.agent.role"];
        if (role === "main") acc.mainToolExecutions += 1;
        else if (role === "subagent") acc.subToolExecutions += 1;
        else acc.unattributedRoleExecutions += 1;
        const op = event.genAi?.["gen_ai.operation.name"] ?? "";
        if (op.toLowerCase().includes("compact")) acc.compactions += 1;
        break;
      }
      case "provider_usage_link": {
        const usage = usageByKey.get(event.eventKey);
        if (usage) {
          acc.inputTokens += usage.delta.inputTokens;
          acc.outputTokens += usage.delta.outputTokens;
          acc.reportedCost += usage.delta.reportedCost;
          const read = usage.delta.cacheReadTokens;
          const write = usage.delta.cacheWriteTokens;
          acc.cacheReadTokens += read;
          acc.cacheWriteTokens += write;
          // billed-in = inputExclCache + cacheRead + cacheWrite (disjoint,
          // measured only). Ledger input is inclusive of reads per provider
          // convention, so subtract to keep fields disjoint.
          acc.billedInputTokens +=
            Math.max(0, usage.delta.inputTokens - read) + read + write;
        }
        break;
      }
      case "task_outcome": {
        acc.hasOutcome = true;
        const status = event.supracortex["supracortex.task.status"];
        if (event.source === "inferred") addOutcome(acc.outcomesInferred, status);
        else addOutcome(acc.outcomesAgent, status);
        break;
      }
    }
  }

  const segments: Record<"injected" | "notInjected", TaskAccumulator[]> = {
    injected: [],
    notInjected: [],
  };
  let unclassifiedTasks = 0;

  for (const acc of tasks.values()) {
    if (acc.injected === true) segments.injected.push(acc);
    else if (acc.injected === false) segments.notInjected.push(acc);
    else unclassifiedTasks += 1;
  }

  const toStat = (list: TaskAccumulator[], segment: "injected" | "not-injected"): ValueSegmentStat => {
    const latencies = list.flatMap((acc) => acc.latencies).sort((a, b) => a - b);
    const totals: TaskAccumulator = newTaskAccumulator();
    for (const acc of list) {
      totals.outcomesAgent.success += acc.outcomesAgent.success;
      totals.outcomesAgent.failure += acc.outcomesAgent.failure;
      totals.outcomesAgent.partial += acc.outcomesAgent.partial;
      totals.outcomesInferred.success += acc.outcomesInferred.success;
      totals.outcomesInferred.failure += acc.outcomesInferred.failure;
      totals.outcomesInferred.partial += acc.outcomesInferred.partial;
      totals.hasOutcome = totals.hasOutcome || acc.hasOutcome;
      totals.retryCount += acc.retryCount;
      totals.toolExecutions += acc.toolExecutions;
      totals.inputTokens += acc.inputTokens;
      totals.outputTokens += acc.outputTokens;
      totals.reportedCost += acc.reportedCost;
      totals.billedInputTokens += acc.billedInputTokens;
      totals.cacheReadTokens += acc.cacheReadTokens;
      totals.cacheWriteTokens += acc.cacheWriteTokens;
      totals.estimatedTokens += acc.estimatedTokens;
      totals.compactions += acc.compactions;
      totals.mainToolExecutions += acc.mainToolExecutions;
      totals.subToolExecutions += acc.subToolExecutions;
      totals.unattributedRoleExecutions += acc.unattributedRoleExecutions;
    }
    return {
      segment,
      taskCount: list.length,
      outcomesAgent: totals.outcomesAgent,
      outcomesInferred: totals.outcomesInferred,
      tasksWithOutcome: list.filter((acc) => acc.hasOutcome).length,
      toolExecutions: totals.toolExecutions,
      totalRetryCount: totals.retryCount,
      latencyMedianMs: median(latencies),
      latencyP90Ms: percentile(latencies, 90),
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reportedCost: totals.reportedCost,
      billedInputTokens: totals.billedInputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      estimatedTokens: totals.estimatedTokens,
      compactions: totals.compactions,
      mainToolExecutions: totals.mainToolExecutions,
      subToolExecutions: totals.subToolExecutions,
      unattributedRoleExecutions: totals.unattributedRoleExecutions,
    };
  };

  const injectedStat = segments.injected.length > 0 ? toStat(segments.injected, "injected") : null;
  const notInjectedStat = segments.notInjected.length > 0 ? toStat(segments.notInjected, "not-injected") : null;

  const injectedCount = segments.injected.length;
  const notInjectedCount = segments.notInjected.length;
  const comparisonRendered =
    injectedCount >= MIN_SEGMENT_SAMPLE && notInjectedCount >= MIN_SEGMENT_SAMPLE;

  return {
    enabled: true,
    boundedTail: true,
    unattributed: {
      rows: unattributedRows,
      distinctTaskIds: unattributedTaskIds.size,
    },
    unclassifiedTasks,
    segments: { injected: injectedStat, notInjected: notInjectedStat },
    sample: { injected: injectedCount, notInjected: notInjectedCount },
    comparisonRendered,
    refusalReason: comparisonRendered
      ? null
      : `not enough data (injected: ${injectedCount} tasks, not injected: ${notInjectedCount} tasks; minimum ${MIN_SEGMENT_SAMPLE} per segment)`,
    correlationLabel: VALUE_CORRELATION_LABEL,
  };
}

/**
 * One billed-vs-estimated output line per segment (Wave 2, item 9a).
 * Billed figures are measured ledger deltas; the estimate is labeled and is
 * never used as a savings basis.
 */
export function formatValueTokenLine(stat: ValueSegmentStat): string {
  const inputExcl = Math.max(0, stat.inputTokens - stat.cacheReadTokens);
  return (
    `billed-in (measured): ${stat.billedInputTokens} = input ${inputExcl}` +
    ` + cache reads ${stat.cacheReadTokens} + cache writes ${stat.cacheWriteTokens}` +
    ` | estimated tool traffic (labeled estimate, not billing): ${stat.estimatedTokens}` +
    ` | main ${stat.mainToolExecutions} / subagent ${stat.subToolExecutions}` +
    ` / unattributed-role ${stat.unattributedRoleExecutions} executions` +
    ` | compactions observed (counted): ${stat.compactions}`
  );
}