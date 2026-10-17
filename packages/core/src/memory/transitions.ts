import type { MemoryStatus } from "../types.ts";

export interface MemoryTransitionDecision {
  allowed: boolean;
  idempotent: boolean;
  reason: string;
}

const ALLOWED: Record<MemoryStatus, ReadonlySet<MemoryStatus>> = {
  candidate: new Set(["active", "disputed", "stale", "forgotten"]),
  active: new Set(["disputed", "stale", "superseded", "forgotten"]),
  disputed: new Set(["active", "stale", "forgotten"]),
  stale: new Set(["active", "disputed", "forgotten"]),
  superseded: new Set(["forgotten"]),
  forgotten: new Set(),
};

/**
 * Pure authoritative memory-status transition decision.
 *
 * Same-state retries are idempotent. Forgotten data cannot be revived through
 * an ordinary review operation, and superseded history cannot become active
 * without an explicit future restoration/migration operation.
 *
 * Contradictions always land in `candidate` and require explicit resolution
 * (candidate/disputed -> active/stale/forgotten) before becoming active; the
 * 6-state machine is the only path and history is never silently overwritten.
 */
export function decideMemoryTransition(
  previous: MemoryStatus,
  next: MemoryStatus,
): MemoryTransitionDecision {
  if (previous === next) {
    return { allowed: true, idempotent: true, reason: "already-in-target-state" };
  }
  if (ALLOWED[previous].has(next)) {
    return { allowed: true, idempotent: false, reason: "allowed-transition" };
  }
  return {
    allowed: false,
    idempotent: false,
    reason: `transition-${previous}-to-${next}-is-not-allowed`,
  };
}

export function allMemoryTransitionPairs(): Array<{
  previous: MemoryStatus;
  next: MemoryStatus;
  decision: MemoryTransitionDecision;
}> {
  const statuses: MemoryStatus[] = [
    "candidate",
    "active",
    "disputed",
    "stale",
    "superseded",
    "forgotten",
  ];
  return statuses.flatMap((previous) =>
    statuses.map((next) => ({ previous, next, decision: decideMemoryTransition(previous, next) })),
  );
}

/** Unresolved review states: never decayed, never silently pruned. */
const UNRESOLVED: ReadonlySet<MemoryStatus> = new Set(["candidate", "disputed"]);

/** True when an entry still requires explicit review resolution. */
export function requiresResolution(status: MemoryStatus): boolean {
  return UNRESOLVED.has(status);
}

/** True when the status is held for review (alias for requiresResolution). */
export function isUnresolvedCandidate(status: MemoryStatus): boolean {
  return UNRESOLVED.has(status);
}
