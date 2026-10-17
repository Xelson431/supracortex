/**
 * One-request decision enrichment for a context packet.
 *
 * Replaces the earlier sequential design (graph → skills/MCP → memory rerank →
 * summary rerank, up to four HTTP calls per turn) with ONE decide() call that
 * carries every question at once. The System One protocol answers independent
 * questions in parallel inside a single request, so this costs one round trip.
 *
 * Relevance is judged PER CANDIDATE on its content, with one Noul question each
 * ("is this useful for the task?", answered as p(yes)). The previous design
 * asked for a single score for the whole shortlist and mapped it back onto
 * candidates by array position, which could only ever reproduce — or scramble —
 * the deterministic order; it never looked at what a candidate said.
 *
 * Guarantees:
 *  - never adds a candidate; only reorders and drops confident rejects
 *  - never drops below MIN_KEEP candidates per group
 *  - any failure, low-confidence or missing answer leaves that group untouched
 *  - request size is bounded by `maxInputChars` (providers such as Laya
 *    silently truncate past their input window, which corrupts answers)
 */

import type { JevClient } from "./client.ts";
import type { JevQuestion } from "./types.ts";
import { readChoice, readNoul } from "./validate.ts";

/** Candidates with p(relevant) below this are dropped (subject to MIN_KEEP). */
export const DROP_BELOW = 0.2;
/** Never shrink a group below this many candidates. */
export const MIN_KEEP = 2;
/** Minimum confidence to act on a skill/MCP choice. */
export const CHOICE_MIN_CONFIDENCE = 0.6;
const MAX_PER_GROUP = 8;
const SNIPPET_CHARS = 220;

export interface EnrichCandidate {
  id: string;
  text: string;
}

export interface EnrichInput {
  query: string;
  memory: EnrichCandidate[];
  summaries: EnrichCandidate[];
  skills: ReadonlyArray<{ name: string; description: string }>;
  mcpTools: ReadonlyArray<{ id: string; description: string }>;
  /** Hard cap on serialized request characters (question text + state). */
  maxInputChars: number;
  /** Hard cap on questions per request (provider latency is per question). */
  maxQuestions?: number;
  /** Candidate text chars per question. */
  snippetChars?: number;
  timeoutMs: number;
  keys: { taskKey: string; configKey: string; evidenceKey: string };
}

export interface GroupDecision {
  /** Candidate ids in the new order (subset of the input, never extra). */
  order: string[];
  /** p(relevant) per id for observability. */
  relevance: Record<string, number>;
  dropped: string[];
}

