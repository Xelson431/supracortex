/**
 * Jev question builders for SupraCortex decisions. Pure — no HTTP.
 *
 * Invariants enforced here:
 * - Jev only answers typed questions about caller-supplied state; it never
 *   writes code, summaries, memories, queries, paths, or numbers.
 * - Every Choice includes a none/unknown alternative where the spec requires
 *   it, so Jev can abstain instead of forcing a bad selection.
 * - Questions in one request never depend on each other's answers: each
 *   question carries the full candidate descriptions it needs.
 * - Candidate descriptions are bounded (counts + chars) so requests stay
 *   small and fast.
 */

import type { JevQuestion } from "./types.ts";

const MAX_CANDIDATES_PER_QUESTION = 12;
const MAX_DESCRIPTION_CHARS = 160;

function clip(text: string, max = MAX_DESCRIPTION_CHARS): string {
  const clean = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function candidateCriteria(
  candidates: ReadonlyArray<{ id: string; description: string }>,
  noneLabel: string,
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates.slice(0, MAX_CANDIDATES_PER_QUESTION)) {
    if (!candidate.id || criteria[candidate.id] !== undefined) continue;
    criteria[candidate.id] = clip(candidate.description || candidate.id);
  }
  criteria.none = noneLabel;
  return criteria;
}

// ---------------------------------------------------------------------------
// 1. Routing: optional enrichment + context-depth bucket
// ---------------------------------------------------------------------------

