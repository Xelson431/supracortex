/**
 * Validation for Jev typed answers and usage. Pure functions — no HTTP here.
 *
 * Rules:
 * - Unknown candidate IDs in a Choice answer are rejected (caller keeps the
 *   deterministic result; the answer is treated as invalid for that question).
 * - Confidence is a routing signal only; low confidence -> uncertain fallback.
 * - Usage is validated with plain guards (no new schema framework needed).
 */

import type {
  JevAnswer,
  JevCandidateScore,
  JevChoiceAnswer,
  JevDecisionsResponse,
  JevDecisionsUsage,
  JevDepthBucket,
  JevMemoryKind,
  JevMemoryVerdict,
  JevNoulAnswer,
  JevQuestion,
  JevScoreAnswer,
} from "./types.ts";
import { JEV_DEPTH_BUCKETS, JEV_MEMORY_KINDS, JEV_MEMORY_VERDICTS } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Validate a raw JSON value as a Decisions API response. Null on any shape violation. */
export function validateDecisionsResponse(raw: unknown): JevDecisionsResponse | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.model !== "string" || !raw.model) return null;
  if (!isRecord(raw.answers)) return null;
  const usage = validateUsage(raw.usage);
  if (!usage) return null;
  const answers: Record<string, JevAnswer> = {};
  for (const [key, value] of Object.entries(raw.answers)) {
    const answer = validateAnswer(value);
    if (!answer) return null;
    answers[key] = answer;
  }
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    model: raw.model,
    ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
    answers,
    usage,
  };
}

export function validateUsage(raw: unknown): JevDecisionsUsage | null {
  if (!isRecord(raw)) return null;
  const input = toFiniteNumber(raw.input_tokens);
  const output = toFiniteNumber(raw.output_tokens);
  if (input === null || output === null || input < 0 || output < 0) return null;
  const costRaw: number | null | undefined =
    raw.cost === undefined ? undefined : toFiniteNumber(raw.cost);
  if (raw.cost !== undefined && (costRaw === null || costRaw === undefined || costRaw < 0))
    return null;
  const cost: number | undefined = costRaw === null ? undefined : costRaw;
  return {
    input_tokens: Math.floor(input),
    output_tokens: Math.floor(output),
    ...(cost !== undefined ? { cost } : {}),
  };
}

export function validateAnswer(raw: unknown): JevAnswer | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "noul": {
      const noul = toFiniteNumber(raw.noul);
      if (noul === null) return null;
      const answer: JevNoulAnswer = { type: "noul", noul: clamp01(noul) };
      return answer;
    }
    case "choice": {
      if (typeof raw.choice !== "string" || !raw.choice) return null;
      const out: JevChoiceAnswer = { type: "choice", choice: raw.choice };
      if (raw.confidence !== undefined) {
        const c = toFiniteNumber(raw.confidence);
        if (c === null) return null;
        out.confidence = clamp01(c);
      }
      if (raw.probabilities !== undefined) {
        const probs = validateProbabilities(raw.probabilities);
        if (!probs) return null;
        out.probabilities = probs;
      }
      return out;
    }
    case "score": {
      const score = toFiniteNumber(raw.score);
      if (score === null) return null;
      const out: JevScoreAnswer = { type: "score", score };
      if (raw.confidence !== undefined) {
        const c = toFiniteNumber(raw.confidence);
        if (c === null) return null;
        out.confidence = clamp01(c);
      }
      if (raw.probabilities !== undefined) {
        const probs = validateProbabilities(raw.probabilities);
        if (!probs) return null;
        out.probabilities = probs;
      }
      return out;
    }
    default:
      return null;
  }
}

function validateProbabilities(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const n = toFiniteNumber(value);
    if (n === null || n < 0 || n > 1) return null;
    out[key] = n;
  }
  return out;
}