export interface EnrichResult {
  ok: boolean;
  reason?: string;
  memory: GroupDecision | null;
  summaries: GroupDecision | null;
  skill: string | null;
  mcpTool: string | null;
  /** Request size actually sent, for budget diagnostics. */
  inputChars: number;
  questions: number;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function relevanceQuestion(kind: string, text: string): JevQuestion {
  return {
    type: "noul",
    instructions: `Is this ${kind} useful context for the current task? ${kind}: "${text}"`,
    criteria: {
      true: "Useful or needed to do this task well.",
      false: "Not relevant to this task.",
    },
  };
}

function choiceQuestion(label: string, options: ReadonlyArray<{ id: string; description: string }>): JevQuestion | null {
  if (!options.length) return null;
  const criteria: Record<string, string> = {};
  for (const o of options.slice(0, 8)) if (o.id && !(o.id in criteria)) criteria[o.id] = clip(o.description || o.id, 140);
  criteria.none = `No ${label} applies; proceed without one.`;
  return { type: "choice", instructions: `Which ${label} is most applicable to the current task?`, criteria };
}

interface Planned {
  questions: Record<string, JevQuestion>;
  memoryIds: string[];
  summaryIds: string[];
  chars: number;
}

/**
 * Build the merged question set, adding candidates round-robin (best first in
 * each group) until the size cap is reached, so a tight budget degrades by
 * judging fewer tail candidates — never by sending a truncated request.
 */
export function planQuestions(input: Omit<EnrichInput, "timeoutMs" | "keys">): Planned {
  const questions: Record<string, JevQuestion> = {};
  const snippet = input.snippetChars ?? SNIPPET_CHARS;
  const state = { task: clip(input.query, snippet >= 200 ? 600 : 200) };
  let chars = JSON.stringify(state).length;
  const maxQuestions = input.maxQuestions ?? Number.POSITIVE_INFINITY;
  const add = (key: string, q: JevQuestion): boolean => {
    const cost = key.length + JSON.stringify(q).length + 4;
    if (chars + cost > input.maxInputChars) return false;
    if (Object.keys(questions).length >= maxQuestions) return false;
    questions[key] = q;
    chars += cost;
    return true;
  };
  const memory = input.memory.slice(0, MAX_PER_GROUP);
  const summaries = input.summaries.slice(0, MAX_PER_GROUP);
  const memoryIds: string[] = [];
  const summaryIds: string[] = [];
  const longest = Math.max(memory.length, summaries.length);
  for (let i = 0; i < longest; i++) {
    const m = memory[i];
    if (m && add(`m${i}`, relevanceQuestion("memory entry", clip(m.text, snippet)))) memoryIds.push(m.id);
    const s = summaries[i];
    if (s && add(`s${i}`, relevanceQuestion("file", clip(s.text, snippet)))) summaryIds.push(s.id);
  }
  // Skill/tool narrowing is lower value than relevance judgments, so it only
  // uses whatever question budget remains.
  const skillQ = choiceQuestion("skill", input.skills.map((s) => ({ id: s.name, description: s.description })));
  if (skillQ) add("skill", skillQ);
  const toolQ = choiceQuestion("tool capability", input.mcpTools);
  if (toolQ) add("mcp_tool", toolQ);
  return { questions, memoryIds, summaryIds, chars };
}

/**
 * Turn per-candidate p(relevant) into a new order. Candidates that were not
 * asked about (budget) keep their deterministic position after the judged ones.
 */
export function decideGroup(allIds: string[], judgedIds: string[], answers: Record<string, unknown>, prefix: string): GroupDecision | null {
  if (judgedIds.length < 2) return null;
  const relevance: Record<string, number> = {};
  judgedIds.forEach((id, i) => {
    const yes = readNoul(answers[`${prefix}${i}`] as never);
    if (yes) relevance[id] = yes.yes;
  });
  if (Object.keys(relevance).length < judgedIds.length) return null;
  const judged = [...judgedIds].sort((a, b) => relevance[b]! - relevance[a]! || judgedIds.indexOf(a) - judgedIds.indexOf(b));
  const dropped: string[] = [];
  const kept = judged.filter((id) => {
    if (relevance[id]! >= DROP_BELOW) return true;
    dropped.push(id);
    return false;
  });
  while (kept.length < Math.min(MIN_KEEP, judged.length) && dropped.length) {
    const back = dropped.shift()!;
    kept.push(back);
  }
  const unjudged = allIds.filter((id) => !judgedIds.includes(id));
  const order = [...kept, ...unjudged];
  const unchanged = order.length === allIds.length && order.every((id, i) => id === allIds[i]);
  if (unchanged) return null;
  return { order, relevance, dropped };
}

export async function enrichContext(client: JevClient, input: EnrichInput): Promise<EnrichResult> {
  const empty: EnrichResult = { ok: false, memory: null, summaries: null, skill: null, mcpTool: null, inputChars: 0, questions: 0 };
  const plan = planQuestions(input);
  const count = Object.keys(plan.questions).length;
  if (!count) return { ...empty, reason: "nothing-to-decide" };
  const result = await client.decide({
    state: { task: clip(input.query, (input.snippetChars ?? SNIPPET_CHARS) >= 200 ? 600 : 200) },
    questions: plan.questions,
    timeoutMs: input.timeoutMs,
    taskKey: input.keys.taskKey,
    policyKey: "enrich-v2",
    configKey: input.keys.configKey,
    evidenceKey: input.keys.evidenceKey,
  });
  if (!result.ok) return { ...empty, reason: result.reason, inputChars: plan.chars, questions: count };
  const answers = result.response.answers as Record<string, unknown>;
  // "none" is a legal abstention and must be accepted by the reader.
  const skillIds = new Set([...input.skills.map((s) => s.name), "none"]);
  const toolIds = new Set([...input.mcpTools.map((t) => t.id), "none"]);
  const skill = readChoice(answers.skill as never, skillIds);
  const tool = readChoice(answers.mcp_tool as never, toolIds);
  return {
    ok: true,
    memory: decideGroup(input.memory.map((m) => m.id), plan.memoryIds, answers, "m"),
    summaries: decideGroup(input.summaries.map((s) => s.id), plan.summaryIds, answers, "s"),
    skill: skill && skill.choice !== "none" && skill.confidence >= CHOICE_MIN_CONFIDENCE ? skill.choice : null,
    mcpTool: tool && tool.choice !== "none" && tool.confidence >= CHOICE_MIN_CONFIDENCE ? tool.choice : null,
    inputChars: plan.chars,
    questions: count,
  };
}
