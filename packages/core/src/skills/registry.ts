/**
 * Skill metadata handling (core, pure).
 *
 * The core stores only lightweight skill metadata and computes recommendations.
 * It never persists full skill instructions. Discovery of skill files is done
 * by the adapter (filesystem/OpenCode); this module scores and recommends.
 */

import type { SkillExclusion, SkillMetadata, SkillRecommendation } from "../types.ts";

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

  const scored = input.skills
    .map((s) => ({ skill: s, score: scoreSkill(s, input.queryTokens, input.targetAgent) }))
    .sort((a, b) => b.score - a.score);

  for (const { skill, score } of scored) {
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
      reason: buildReason(skill, input.queryTokens, score, already),
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

function scoreSkill(skill: SkillMetadata, queryTokens: string[], agent?: string): number {
  const hay = `${skill.name} ${skill.description} ${(skill.triggers ?? []).join(" ")}`.toLowerCase();
  let hits = 0;
  for (const t of queryTokens) if (hay.includes(t)) hits++;
  let score = queryTokens.length ? hits / queryTokens.length : 0;

  // Explicit trigger match is a strong signal.
  for (const trig of skill.triggers ?? []) {
    if (queryTokens.some((t) => trig.toLowerCase().includes(t))) score += 0.2;
  }
  // Slight boost when the skill declares the target agent.
  if (agent && skill.compatibleAgents?.includes(agent)) score += 0.1;
  return score;
}

function buildReason(
  skill: SkillMetadata,
  queryTokens: string[],
  score: number,
  already: boolean,
): string {
  const hay = `${skill.name} ${skill.description}`.toLowerCase();
  const matched = queryTokens.filter((t) => hay.includes(t)).slice(0, 3);
  const bits: string[] = [];
  if (matched.length) bits.push(`matches "${matched.join(", ")}"`);
  bits.push(`${skill.scope} skill`);
  if (already) bits.push("already loaded — no reload needed");
  return `${bits.join("; ")} (priority ${round2(score)})`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
