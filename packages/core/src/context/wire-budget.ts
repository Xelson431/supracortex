/**
 * ContextPacket V1 -> V2 compatibility projection.
 *
 * This module deliberately does not render an adapter payload. The adapter
 * owns its exact wire format and must replace `payloadTokensEstimated` with an
 * estimate over the final bytes it emits.
 */

import type {
  ContextMemoryEvidenceV2,
  ContextMemoryOriginV2,
  ContextOmissionV2,
  ContextPacket,
  ContextPacketV2,
  MemoryEntry,
} from "../types.ts";
import { measureTokens } from "../metrics/token-estimator.ts";

export const CONTEXT_WIRE_ESTIMATOR = "supracortex-char-density-v1";

/**
 * Second-read billing: when the agent performs the recommended read, the
 * full source body is billed fresh — a prior reference/recommendation never
 * makes it free. Each read bills `max(0, estimatedSourceTokens)`.
 */
export function secondReadBilledTokens(
  reads: Array<{ estimatedSourceTokens?: number; estimatedTokens: number; mode?: string }>,
): number {
  return reads.reduce(
    (total, read) => total + Math.max(0, Math.ceil(read.estimatedSourceTokens ?? read.estimatedTokens)),
    0,
  );
}

/**
 * Measure wire text via `measureTokens` (tiktoken primary). The heuristic
 * fallback path is tagged `estimated: true` — never presented as measured.
 */
export function estimateWireTextTokens(
  texts: string[],
  modelHint?: string,
): { tokens: number; estimated: boolean } {
  let tokens = 0;
  let estimated = false;
  for (const text of texts) {
    const m = measureTokens(text, modelHint);
    tokens += m.tokens;
    if (m.estimated) estimated = true;
  }
  return { tokens, estimated };
}

export interface WireBudgetDescription {
  /** Measured/labeled estimate over evidence text actually placed on the wire. */
  payloadTokensEstimated: number;
  /** True when any heuristic-estimate charge is included. */
  estimated: boolean;
  /** Billed-fresh cost of performing every recommended second read. */
  secondReadBilledTokens: number;
  estimator: string;
}

/** Describe the wire budget for a built packet (evidence measured, reads billed fresh). */
export function describeWireBudget(packet: ContextPacket, modelHint?: string): WireBudgetDescription {
  const texts: string[] = [
    ...packet.selectedMemory.map((m) => m.entry.content),
    ...packet.selectedSummaries.map((s) => s.summary),
  ];
  const { tokens, estimated } = estimateWireTextTokens(texts, modelHint);
  const secondReads = secondReadBilledTokens(packet.selectedFiles);
  return {
    payloadTokensEstimated: tokens,
    estimated: estimated || packet.selectedFiles.length > 0 || packet.selectedSummaries.length > 0,
    secondReadBilledTokens: secondReads,
    estimator: CONTEXT_WIRE_ESTIMATOR,
  };
}

/**
 * Project the legacy builder result into the frozen V2 semantic shape.
 * Trust is conservative: missing/legacy origin metadata is never invented.
 */
