/**
 * TypeSafe Jev integration types (preview branch only).
 *
 * Jev is a System One *decision* model, not a generative model: the caller
 * sends `state` + typed `questions` (Choice / Noul / Score) and receives
 * typed answers with probabilities. Jev never writes code, summaries,
 * memories, paths, or numbers — it only selects among caller-supplied
 * candidates. Code resolves the selected IDs and executes.
 *
 * Contract (verified against OpenRouter docs 2026-09):
 *   POST https://openrouter.ai/api/v1/systemone
 *   Authorization: Bearer $OPENROUTER_API_KEY
 *   body: { model: "typesafe/jev-1.13", state, questions }
 *   questions: { [key]: { type: "choice"|"noul"|"score", instructions, criteria } }
 *   - choice criteria: { [optionId]: description }
 *   - noul criteria:   { true: description, false: description }
 *   - score criteria:  [ordered level descriptions...]
 * Response: { id, model, provider, answers: { [key]: answer }, usage }
 *   - choice answer: { type:"choice", choice, confidence?, probabilities? }
 *   - noul answer:   { type:"noul", noul }            // p(yes) in [0,1]
 *   - score answer:  { type:"score", score, confidence?, probabilities?, legend? }
 *
 * Also accepted (compat): POST https://openrouter.ai/api/alpha/decisions
 * (older endpoint from the Jev tutorial). The System One endpoint is
 * preferred; `/chat/completions` is never used for Jev.
 */

export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_SYSTEMONE_URL = "https://openrouter.ai/api/v1/systemone";
/** Legacy endpoint kept as manual fallback reference only; code uses SYSTEMONE. */
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** Depth bucket for context enrichment: closed alternatives, always. */
export type JevDepthBucket = "none" | "shallow" | "standard" | "deep";

export const JEV_DEPTH_BUCKETS: readonly JevDepthBucket[] = ["none", "shallow", "standard", "deep"];

/** Memory verdict for an agent-supplied learning. */
export type JevMemoryVerdict = "retain" | "discard" | "needs-evidence";

export const JEV_MEMORY_VERDICTS: readonly JevMemoryVerdict[] = [
  "retain",
  "discard",
  "needs-evidence",
];

/** Memory kind classification for a retained learning. */
export type JevMemoryKind =
  | "fact"
  | "decision"
  | "convention"
  | "failure"
  | "constraint"
  | "task-outcome"
  | "unknown";

export const JEV_MEMORY_KINDS: readonly JevMemoryKind[] = [
  "fact",
  "decision",
  "convention",
  "failure",
  "constraint",
  "task-outcome",
  "unknown",
];

// ---------------------------------------------------------------------------
// Decisions-API wire shapes (request + response)
// ---------------------------------------------------------------------------

export type JevQuestionType = "choice" | "noul" | "score";

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  /** optionId -> human description. Must include none/unknown alternatives where required. */
  criteria: Record<string, string>;
}

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered scale, index 0 = lowest. */
  criteria: string[];
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export interface JevDecisionsRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevNoulAnswer {
  type: "noul";
  /** Probability the answer is yes, in [0,1]. */
  noul: number;
}

export interface JevScoreAnswer {
  type: "score";
  /** Probability-weighted position on the ordered scale. */
  score: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevDecisionsUsage {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
}

export interface JevDecisionsResponse {
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, JevAnswer>;
  usage: JevDecisionsUsage;
}

// ---------------------------------------------------------------------------
// Internal decision results (validated, ID-resolved by callers)
// ---------------------------------------------------------------------------

/** Validated per-candidate relevance for ordered reranking. Higher = more relevant. */
export interface JevCandidateScore {
  /** Caller-supplied candidate id (memory id, file path, summary path...). */
  id: string;
  /** Score in [0,1] derived from Jev probabilities, or null when uncertain. */
  score: number | null;
  confidence: number;
}

export interface JevRoutingDecision {
  /** Whether optional memory/timeline/graph enrichment is worthwhile. */
  enrich: boolean;
  enrichConfidence: number;
  /** Context-depth bucket selection. */
  depth: JevDepthBucket;
  depthConfidence: number;
  /** Whether the decision came from Jev (false = deterministic fallback/uncertain). */
  fromJev: boolean;
}

export interface JevSkillMcpDecision {
  /** Selected skill names (subset of supplied candidates, resolved in code). */
  skills: string[];
  /** Selected MCP tool ids (subset of supplied candidates, resolved in code). */
  mcpTools: string[];
  /** Excluded MCP server names (subset of supplied candidates). */
  excludedMcpServers: string[];
  fromJev: boolean;
}

export interface JevGraphDecision {
  /** Selected entry-point node ids (subset of supplied candidates). */
  entryPoints: string[];
  /** Selected navigation operations (subset of supplied candidates). */
  operations: string[];
  fromJev: boolean;
}

export interface JevMemoryJudgment {
  verdict: JevMemoryVerdict;
  kind: JevMemoryKind;
  /** True when Jev flags a possible duplicate of an existing entry. */
  possibleDuplicate: boolean;
  /** True when Jev flags a possible contradiction with an existing entry. */
  possibleContradiction: boolean;
  confidence: number;
  fromJev: boolean;
}

export interface JevReviewDecision {
  /** Whether the supplied task evidence warrants review/handoff recommendation. */
  recommendReview: boolean;
  confidence: number;
  fromJev: boolean;
}

export type JevFailureReason =
  | "disabled"
  | "missing-key"
  | "timeout"
  | "http-error"
  | "invalid-response"
  | "uncertain"
  | "cooldown";
