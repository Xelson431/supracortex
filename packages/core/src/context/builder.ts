/**
 * ContextPacket builder. Orchestrates memory retrieval + file selection under a
 * single token budget and produces a fully-explained packet.
 *
 * This is pure with respect to IO: all inputs (index, summaries, memory, git,
 * skills, mcp) are passed in. The engine is responsible for loading them.
 */

import { randomUUID } from "node:crypto";
import type {
  ContextPacket,
  FileSummary,
  GitChangeSummary,
  IndexedFile,
  McpExclusion,
  McpToolRecommendation,
  MemoryEntry,
  SkillExclusion,
  SkillRecommendation,
  TaskInput,
} from "../types.ts";
import { buildQueryContext } from "../memory/ranking.ts";
import { retrieveMemory } from "../memory/retrieval.ts";
import { selectFiles } from "./selector.ts";
import { TokenBudget } from "./token-budget.ts";

export interface BuilderConfig {
  maxTokens: number;
  maxRetrievedEntries: number;
  maxRetrievedTokens: number;
  maxRecommendedReads: number;
  summaryThresholdTokens: number;
  preferChangedFiles: boolean;
  /** Reserve-aware compaction trigger inputs (params + env override, see selector). */
  contextWindow?: number;
  reserveTokensForSummary?: number;
  floorBufferTokens?: number;
  modelHint?: string;
}

export interface BuilderInput {
  task: TaskInput;
  config: BuilderConfig;
  index: Record<string, IndexedFile>;
  summaries: Record<string, FileSummary>;
  memory: MemoryEntry[];
  git?: GitChangeSummary;
  cacheReport: { hits: number; misses: number; stale: number; entries: number };
  recommendedSkills?: SkillRecommendation[];
  excludedSkills?: SkillExclusion[];
  recommendedMcpTools?: McpToolRecommendation[];
  excludedMcpServers?: McpExclusion[];
  now?: number;
}

export interface BuildContextResult {
  packet: ContextPacket;
  stats: {
    memoryConsidered: number;
    memorySelected: number;
    filesConsidered: number;
    staleSummariesRejected: number;
    tokensSelected: number;
    tokensExcluded: number;
    /** Billed-fresh second-read charge (full source bodies, never free). */
    billedEstimate: number;
    /** True: billedEstimate derives from heuristic estimates, not measurement. */
    estimated: boolean;
    /** Present when used tokens reached the reserve-aware compaction threshold. */
    triggerReason?: string;
    compactionThreshold?: number;
  };
}

export function buildContextPacket(input: BuilderInput): BuildContextResult {
  const { task, config } = input;
  const now = input.now ?? Date.now();
  const taskId = task.taskId ?? randomUUID();
  const maxTokens = task.maxTokens ?? config.maxTokens;
  const budget = new TokenBudget(maxTokens);

  const changedFiles = input.git?.changedFiles ?? [];
  const ctx = buildQueryContext(task.query, task.tags ?? [], task.hintFiles ?? [], changedFiles);

  // 1. Memory first (constraints/failures are the cheapest, highest-value context).
  const memRes = retrieveMemory(input.memory, ctx, {
    maxEntries: config.maxRetrievedEntries,
    maxTokens: Math.min(config.maxRetrievedTokens, budget.remaining),
  }, now);
  // Memory charges are mandatory items: force-consume, and tag the budget
  // estimated when the retrieval estimates are heuristic (labeled, not billed).
  for (const sel of memRes.selected) budget.forceConsume(sel.estimatedTokens);
  if (memRes.selected.length > 0) budget.markEstimated();

  const constraints = memRes.selected
    .filter((m) => m.entry.kind === "constraint")
    .map((m) => m.entry.content);
  const knownFailures = memRes.selected
    .filter((m) => m.entry.kind === "failure")
    .map((m) => m.entry.content);

  // 2. Files within the remaining budget.
  const fileRes = selectFiles({
    index: input.index,
    summaries: input.summaries,
    ctx,
    budget,
    options: {
      maxRecommendedReads: config.maxRecommendedReads,
      summaryThresholdTokens: config.summaryThresholdTokens,
      preferChangedFiles: config.preferChangedFiles,
      ...(config.contextWindow != null ? { contextWindow: config.contextWindow } : {}),
      ...(config.reserveTokensForSummary != null ? { reserveTokensForSummary: config.reserveTokensForSummary } : {}),
      ...(config.floorBufferTokens != null ? { floorBufferTokens: config.floorBufferTokens } : {}),
      ...(config.modelHint != null ? { modelHint: config.modelHint } : {}),
    },
  });

  const estimatedTokens = budget.usedTokens;
  const tokensExcluded = fileRes.omissions.reduce((acc, o) => {
    const idx = input.index[o.path];
    return acc + (idx ? idx.estimatedTokens : 0);
  }, 0);

  const packet: ContextPacket = {
    taskId,
    taskSummary: task.query.slice(0, 500),
    selectedMemory: memRes.selected,
    selectedFiles: fileRes.files,
    selectedSummaries: fileRes.summaries,
    constraints,
    knownFailures,
    estimatedTokens,
    budget: budget.snapshot(),
    cacheReport: input.cacheReport,
    omissions: fileRes.omissions,
    recommendedSkills: input.recommendedSkills ?? [],
    excludedSkills: input.excludedSkills ?? [],
    recommendedMcpTools: input.recommendedMcpTools ?? [],
    excludedMcpServers: input.excludedMcpServers ?? [],
    generatedAt: new Date(now).toISOString(),
  };
  if (input.git) packet.currentGitChanges = input.git;

  return {
    packet,
    stats: {
      memoryConsidered: memRes.considered,
      memorySelected: memRes.selected.length,
      filesConsidered: fileRes.filesConsidered,
      staleSummariesRejected: fileRes.staleSummariesRejected,
      tokensSelected: estimatedTokens,
      tokensExcluded,
      billedEstimate: fileRes.billedEstimate,
      estimated: fileRes.estimated,
      ...(fileRes.triggerReason ? { triggerReason: fileRes.triggerReason } : {}),
      ...(fileRes.compactionThreshold != null ? { compactionThreshold: fileRes.compactionThreshold } : {}),
    },
  };
}
