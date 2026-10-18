/**
 * Skill metadata handling (core, pure).
 *
 * The core stores only lightweight skill metadata and computes recommendations.
 * It never persists full skill instructions. Discovery of skill files is done
 * by the adapter (filesystem/OpenCode); this module scores and recommends.
 */

import type { SkillExclusion, SkillMetadata, SkillRecommendation } from "../types.ts";

// Skill matching is token-set based: connective/filler words must never
// justify a recommendation (the old substring check made "in" match
// "notfair-gemini"). This is the same intent as file-query filtering, kept
// local so the skills module stays independent of the memory scorer.
const SKILL_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for",
  "from", "get", "gets", "how", "i", "in", "into", "is", "it", "make", "makes",
  "need", "needs", "of", "on", "or", "should", "that", "the", "this", "to",
  "use", "used", "uses", "using", "was", "were", "what", "when", "where",
  "which", "who", "why", "with", "work", "works", "would", "can", "could",
]);

// A skill must match at least one distinctive token. Structural names alone
// ("app", "src", "page") cannot make an unrelated global skill relevant.
const SKILL_GENERIC_TOKENS = new Set([
  "app", "src", "lib", "components", "component", "pages", "page", "layout",
  "routes", "route", "api", "index", "utils", "util", "hooks", "types",
  "styles", "public", "static", "server", "client",
]);

const PREFIX_MATCH_WEIGHT = 0.5;
const PREFIX_MATCH_MIN_LENGTH = 4;

function splitTokens(text: string): string[] {
  return text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function queryTokenSet(tokens: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const token of tokens) {
    for (const part of splitTokens(token)) {
      if (!SKILL_QUERY_STOPWORDS.has(part)) set.add(part);
    }
  }
  return set;
}

function matchesLeadingPrefix(a: string, b: string): boolean {
  return (
    a.length >= PREFIX_MATCH_MIN_LENGTH &&
    b.length >= PREFIX_MATCH_MIN_LENGTH &&
    a.slice(0, PREFIX_MATCH_MIN_LENGTH) === b.slice(0, PREFIX_MATCH_MIN_LENGTH)
  );
}

/** 1 for a whole-token match, 0.5 for a conservative prefix, 0 otherwise. */
function tokenMatchWeight(token: string, candidates: Set<string>): number {
  if (candidates.has(token)) return 1;
  for (const candidate of candidates) {
    if (matchesLeadingPrefix(token, candidate)) return PREFIX_MATCH_WEIGHT;
  }
  return 0;
}

export interface SkillRecommendInput {
  skills: SkillMetadata[];
  queryTokens: string[];
  /** Skill names already present in the target agent's context. */
  alreadyLoaded: string[];
  /** The agent the recommendation targets, e.g. "explorer". */
  targetAgent?: string;
  maxRecommendations?: number;
}

export interface SkillRecommendResult {
  recommended: SkillRecommendation[];
  excluded: SkillExclusion[];
  considered: number;
  duplicateLoadsAvoided: number;
}

export function recommendSkills(input: SkillRecommendInput): SkillRecommendResult {
  const max = input.maxRecommendations ?? 3;
  const loaded = new Set(input.alreadyLoaded);
  const recommended: SkillRecommendation[] = [];
  const excluded: SkillExclusion[] = [];
  let duplicateLoadsAvoided = 0;
  const query = queryTokenSet(input.queryTokens);

  const scored = input.skills
    .map((s) => ({ skill: s, ...scoreSkill(s, query, input.targetAgent) }))
    .sort((a, b) => b.score - a.score);

  for (const { skill, score, matched } of scored) {
    // Agent compatibility gate.
    if (
      input.targetAgent &&
      skill.compatibleAgents &&
      skill.compatibleAgents.length > 0 &&
      !skill.compatibleAgents.includes(input.targetAgent)
    ) {
      excluded.push({
        name: skill.name,
        reason: `not compatible with agent "${input.targetAgent}"`,
      });
      continue;
    }

    if (score < 0.2) {
      excluded.push({ name: skill.name, reason: `low relevance (score ${round2(score)})` });
      continue;
    }

    if (recommended.length >= max) {
      excluded.push({ name: skill.name, reason: "beyond max recommendations" });
      continue;
    }

    const already = loaded.has(skill.name);
    if (already) duplicateLoadsAvoided++;

    recommended.push({
      name: skill.name,
      reason: buildReason(skill, matched, score, already),
      priority: round2(score),
      intendedAgent: input.targetAgent,
      needsLoad: !already,
    });
  }

  return {
    recommended,
    excluded,
    considered: input.skills.length,
    duplicateLoadsAvoided,
  };
}

function scoreSkill(
  skill: SkillMetadata,
  queryTokens: Set<string>,
  agent?: string,
): { score: number; matched: string[] } {
  const hayTokens = new Set(
    splitTokens(
      `${skill.name} ${skill.description} ${(skill.triggers ?? []).join(" ")}`,
    ),
  );
  const matched: string[] = [];
  let hits = 0;
  let matchedNonGeneric = false;
  for (const token of queryTokens) {
    const weight = tokenMatchWeight(token, hayTokens);
    if (weight === 0) continue;
    matched.push(token);
    hits += weight;
    if (!SKILL_GENERIC_TOKENS.has(token)) matchedNonGeneric = true;
  }
  // Generic structural words alone cannot make an unrelated global skill
  // relevant; require at least one distinctive token.
  if (!matchedNonGeneric) return { score: 0, matched: [] };

  let score = queryTokens.size ? hits / queryTokens.size : 0;

  // Explicit trigger match is a strong signal.
  for (const trig of skill.triggers ?? []) {
    const trigTokens = new Set(splitTokens(trig));
    if ([...queryTokens].some((t) => tokenMatchWeight(t, trigTokens) > 0)) score += 0.2;
  }
  // Slight boost when the skill declares the target agent.
  if (agent && skill.compatibleAgents?.includes(agent)) score += 0.1;
  return { score, matched: matched.slice(0, 3) };
}

function buildReason(
  skill: SkillMetadata,
  matched: string[],
  score: number,
  already: boolean,
): string {
  const bits: string[] = [];
  if (matched.length) bits.push(`matches "${matched.join(", ")}"`);
  bits.push(`${skill.scope} skill`);
  if (already) bits.push("already loaded — no reload needed");
  return `${bits.join("; ")} (priority ${round2(score)})`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
