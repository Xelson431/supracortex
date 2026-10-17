/**
 * Memory compaction: collapse superseded entries and expire stale ones while
 * preserving an audit trail. Unresolved failures and active decisions are never
 * discarded without explicit policy approval.
 *
 * Session-scoped entries (candidate/forgotten status) older than
 * `sessionRetentionDays` are automatically expired. Durable entries (fact,
 * decision, convention, constraint) are NEVER silently deleted by this path.
 * Age-based rules (time-elapsed invalidation, TTL/decay) only set the
 * `needsReverifyAt` marker: they never change `status`, `updatedAt`, or
 * `lastVerifiedAt`, so the entry stays retrievable.
 */

import type { MemoryEntry } from "../types.ts";
import { requiresResolution } from "./transitions.ts";

export interface CompactionOptions {
  now?: number;
  sessionRetentionDays: number;
  /** When true, allows discarding resolved failures older than retention. */
  discardResolvedFailures?: boolean;
  /** Opt-in Ebbinghaus-ish decay sweep: entries older than `ttlDays` are
   * flagged for re-verification (never demoted). */
  ttlDays?: number;
  /** Half-life in days for the decay strength curve (default 30). */
  halfLifeDays?: number;
  /** Opt-in line-budget guard: prune oldest beyond `maxLines` (see MAX_LINES). */
  maxLines?: number;
}

export interface CompactionResult {
  kept: MemoryEntry[];
  superseded: number;
  expired: number;
  decayed?: number;
  pruned?: number;
  pruneReason?: string;
  auditTrail: Array<{ id: string; action: "superseded" | "expired" | "stale" | "pruned"; at: string }>;
}

/** Default line-budget guard: total entries retained before oldest-first prune. */
export const MAX_LINES = 1000;

export function compactMemory(
  entries: MemoryEntry[],
  opts: CompactionOptions,
): CompactionResult {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const auditTrail: CompactionResult["auditTrail"] = [];

  // Mark entries superseded by others.
  const supersededIds = new Set<string>();
  for (const e of entries) {
    if (e.supersedes) for (const id of e.supersedes) supersededIds.add(id);
  }

  const retentionMs = opts.sessionRetentionDays * 86_400_000;

  const kept: MemoryEntry[] = [];
  let superseded = 0;
  let expired = 0;

  for (const e of entries) {
    // Pinned entries are protected: never superseded/expired/stale-flagged here.
    if (e.tags.includes("pinned")) {
      kept.push(e);
      continue;
    }
    // Explicit supersession.
    if (supersededIds.has(e.id) && e.status !== "superseded") {
      kept.push({ ...e, status: "superseded", updatedAt: nowIso });
      superseded++;
      auditTrail.push({ id: e.id, action: "superseded", at: nowIso });
      continue;
    }

    // Session-scoped retention: candidate/forgotten entries past the retention
    // window are expired (transitioned to stale). Active durable entries are
    // NEVER silently expired by this path — they only transition via explicit
    // invalidation rules recorded at creation time.
    if (
      e.status === "candidate" || e.status === "forgotten"
    ) {
      const createdMs = Date.parse(e.createdAt);
      if (Number.isFinite(createdMs) && now - createdMs > retentionMs) {
        // Transition to stale (non-destructive; reviewable until explicit purge).
        kept.push({ ...e, status: "stale", updatedAt: nowIso });
        expired++;
        auditTrail.push({ id: e.id, action: "expired", at: nowIso });
        continue;
      }
    }

    // discardResolvedFailures: when true, resolved failure entries (superseded
    // or stale status) older than the retention window are pruned entirely.
    if (
      opts.discardResolvedFailures &&
      e.kind === "failure" &&
      (e.status === "superseded" || e.status === "stale")
    ) {
      const createdMs = Date.parse(e.createdAt);
      if (Number.isFinite(createdMs) && now - createdMs > retentionMs) {
        // Physically drop — not pushed to kept.
        expired++;
        auditTrail.push({ id: e.id, action: "pruned", at: nowIso });
        continue;
      }
    }

    // Time-based invalidation rules. Age is advisory: flag for
    // re-verification, never demote. The entry stays active and retrievable.
    const expiredByRule = e.invalidationRules.some(
      (r) => r.kind === "time-elapsed" && r.expiresAt && new Date(r.expiresAt).getTime() <= now,
    );
    if (expiredByRule && e.status === "active") {
      if (!e.needsReverifyAt) {
        kept.push({ ...e, needsReverifyAt: nowIso });
        expired++;
        auditTrail.push({ id: e.id, action: "stale", at: nowIso });
      } else {
        kept.push(e);
      }
      continue;
    }

    kept.push(e);
  }

  // Opt-in decay sweep (Ebbinghaus-ish + TTL): active entries whose retention
  // strength decayed below threshold or whose age exceeds ttlDays are flagged
  // for re-verification, not demoted. Unresolved candidates/disputed + pinned
  // are always preserved.
  let decayed = 0;
  if (opts.ttlDays !== undefined && opts.ttlDays > 0) {
    const halfLife = opts.halfLifeDays && opts.halfLifeDays > 0 ? opts.halfLifeDays : 30;
    const ttlMs = opts.ttlDays * 86_400_000;
    for (let i = 0; i < kept.length; i++) {
      const e = kept[i]!;
      if (e.tags.includes("pinned")) continue;
      if (e.status === "candidate" || e.status === "disputed") continue;
      if (e.status !== "active") continue;
      if (e.needsReverifyAt) continue;
      const createdMs = Date.parse(e.createdAt);
      if (!Number.isFinite(createdMs)) continue;
      const ageDays = (now - createdMs) / 86_400_000;
      const strength = Math.exp((-ageDays * Math.LN2) / halfLife);
      if (now - createdMs > ttlMs || strength < 0.05) {
        kept[i] = { ...e, needsReverifyAt: nowIso };
        decayed++;
        auditTrail.push({ id: e.id, action: "stale", at: nowIso });
      }
    }
  }

  // Opt-in line-budget guard: prune oldest beyond maxLines, preserving pinned
  // + unresolved candidates/disputed + reviewable stale. Oldest terminal
  // (forgotten/superseded) first. Delete-by-timestamp (oldest createdAt).
  let pruned = 0;
  let pruneReason: string | undefined;
  if (opts.maxLines !== undefined && opts.maxLines >= 0 && kept.length > opts.maxLines) {
    const budget = enforceLineBudget(kept, opts.maxLines);
    pruned = budget.pruned;
    pruneReason = budget.reason;
    for (const id of budget.prunedIds) auditTrail.push({ id, action: "pruned", at: nowIso });
    return { kept: budget.kept, superseded, expired, decayed, pruned, pruneReason, auditTrail };
  }

  // Drop already-superseded entries that are fully shadowed (keep newest audit).
  // We retain superseded entries for one compaction cycle then remove; here we
  // keep them but callers may filter status==="superseded" for retrieval.
  return { kept, superseded, expired, decayed, pruned, pruneReason, auditTrail };
}

