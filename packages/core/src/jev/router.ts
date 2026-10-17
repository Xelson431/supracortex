/**
 * Jev decision orchestration for context preparation. Preview branch only.
 *
 * Design:
 * - Jev operates BEFORE final truncation: it reorders/keeps shortlisted
 *   candidates; the existing budget selector still enforces all token limits.
 * - Deterministic retrieval always runs first (existing ranking untouched).
 *   Jev may only narrow/reorder within the shortlisted candidate set — it can
 *   never invent candidates, and unknown IDs are dropped.
 * - Jev scores are NEVER averaged with raw lexical/RRF scores: when Jev
 *   answers confidently, its order wins; otherwise the deterministic order
 *   stands. No score mixing.
 * - Explicit memory writes are never vetoed: `recordMemory` keeps its
 *   existing controls; the memory judgment here is advisory for agent
 *   learnings only.
 */

import type { MemorySelection } from "../types.ts";
import type { JevClient } from "./client.ts";
import {
  JEV_GRAPH_OPERATIONS,
  graphQuestions,
  memoryJudgmentQuestions,
  rerankQuestions,
  reviewQuestions,
  routingQuestions,
  skillMcpQuestions,
} from "./questions.ts";
import type {
  JevGraphDecision,
  JevMemoryJudgment,
  JevReviewDecision,
  JevRoutingDecision,
  JevSkillMcpDecision,
} from "./types.ts";
import { readChoice, readNoul, readScore, scoreToCandidateRelevance } from "./validate.ts";

export const JEV_MIN_CONFIDENCE = 0.6;
const MAX_SHORTLIST = 12;

export interface ShortlistInput {
  query: string;
  tags: string[];
  taskKey: string;
  evidenceKey: string;
  configKey: string;
  /**
   * Remaining P06 enrichment budget in ms. Threaded into decide() as the
   * per-call timeout; 0/negative means the caller already exhausted it.
   */
  timeoutMs?: number;
}

function stateFor(
  input: ShortlistInput,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    query: input.query.slice(0, 2000),
    tags: input.tags.slice(0, 20),
    ...extra,
  };
}

/** Deterministic fallback routing (Jev off/failed/uncertain). */
export function fallbackRouting(): JevRoutingDecision {
  return {
    enrich: false,
    enrichConfidence: 0,
    depth: "standard",
    depthConfidence: 0,
    fromJev: false,
  };
}