export function projectContextPacketV2(packet: ContextPacket): ContextPacketV2 {
  const omissions: ContextOmissionV2[] = packet.omissions.map((omission) => ({
    subject: omission.path,
    reasonCode: omission.reason,
    ...(omission.detail ? { detail: omission.detail } : {}),
  }));

  const memory: ContextMemoryEvidenceV2[] = [];
  const seenMemoryText = new Set<string>();
  for (const selection of packet.selectedMemory) {
    if (seenMemoryText.has(selection.entry.content)) continue;
    seenMemoryText.add(selection.entry.content);
    const eligible = eligibleMemory(selection.entry, selection.reason);
    if (eligible) {
      memory.push(eligible);
    } else {
      omissions.push({
        subject: `memory:${selection.entry.id}`,
        reasonCode: "automatic-memory-ineligible",
        detail: "legacy memory lacks an explicit eligible origin/evidence state",
      });
    }
  }

  const summaries = packet.selectedSummaries
    .filter((summary) => summary.verified && summary.sourceHash.length > 0)
    .filter(uniqueBy((summary) => `${summary.path}\u0000${summary.sourceHash}`))
    .map((summary) => ({
      path: summary.path,
      text: summary.summary,
      sourceHash: summary.sourceHash,
      reason: summary.reason,
    }));

  const reads = packet.selectedFiles
    .filter((file) => {
      if (file.hash) return true;
      omissions.push({
        subject: file.path,
        reasonCode: "missing-source-hash",
        detail: "read recommendation omitted because its current source hash is unavailable",
      });
      return false;
    })
    .filter(uniqueBy((file) => `${file.path}\u0000${file.hash}`))
    .map((file) => ({
      path: file.path,
      sourceHash: file.hash!,
      estimatedSourceTokens: Math.max(
        0,
        Math.ceil(file.estimatedSourceTokens ?? (file.mode === "full" ? file.estimatedTokens : 0)),
      ),
      reason: file.reason,
    }));

  const sourceTokensRecommendedEstimated = reads.reduce(
    (total, read) => total + read.estimatedSourceTokens,
    0,
  );
  const sourceTokensConsideredEstimated =
    packet.selectedMemory.reduce((total, item) => total + Math.max(0, item.estimatedTokens), 0) +
    packet.selectedSummaries.reduce((total, item) => total + Math.max(0, item.estimatedTokens), 0) +
    sourceTokensRecommendedEstimated;

  // Skill/MCP guidance is bounded pre-truncation advice (max 12 each); the
  // adapter renderer re-enforces the final byte/token budget, so guidance
  // competes with evidence for wire space like every other record.
  const skills = (packet.recommendedSkills ?? [])
    .filter((s) => s && typeof s.name === "string" && s.name.length > 0)
    .slice(0, 12)
    .map((s) => ({ name: s.name, reason: s.reason ?? "" }));
  const mcpTools = (packet.recommendedMcpTools ?? [])
    .filter((t) => t && typeof t.server === "string" && t.server.length > 0)
    .slice(0, 12)
    .map((t) => ({ server: t.server, ...(t.tool ? { tool: t.tool } : {}), purpose: t.purpose ?? "" }));

  return {
    schemaVersion: 2,
    taskId: packet.taskId,
    evidence: { memory, summaries, inlineSources: [] },
    recommendations: { reads, skills, mcpTools },
    omissions: dedupeOmissions(omissions),
    accounting: {
      maxPayloadTokens: Math.max(0, Math.floor(packet.budget.maxTokens)),
      payloadTokensEstimated: 0,
      sourceTokensConsideredEstimated,
      sourceTokensRecommendedEstimated,
      estimator: CONTEXT_WIRE_ESTIMATOR,
    },
    generatedAt: packet.generatedAt,
  };
}

export function isContextPacketV2(packet: ContextPacket | ContextPacketV2): packet is ContextPacketV2 {
  return "schemaVersion" in packet && packet.schemaVersion === 2;
}

function eligibleMemory(entry: MemoryEntry, reason: string): ContextMemoryEvidenceV2 | null {
  if (entry.status !== "active") return null;
  const origin = normalizeOrigin(entry.origin);
  if (origin === "explicit-user") {
    return {
      id: entry.id,
      kind: entry.kind,
      text: entry.content,
      origin,
      evidenceState: "user-authenticated",
      automaticEligibility: true,
      reason,
    };
  }
  // Memory with verified file evidence (hash present) is eligible regardless of
  // origin. The hash proves the evidence was validated against the repository.
  const hasVerifiedFileEvidence = entry.sourceReferences.some(
    (reference) => reference.kind === "file" && Boolean(reference.hash),
  );
  if (origin === "local-source" && hasVerifiedFileEvidence) {
    return {
      id: entry.id,
      kind: entry.kind,
      text: entry.content,
      origin,
      evidenceState: "verified",
      automaticEligibility: true,
      reason,
    };
  }
  // Legacy entries without an explicit origin but with verified file evidence
  // are still eligible — the hash proves verification even if the origin label
  // was not recorded.
  if (!origin && hasVerifiedFileEvidence) {
    return {
      id: entry.id,
      kind: entry.kind,
      text: entry.content,
      origin: "local-source",
      evidenceState: "verified",
      automaticEligibility: true,
      reason,
    };
  }
  return null;
}

function normalizeOrigin(origin: string | undefined): ContextMemoryOriginV2 | null {
  if (!origin) return null;
  const normalized = origin.trim().toLowerCase();
  if (normalized === "explicit-user" || normalized === "user" || normalized.startsWith("explicit-user:")) {
    return "explicit-user";
  }
  if (normalized === "local-source" || normalized.startsWith("local-source:")) return "local-source";
  if (normalized === "agent-candidate" || normalized.startsWith("agent:")) return "agent-candidate";
  if (normalized === "imported" || normalized.startsWith("imported:") || normalized.startsWith("supraspace:")) return "imported";
  return null;
}

function uniqueBy<T>(key: (value: T) => string): (value: T) => boolean {
  const seen = new Set<string>();
  return (value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

function dedupeOmissions(omissions: ContextOmissionV2[]): ContextOmissionV2[] {
  return omissions.filter(uniqueBy((item) => `${item.subject}\u0000${item.reasonCode}\u0000${item.detail ?? ""}`));
}