/** Validate that a request body only contains well-formed questions. */
export function validateQuestions(questions: Record<string, JevQuestion>): boolean {
  for (const question of Object.values(questions)) {
    if (!isRecord(question) || typeof question.type !== "string") return false;
    if (typeof question.instructions !== "string" || !question.instructions) return false;
    if (question.type === "choice") {
      if (!isRecord(question.criteria)) return false;
      const keys = Object.keys(question.criteria);
      if (keys.length < 1) return false;
      for (const description of Object.values(question.criteria)) {
        if (typeof description !== "string" || !description) return false;
      }
    } else if (question.type === "noul") {
      if (!isRecord(question.criteria)) return false;
      if (typeof question.criteria.true !== "string" || !question.criteria.true) return false;
      if (typeof question.criteria.false !== "string" || !question.criteria.false) return false;
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 1) return false;
      for (const level of question.criteria) {
        if (typeof level !== "string" || !level) return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Typed answer readers (callers resolve IDs in code; unknown IDs rejected)
// ---------------------------------------------------------------------------

/** Read a Choice answer restricted to `allowed` option IDs. Null when unknown/invalid. */
export function readChoice(
  answer: JevAnswer | undefined,
  allowed: ReadonlySet<string> | readonly string[],
): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  if (!answer || answer.type !== "choice") return null;
  const set: Set<string> = Array.isArray(allowed) ? new Set(allowed) : new Set(allowed);
  if (!set.has(answer.choice)) return null;
  const probabilities: Record<string, number> = {};
  if (answer.probabilities) {
    for (const [key, value] of Object.entries(answer.probabilities)) {
      if (set.has(key)) probabilities[key] = value;
    }
  }
  return { choice: answer.choice, confidence: answer.confidence ?? 0.5, probabilities };
}

/** Read a Noul answer as p(yes). Null when missing/invalid. */
export function readNoul(answer: JevAnswer | undefined): { yes: number } | null {
  if (!answer || answer.type !== "noul") return null;
  return { yes: answer.noul };
}

/** Read a Score answer clamped to [0, levels-1]. Null when missing/invalid. */
export function readScore(
  answer: JevAnswer | undefined,
  levels: number,
): { score: number; confidence: number } | null {
  if (!answer || answer.type !== "score") return null;
  if (!Number.isFinite(levels) || levels < 1) return null;
  const clamped = Math.min(Math.max(answer.score, 0), levels - 1);
  return { score: clamped, confidence: answer.confidence ?? 0.5 };
}

/**
 * Convert a Score answer over ordered candidate IDs into per-candidate
 * relevance in [0,1]. The score is a probability-weighted position on the
 * ordered scale, so relevance decays with distance from the score position.
 * Returns null entries when uncertain (caller falls back deterministically).
 */
export function scoreToCandidateRelevance(
  answer: JevAnswer | undefined,
  orderedIds: readonly string[],
  minConfidence = 0.5,
): JevCandidateScore[] | null {
  if (!orderedIds.length) return [];
  const read = readScore(answer, orderedIds.length);
  if (!read) return null;
  if (read.confidence < minConfidence) return null;
  return orderedIds.map((id, index) => {
    const distance = Math.abs(index - read.score) / Math.max(1, orderedIds.length - 1);
    return { id, score: clamp01(1 - distance), confidence: read.confidence };
  });
}

/** Read a depth-bucket Choice answer. Null when unknown bucket. */
export function readDepthBucket(
  answer: JevAnswer | undefined,
): { depth: JevDepthBucket; confidence: number } | null {
  const read = readChoice(answer, JEV_DEPTH_BUCKETS);
  if (!read) return null;
  return { depth: read.choice as JevDepthBucket, confidence: read.confidence };
}

/** Read a memory-verdict Choice answer. Null when unknown verdict. */
export function readMemoryVerdict(
  answer: JevAnswer | undefined,
): { verdict: JevMemoryVerdict; confidence: number } | null {
  const read = readChoice(answer, JEV_MEMORY_VERDICTS);
  if (!read) return null;
  return { verdict: read.choice as JevMemoryVerdict, confidence: read.confidence };
}

/** Read a memory-kind Choice answer. Null when unknown kind. */
export function readMemoryKind(
  answer: JevAnswer | undefined,
): { kind: JevMemoryKind; confidence: number } | null {
  const read = readChoice(answer, JEV_MEMORY_KINDS);
  if (!read) return null;
  return { kind: read.choice as JevMemoryKind, confidence: read.confidence };
}