/**
 * Reviewable stale entries (status "stale": evidence mismatch or explicit
 * invalidation) are held for explicit review. They are never auto-pruned by
 * the line-budget guard — only an explicit purge (by path/ids) or a terminal
 * forgotten/superseded transition removes them. Age-based markers
 * (`needsReverifyAt`) do not remove eligibility.
 */
export function isProtectedFromBudget(e: MemoryEntry): boolean {
  if (e.tags.includes("pinned")) return true;
  if (requiresResolution(e.status)) return true;
  if (e.status === "stale") return true;
  return false;
}

/** Terminal states pruned first when the budget overflows (oldest first). */
const TERMINAL_PRUNE_FIRST = new Set(["forgotten", "superseded"]);

/**
 * Line-budget guard: keep at most `maxLines` entries. Pinned + unresolved
 * candidates/disputed + reviewable stale are never auto-pruned; among the
 * rest the oldest terminal (forgotten/superseded) go first, then oldest
 * active. When everything is protected, nothing is pruned and `reason` is
 * "all-pinned".
 */
export function enforceLineBudget(
  entries: MemoryEntry[],
  maxLines: number = MAX_LINES,
): { kept: MemoryEntry[]; pruned: number; prunedIds: string[]; reason?: string } {
  if (entries.length <= maxLines) return { kept: entries, pruned: 0, prunedIds: [] };
  const protected_ = entries.filter(isProtectedFromBudget);
  if (protected_.length >= maxLines) {
    return { kept: entries, pruned: 0, prunedIds: [], reason: "all-pinned" };
  }
  const prunable = entries
    .filter((e) => !isProtectedFromBudget(e))
    .sort((a, b) => {
      const ta = TERMINAL_PRUNE_FIRST.has(a.status) ? 0 : 1;
      const tb = TERMINAL_PRUNE_FIRST.has(b.status) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
  const dropCount = entries.length - maxLines;
  const dropIds = new Set(prunable.slice(0, dropCount).map((e) => e.id));
  return {
    kept: entries.filter((e) => !dropIds.has(e.id)),
    pruned: dropIds.size,
    prunedIds: [...dropIds],
  };
}