/** 1. Route optional memory/timeline/graph enrichment + depth bucket. */
export async function jevRoute(
  client: JevClient,
  input: ShortlistInput,
): Promise<JevRoutingDecision> {
  const result = await client.decide({
    state: stateFor(input),
    questions: routingQuestions(),
    taskKey: input.taskKey,
    policyKey: "route",
    configKey: input.configKey,
    evidenceKey: input.evidenceKey,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!result.ok) return fallbackRouting();
  const enrich = readNoul(result.response.answers.enrich);
  const depth = readChoice(result.response.answers.depth, ["none", "shallow", "standard", "deep"]);
  if (!enrich || !depth) return fallbackRouting();
  if (depth.confidence < JEV_MIN_CONFIDENCE) return fallbackRouting();
  return {
    enrich: enrich.yes >= 0.5 && depth.choice !== "none",
    enrichConfidence: enrich.yes,
    depth: (depth.choice === "none" ? "none" : depth.choice) as JevRoutingDecision["depth"],
    depthConfidence: depth.confidence,
    fromJev: true,
  };
}

/** 2. Select skills + MCP capabilities from real installed candidates. */
export async function jevSelectSkillsMcp(
  client: JevClient,
  input: ShortlistInput & {
    skills: ReadonlyArray<{ name: string; description: string }>;
    mcpTools: ReadonlyArray<{ id: string; description: string }>;
    mcpServers: ReadonlyArray<{ name: string; description: string }>;
  },
): Promise<JevSkillMcpDecision> {
  const fallback: JevSkillMcpDecision = {
    skills: [],
    mcpTools: [],
    excludedMcpServers: [],
    fromJev: false,
  };
  const questions = skillMcpQuestions(input);
  if (!Object.keys(questions).length) return fallback;
  const result = await client.decide({
    state: stateFor(input, {
      skills: input.skills.slice(0, 12).map((s) => s.name),
      mcp_tools: input.mcpTools.slice(0, 12).map((t) => t.id),
      mcp_servers: input.mcpServers.slice(0, 12).map((s) => s.name),
    }),
    questions,
    taskKey: input.taskKey,
    policyKey: "skill-mcp",
    configKey: input.configKey,
    evidenceKey: input.evidenceKey,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!result.ok) return fallback;
  const out: JevSkillMcpDecision = {
    skills: [],
    mcpTools: [],
    excludedMcpServers: [],
    fromJev: true,
  };
  const skillNames = new Set(input.skills.map((s) => s.name));
  const toolIds = new Set(input.mcpTools.map((t) => t.id));
  const serverNames = new Set(input.mcpServers.map((s) => s.name));
  const skill = readChoice(result.response.answers.skill, skillNames);
  if (skill && skill.choice !== "none" && skill.confidence >= JEV_MIN_CONFIDENCE)
    out.skills = [skill.choice];
  const tool = readChoice(result.response.answers.mcp_tool, toolIds);
  if (tool && tool.choice !== "none" && tool.confidence >= JEV_MIN_CONFIDENCE)
    out.mcpTools = [tool.choice];
  const server = readChoice(result.response.answers.mcp_server, serverNames);
  if (server && server.choice !== "none" && server.confidence >= JEV_MIN_CONFIDENCE) {
    out.excludedMcpServers = [server.choice];
  }
  if (!out.skills.length && !out.mcpTools.length && !out.excludedMcpServers.length) {
    return fallback;
  }
  return out;
}

/**
 * 3. Rerank shortlisted memories within the deterministic shortlist order.
 * Returns the reranked selection (subset, Jev order) or null to keep the
 * deterministic order. Score semantics: the Score answer positions the whole
 * shortlist on a relevance scale; per-candidate relevance decays with
 * distance. Candidates below 0.5 relevance are dropped (never added).
 */
export async function jevRerankMemories(
  client: JevClient,
  input: ShortlistInput & { shortlisted: MemorySelection[] },
): Promise<MemorySelection[] | null> {
  const shortlisted = input.shortlisted.slice(0, MAX_SHORTLIST);
  if (shortlisted.length < 2) return null;
  const result = await client.decide({
    state: stateFor(input, {
      candidates: shortlisted.map((s, index) => ({
        position: index,
        id: s.entry.id,
        kind: s.entry.kind,
        text: s.entry.content.slice(0, 300),
      })),
    }),
    questions: rerankQuestions([
      { key: "memory", label: "memory entries", count: shortlisted.length },
    ]),
    taskKey: input.taskKey,
    policyKey: "rerank-memory",
    configKey: input.configKey,
    evidenceKey: input.evidenceKey,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!result.ok) return null;
  const relevance = scoreToCandidateRelevance(
    result.response.answers.rerank_memory,
    shortlisted.map((s) => s.entry.id),
    JEV_MIN_CONFIDENCE,
  );
  if (!relevance) return null;
  const byId = new Map(shortlisted.map((s) => [s.entry.id, s]));
  const reranked: MemorySelection[] = [];
  const ordered = [...relevance].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  for (const { id, score } of ordered) {
    if (score === null || score < 0.5) continue;
    const selection = byId.get(id);
    if (selection) reranked.push(selection);
  }
  if (!reranked.length) return null;
  return reranked;
}

/**
 * Rerank shortlisted file paths (caller-resolved). Returns the reranked path
 * order (subset) or null to keep the deterministic order.
 */
export async function jevRerankPaths(
  client: JevClient,
  input: ShortlistInput & { kind: "files" | "summaries"; shortlisted: string[] },
): Promise<string[] | null> {
  const shortlisted = input.shortlisted.slice(0, MAX_SHORTLIST);
  if (shortlisted.length < 2) return null;
  const key = `rerank_${input.kind}`;
  const result = await client.decide({
    state: stateFor(input, {
      candidates: shortlisted.map((path, position) => ({ position, path: path.slice(0, 300) })),
    }),
    questions: rerankQuestions([{ key: input.kind, label: input.kind, count: shortlisted.length }]),
    taskKey: input.taskKey,
    policyKey: `rerank-${input.kind}`,
    configKey: input.configKey,
    evidenceKey: input.evidenceKey,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!result.ok) return null;
  const relevance = scoreToCandidateRelevance(
    result.response.answers[key],
    shortlisted,
    JEV_MIN_CONFIDENCE,
  );
  if (!relevance) return null;
  return [...relevance]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .filter((r) => r.score !== null && r.score >= 0.5)
    .map((r) => r.id);
}

/** 4. Select graph entry points + navigation operations from real candidates. */
export async function jevSelectGraph(
  client: JevClient,
  input: ShortlistInput & {
    entryPoints: ReadonlyArray<{ id: string; description: string }>;
    graphAvailable: boolean;
  },
): Promise<JevGraphDecision> {
  const fallback: JevGraphDecision = { entryPoints: [], operations: [], fromJev: false };
  if (!input.graphAvailable || !input.entryPoints.length) return fallback;
  const result = await client.decide({
    state: stateFor(input, {
      entry_points: input.entryPoints
        .slice(0, 12)
        .map((e) => ({ id: e.id, description: e.description.slice(0, 200) })),
    }),
    questions: graphQuestions({ entryPoints: input.entryPoints }),
    taskKey: input.taskKey,
    policyKey: "graph",
    configKey: input.configKey,
    evidenceKey: input.evidenceKey,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!result.ok) return fallback;
  const ids = new Set(input.entryPoints.map((e) => e.id));
  const entry = readChoice(result.response.answers.graph_entry, ids);
  const operation = readChoice(result.response.answers.graph_operation, [
    ...JEV_GRAPH_OPERATIONS,
    "none",
  ]);
  const out: JevGraphDecision = { entryPoints: [], operations: [], fromJev: true };
  if (entry && entry.choice !== "none" && entry.confidence >= JEV_MIN_CONFIDENCE)
    out.entryPoints = [entry.choice];
  if (operation && operation.choice !== "none" && operation.confidence >= JEV_MIN_CONFIDENCE) {
    out.operations = [operation.choice];
  }
  if (!out.entryPoints.length || !out.operations.length) return fallback;
  return out;
}

/** 5. Judge whether an agent-supplied learning is worth retaining. Advisory only. */
export async function jevJudgeMemory(
  client: JevClient,
  input: ShortlistInput & {
    content: string;
    relatedFiles: string[];
    existingSummaries: ReadonlyArray<{ id: string; kind: string; text: string }>;
  },
): Promise<JevMemoryJudgment> {
  const fallback: JevMemoryJudgment = {
    verdict: "retain",
    kind: "unknown",
    possibleDuplicate: false,
    possibleContradiction: false,
    confidence: 0,
    fromJev: false,
  };
  const result = await client.decide({
    state: stateFor(input, {
      learning: input.content.slice(0, 2000),
      related_files: input.relatedFiles.slice(0, 20),
      existing: input.existingSummaries
        .slice(0, 8)
        .map((e) => ({ id: e.id, kind: e.kind, text: e.text.slice(0, 300) })),
    }),
    questions: memoryJudgmentQuestions(),
    taskKey: input.taskKey,
    policyKey: "memory-judge",
    configKey: input.configKey,
    evidenceKey: input.evidenceKey,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!result.ok) return fallback;
  const verdict = readChoice(result.response.answers.retain, [
    "retain",
    "discard",
    "needs-evidence",
  ]);
  const kind = readChoice(result.response.answers.kind, [
    "fact",
    "decision",
    "convention",
    "failure",
    "constraint",
    "task-outcome",
    "unknown",
  ]);
  const duplicate = readNoul(result.response.answers.duplicate);
  const contradiction = readNoul(result.response.answers.contradiction);
  if (!verdict || !kind || !duplicate || !contradiction) return fallback;
  // Uncertain verdict -> retain path (never silently discard an explicit write;
  // the existing evidence/contradiction controls still apply downstream).
  if (verdict.confidence < JEV_MIN_CONFIDENCE) return fallback;
  return {
    verdict: verdict.choice as JevMemoryJudgment["verdict"],
    kind: kind.choice as JevMemoryJudgment["kind"],
    possibleDuplicate: duplicate.yes >= 0.5,
    possibleContradiction: contradiction.yes >= 0.5,
    confidence: verdict.confidence,
    fromJev: true,
  };
}

/** 6. Recommend review/handoff when task evidence warrants it. */
export async function jevReview(
  client: JevClient,
  input: ShortlistInput & { evidence: Record<string, unknown> },
): Promise<JevReviewDecision> {
  const fallback: JevReviewDecision = { recommendReview: false, confidence: 0, fromJev: false };
  const result = await client.decide({
    state: stateFor(input, { evidence: input.evidence }),
    questions: reviewQuestions(),
    taskKey: input.taskKey,
    policyKey: "review",
    configKey: input.configKey,
    evidenceKey: input.evidenceKey,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!result.ok) return fallback;
  const read = readNoul(result.response.answers.review);
  if (!read) return fallback;
  return {
    recommendReview: read.yes >= 0.5,
    confidence: Math.abs(read.yes - 0.5) * 2,
    fromJev: true,
  };
}

/** Read a depth Score (0..3) when a caller prefers Score over Choice buckets. */
export function scoreToDepth(score: number): "none" | "shallow" | "standard" | "deep" {
  if (score < 0.5) return "none";
  if (score < 1.5) return "shallow";
  if (score < 2.5) return "standard";
  return "deep";
}

export { readScore };