export function routingQuestions(): Record<string, JevQuestion> {
  return {
    enrich: {
      type: "noul",
      instructions:
        "Is optional memory, timeline, or code-graph enrichment worthwhile for this task, beyond the mandatory budgeted retrieval?",
      criteria: {
        true: "The task benefits from extra history, timeline events, or graph navigation (multi-file change, unfamiliar area, past failures).",
        false: "The task is small, isolated, or fully described; extra enrichment would add noise.",
      },
    },
    depth: {
      type: "choice",
      instructions: "Which context-depth bucket should bound optional enrichment for this task?",
      criteria: {
        none: "No optional enrichment; mandatory retrieval only.",
        shallow: "Minimal enrichment: a few extra entries within the existing budget.",
        standard: "Normal enrichment: timeline and graph hints within budget.",
        deep: "Full enrichment for a complex multi-file task, still within budget.",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Skills + MCP capabilities (installed candidates only)
// ---------------------------------------------------------------------------

export function skillMcpQuestions(input: {
  skills: ReadonlyArray<{ name: string; description: string }>;
  mcpTools: ReadonlyArray<{ id: string; description: string }>;
  mcpServers: ReadonlyArray<{ name: string; description: string }>;
}): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  if (input.skills.length) {
    questions.skill = {
      type: "choice",
      instructions:
        "Which installed skill is most applicable to the task? Candidates exclude already-loaded skills.",
      criteria: candidateCriteria(
        input.skills.map((s) => ({ id: s.name, description: s.description || s.name })),
        "No installed skill applies; proceed without skill guidance.",
      ),
    };
  }
  if (input.mcpTools.length) {
    questions.mcp_tool = {
      type: "choice",
      instructions:
        "Which available MCP tool capability is most applicable to the task? Candidates exclude unavailable servers.",
      criteria: candidateCriteria(
        input.mcpTools.map((t) => ({ id: t.id, description: t.description || t.id })),
        "No MCP tool applies; proceed without MCP guidance.",
      ),
    };
  }
  if (input.mcpServers.length) {
    questions.mcp_server = {
      type: "choice",
      instructions:
        "Which MCP server, if any, should be excluded for this task (irrelevant or risky)?",
      criteria: candidateCriteria(
        input.mcpServers.map((s) => ({ id: s.name, description: s.description || s.name })),
        "No server needs exclusion; keep all available servers.",
      ),
    };
  }
  return questions;
}

// ---------------------------------------------------------------------------
// 3. Rerank: ordered relevance over shortlisted candidates (Score)
// ---------------------------------------------------------------------------

/** Ordered scale labels for rerank Score questions. */
export function rerankScale(): string[] {
  return [
    "Not relevant to this task",
    "Tangentially relevant",
    "Directly relevant",
    "Essential for this task",
  ];
}

/**
 * Build one Score question per candidate group (memories, files, summaries).
 * `orderedIds` are caller-resolved candidate IDs in deterministic shortlist
 * order; the response score is mapped back positionally by the caller.
 */
export function rerankQuestions(
  groups: ReadonlyArray<{ key: string; label: string; count: number }>,
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const group of groups) {
    if (group.count <= 0) continue;
    questions[`rerank_${group.key}`] = {
      type: "score",
      instructions: `How relevant is the shortlisted ${group.label} set, taken in order, to the current task? Higher positions in the list were ranked higher by local retrieval.`,
      criteria: rerankScale(),
    };
  }
  return questions;
}

// ---------------------------------------------------------------------------
// 4. Graph entry points + navigation operations
// ---------------------------------------------------------------------------

export const JEV_GRAPH_OPERATIONS: readonly string[] = ["neighbors", "path", "impact", "explain"];

export function graphQuestions(input: {
  entryPoints: ReadonlyArray<{ id: string; description: string }>;
}): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  if (input.entryPoints.length) {
    questions.graph_entry = {
      type: "choice",
      instructions:
        "Which indexed code-graph node is the best entry point for navigating to the task-relevant code?",
      criteria: candidateCriteria(
        input.entryPoints.map((e) => ({ id: e.id, description: e.description || e.id })),
        "No graph entry point applies; skip graph navigation.",
      ),
    };
  }
  questions.graph_operation = {
    type: "choice",
    instructions:
      "Which graph navigation operation best serves the task from the selected entry point?",
    criteria: {
      neighbors: "List directly connected files/symbols around the entry point.",
      path: "Find a path between two task-relevant nodes.",
      impact: "Assess incoming/outgoing impact of a change at the entry point.",
      explain: "Explain a single node and its immediate relations.",
      none: "No graph navigation needed.",
    },
  };
  return questions;
}

// ---------------------------------------------------------------------------
// 5. Memory judgment: retain? kind? duplicate/contradiction flags?
// ---------------------------------------------------------------------------

export function memoryJudgmentQuestions(): Record<string, JevQuestion> {
  return {
    retain: {
      type: "choice",
      instructions: "Is the agent-supplied learning worth retaining as durable project memory?",
      criteria: {
        retain: "Durable, reusable project knowledge worth keeping.",
        "needs-evidence": "Plausible but unverified; keep only with evidence, not as fact.",
        discard: "Ephemeral, redundant, or not project knowledge; do not retain.",
      },
    },
    kind: {
      type: "choice",
      instructions: "How should a retained learning be classified?",
      criteria: {
        fact: "A stable true statement about the project or its environment.",
        decision: "A choice that was made and its rationale.",
        convention: "A recurring rule or pattern to follow.",
        failure: "Something that went wrong and should be avoided.",
        constraint: "A hard limit that must be respected.",
        "task-outcome": "A record of what a task did and its result.",
        unknown: "Does not fit a specific kind; keep generic or discard.",
      },
    },
    duplicate: {
      type: "noul",
      instructions: "Does the supplied learning duplicate an existing active memory entry?",
      criteria: {
        true: "The same knowledge already exists; linking or skipping is better than a new entry.",
        false: "No existing entry covers this learning.",
      },
    },
    contradiction: {
      type: "noul",
      instructions: "Does the supplied learning contradict an existing active memory entry?",
      criteria: {
        true: "It conflicts with stored knowledge; flag for review, never silently overwrite.",
        false: "No conflict with stored knowledge.",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Review / handoff recommendation
// ---------------------------------------------------------------------------

export function reviewQuestions(): Record<string, JevQuestion> {
  return {
    review: {
      type: "noul",
      instructions:
        "Does the supplied task evidence warrant recommending a review or handoff (unresolved risk, failure, or open follow-up)?",
      criteria: {
        true: "Evidence shows failure, contradiction, or open risk that a review/handoff should surface.",
        false: "Evidence is clean; no review or handoff needed.",
      },
    },
  };
}
