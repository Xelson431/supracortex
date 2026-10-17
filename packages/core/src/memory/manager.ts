/**
 * MemoryManager: high-level API over the repository. Handles recording (with
 * validation, redaction, evidence policy), contradiction detection, retrieval,
 * and compaction persistence.
 */

import type { MemoryEntry, MemorySelection } from "../types.ts";
import type { StorageAdapter } from "../storage/storage-adapter.ts";
import { MemoryRepository } from "./repository.ts";
import {
  buildMemoryEntry,
  classifyRecord,
  type BuildOptions,
  type NewMemoryInput,
  type RecordClassification,
} from "./schemas.ts";
import { buildQueryContext } from "./ranking.ts";
import { retrieveMemory, type RetrievalOptions } from "./retrieval.ts";
import {
  compactMemory,
  enforceLineBudget,
  MAX_LINES,
  type CompactionOptions,
  type CompactionResult,
} from "./compaction.ts";
import { decideMemoryTransition, requiresResolution } from "./transitions.ts";

/** Coded fallback marker when the sidecar FTS path is missing/corrupt. */
export const FTS_MISSING = "FTS_MISSING";

/** Similarity threshold above which a conflicting assertion becomes a candidate (3b). */
export const CONTRADICTION_THRESHOLD = 0.9;

export interface RecordOptions extends BuildOptions {
  /**
   * Similarity threshold (0..1) for contradiction detection. Default
   * CONTRADICTION_THRESHOLD (0.9). A threshold tie (>=) holds the new
   * assertion as a candidate requiring resolution before active.
   */
  contradictionThreshold?: number;
}

export interface RecordResult {
  status: "recorded" | "rejected";
  entry?: MemoryEntry;
  reason?: string;
  redacted: boolean;
  disputed?: boolean;
  /** Classification of the input after schema validation (3a). */
  classification?: RecordClassification;
  /** Id of the active same-kind entry this input relates to, if any. */
  matchId?: string;
}

export class MemoryManager {
  private repo: MemoryRepository;
  private store: StorageAdapter;
  private now: () => number;

  constructor(store: StorageAdapter, now: () => number = () => Date.now()) {
    this.store = store;
    this.now = now;
    this.repo = new MemoryRepository(store);
  }

  async record(input: NewMemoryInput, opts: RecordOptions): Promise<RecordResult> {
    // Thread the manager clock into entry construction unless the caller pinned one.
    const built = buildMemoryEntry(input, { now: this.now(), ...opts });
    if (!built.entry) {
      return { status: "rejected", reason: built.rejected, redacted: built.redacted };
    }

    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      // 3a: classify add/update/noop after schema validation (deterministic
      // rules now; LLM hook point lives in `classifyRecord`).
      const { classification, matchId } = classifyRecord(built.entry.content, built.entry.kind, entries);
      if (classification === "noop") {
        const existing = entries.find((e) => e.id === matchId);
        return {
          status: "recorded",
          entry: existing ?? built.entry,
          redacted: built.redacted,
          disputed: false,
          classification,
          matchId,
        };
      }
      // Contradiction detection is only a review signal. A lexical heuristic
      // must never rewrite existing history or decide that either assertion is
      // false. The new assertion is held as a candidate until a reviewer makes
      // an explicit, auditable decision. Threshold ties (>=) are candidates.
      const threshold = opts.contradictionThreshold ?? CONTRADICTION_THRESHOLD;
      const contradiction = findContradiction(built.entry, entries, threshold);
      let disputed = false;
      if (contradiction) {
        built.entry.status = "candidate";
        built.entry.supersedes = undefined;
        if (!built.entry.tags.includes("possible-contradiction")) {
          built.entry.tags = [...built.entry.tags, "possible-contradiction"];
        }
        disputed = true;
      } else if (classification === "update" && matchId && !built.entry.supersedes) {
        // Non-contradictory near-duplicate: link history, never overwrite.
        built.entry.supersedes = [matchId];
      }

      await this.repo.append(built.entry);
      // Sync FTS indexes (sqlite driver only, no-op otherwise). Single write
      // path: manager.record is the only writer, so legacy memory_fts and the
      // 1c content mirror (triggers sync docs_fts) cannot drift. Legacy is
      // kept as a read-only fallback until the sidecar path is verified live.
      // Sidecar failures never fail the record: JSONL is the source of truth.
      if (this.store.ftsSync) {
        await this.store.ftsSync({
          id: built.entry.id,
          content: built.entry.content,
          kind: built.entry.kind,
          tags: built.entry.tags,
        });
      }
      try {
        await this.store.ftsSidecarInsert?.({
          id: built.entry.id,
          kind: built.entry.kind,
          text: built.entry.content,
          updatedAt: built.entry.updatedAt,
        });
      } catch (err) {
        console.warn(`[${FTS_MISSING}] sidecar insert skipped: ${(err as Error)?.message ?? err}`);
      }
      return {
        status: "recorded",
        entry: built.entry,
        redacted: built.redacted,
        disputed,
        classification,
        matchId,
      };
    } finally {
      await release();
    }
  }

  async search(
    query: string,
    tags: string[],
    hintFiles: string[],
    changedFiles: string[],
    opts: RetrievalOptions,
    now: number = Date.now(),
  ): Promise<{ selections: MemorySelection[]; considered: number; tokens: number }> {
    const { entries } = await this.repo.loadAll();
    const ctx = buildQueryContext(query, tags, hintFiles, changedFiles);

    // Live sidecar path first via the repository triple-read fallback:
    // sidecar docs_fts (weighted bm25, 5x LIMIT inside the store), then
    // legacy memory_fts, then a LIKE scan over the content mirror, then
    // pure lexical retrieval — with an FTS_MISSING log whenever sidecar is
    // unavailable. Single read path lives in MemoryRepository.searchFts.
    const fts = await this.repo.searchFts(query, opts.maxEntries);
    if (fts.bm25) {
      opts = { ...opts, bm25: fts.bm25 };
    }

    const res = retrieveMemory(entries, ctx, opts, now);
    return { selections: res.selected, considered: res.considered, tokens: res.tokensSelected };
  }

  async loadAll(): Promise<MemoryEntry[]> {
    return (await this.repo.loadAll()).entries;
  }

  async counts(): Promise<Record<string, number>> {
    return this.repo.count();
  }

  async compact(opts: CompactionOptions): Promise<CompactionResult> {
    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      const result = compactMemory(entries, opts);
      await this.repo.rewriteAll(result.kept);
      // Rebuild FTS indexes from kept entries (sqlite driver only).
      // Legacy memory_fts is retained read-only until the sidecar is verified.
      if (this.store.ftsRebuild) {
        await this.store.ftsRebuild(
          result.kept.map((e) => ({ id: e.id, content: e.content, kind: e.kind, tags: e.tags })),
        );
      }
      try {
        if (this.store.ftsBackfillSidecar) {
          await this.store.ftsBackfillSidecar(
            result.kept.map((e) => ({ id: e.id, kind: e.kind, text: e.content, updatedAt: e.updatedAt })),
          );
        }
      } catch (err) {
        console.warn(`[${FTS_MISSING}] sidecar rebuild skipped: ${(err as Error)?.message ?? err}`);
      }
      return result;
    } finally {
      await release();
    }
  }

  /**
   * Decay sweep (3c): Ebbinghaus-ish + TTL pass that preserves unresolved
   * candidates/disputed + pinned, then enforces the line-budget guard
   * (oldest-first prune beyond `maxLines`). Thin wrapper over compaction so
   * scheduled sweeps share one code path with explicit compact() calls.
   */
  async sweep(
    opts: { now?: number; ttlDays: number; halfLifeDays?: number; maxLines?: number } & Pick<
      CompactionOptions,
      "sessionRetentionDays" | "discardResolvedFailures"
    >,
  ): Promise<CompactionResult> {
    return this.compact({
      now: opts.now,
      sessionRetentionDays: opts.sessionRetentionDays,
      discardResolvedFailures: opts.discardResolvedFailures,
      ttlDays: opts.ttlDays,
      halfLifeDays: opts.halfLifeDays,
      maxLines: opts.maxLines ?? MAX_LINES,
    });
  }

  /** Entries still awaiting explicit review resolution (never auto-pruned). */
  async listUnresolved(limit = 100): Promise<MemoryEntry[]> {
    const { entries } = await this.repo.loadAll();
    return entries.filter((e) => requiresResolution(e.status)).slice(0, Math.max(1, Math.min(1000, limit)));
  }

  /** Current line-budget usage vs MAX_LINES (durable/ephemeral split). */
  async budget(): Promise<{ total: number; maxLines: number; over: boolean }> {
    const { entries } = await this.repo.loadAll();
    void enforceLineBudget;
    return { total: entries.length, maxLines: MAX_LINES, over: entries.length > MAX_LINES };
  }

  /**
   * Non-destructively mark active entries stale when their `file` evidence
   * changed or vanished. Only references with a stored `hash` are evaluated;
   * references without a hash are counted as `unverifiable` and left untouched.
   * Never uses `disputed` (reserved for contradictory claims).
   */
  async invalidateByEvidence(
    indexFiles: Record<string, { hash: string }>,
    now: number,
  ): Promise<{ changed: number; deleted: number; expired: number; unverifiable: number }> {
    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      let changed = 0;
      let deleted = 0;
      let expired = 0;
      let unverifiable = 0;
      let mutated = false;
      for (const e of entries) {
        if (e.status !== "active") continue;
        const rules = e.invalidationRules ?? [];
        let markReason: string | null = null;
        let ageExpired = false;
        for (const rule of rules) {
          if (
            rule.kind === "time-elapsed" &&
            rule.expiresAt &&
            Number.isFinite(new Date(rule.expiresAt).getTime()) &&
            new Date(rule.expiresAt).getTime() <= now
          ) {
            // Age is a re-verification prompt, not evidence of falsity: it must
            // never change lifecycle status, timestamps, or tags. Keep scanning
            // so a genuine file mismatch still takes the destructive path.
            expired++;
            ageExpired = true;
            continue;
          }
          if (rule.kind !== "file-hash-changed" || !rule.target) continue;
          const ref = e.sourceReferences.find((r) => r.kind === "file" && r.value === rule.target);
          if (!ref) continue;
          if (!ref.hash) { unverifiable++; continue; }
          const current = indexFiles[rule.target];
          if (!current) { markReason = `evidence file ${rule.target} unavailable`; deleted++; break; }
          if (current.hash !== ref.hash) { markReason = `evidence file ${rule.target} changed`; changed++; break; }
        }
        if (ageExpired && e.needsReverifyAt === undefined) {
          e.needsReverifyAt = new Date(now).toISOString();
          mutated = true;
        }
        if (markReason) {
          e.status = "stale";
          e.updatedAt = new Date(now).toISOString();
          delete e.lastVerifiedAt;
          if (!e.tags.includes("evidence-stale")) e.tags = [...e.tags, "evidence-stale"];
          mutated = true;
        }
      }
      if (mutated) {
        await this.repo.rewriteAll(entries);
        // No FTS sync needed: invalidation only changes status/tags, not content/kind.
      }
      return { changed, deleted, expired, unverifiable };
    } finally {
      await release();
    }
  }

  async listByStatus(statuses: string[], limit = 100): Promise<MemoryEntry[]> {
    const { entries } = await this.repo.loadAll();
    const set = new Set(statuses);
    return entries.filter((e) => set.has(e.status)).slice(0, Math.max(1, Math.min(1000, limit)));
  }

  /** Append a revised entry (same id/kind) with a new status. */
  async setStatus(id: string, status: MemoryEntry["status"], now: number): Promise<MemoryEntry | null> {
    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      const cur = entries.find((e) => e.id === id);
      if (!cur) return null;
      const transition = decideMemoryTransition(cur.status, status);
      if (!transition.allowed) return null;
      if (transition.idempotent) return cur;
      cur.status = status;
      cur.updatedAt = new Date(now).toISOString();
      if (status === "active") {
        // Activation is an explicit verification: it confirms the current
        // content/evidence and clears any pending age-based re-check.
        cur.lastVerifiedAt = new Date(now).toISOString();
        delete cur.needsReverifyAt;
      } else {
        delete cur.lastVerifiedAt;
      }
      await this.repo.rewriteAll(entries);
      // No FTS sync needed: status change doesn't affect content/kind which are the
      // only columns FTS indexes for MATCH ranking (kind/tags are UNINDEXED).
      return cur;
    } finally {
      await release();
    }
  }

  /**
   * Explicitly accept the current hashes for file evidence that changed.
   * Only matching `file` references (same value and old hash) are updated;
   * status, timestamps other than `lastVerifiedAt`, content and confidence are
   * preserved. Activation remains a separate `approve` step.
   */
  async refreshEvidence(
    id: string,
    updates: Array<{ file: string; oldHash: string; newHash: string }>,
    now: number,
  ): Promise<MemoryEntry | null> {
    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      const cur = entries.find((e) => e.id === id);
      if (!cur) return null;
      const byFile = new Map(updates.map((u) => [u.file, u]));
      cur.sourceReferences = cur.sourceReferences.map((ref) => {
        if (ref.kind !== "file") return ref;
        const update = byFile.get(ref.value);
        if (!update || ref.hash !== update.oldHash) return ref;
        return { ...ref, hash: update.newHash };
      });
      cur.lastVerifiedAt = new Date(now).toISOString();
      delete cur.needsReverifyAt;
      cur.tags = cur.tags.filter((tag) => tag !== "evidence-stale");
      await this.repo.rewriteAll(entries);
      // No FTS sync needed: content/kind (the only ranked columns) are unchanged.
      return cur;
    } finally {
      await release();
    }
  }

  /**
   * Explicitly re-confirm an entry without changing its lifecycle status.
   * Sets `lastVerifiedAt`, clears any pending `needsReverifyAt` marker, and
   * preserves content, confidence, references, tags, status, and `updatedAt`.
   */
  async markVerified(id: string, now: number): Promise<MemoryEntry | null> {
    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      const cur = entries.find((e) => e.id === id);
      if (!cur) return null;
      cur.lastVerifiedAt = new Date(now).toISOString();
      delete cur.needsReverifyAt;
      await this.repo.rewriteAll(entries);
      // No FTS sync needed: content/kind (the only ranked columns) are unchanged.
      return cur;
    } finally {
      await release();
    }
  }

  /** Add a tag idempotently (e.g. "pinned"). */
  async addTag(id: string, tag: string, now: number): Promise<MemoryEntry | null> {
    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      const cur = entries.find((e) => e.id === id);
      if (!cur) return null;
      if (!cur.tags.includes(tag)) cur.tags = [...cur.tags, tag];
      cur.updatedAt = new Date(now).toISOString();
      await this.repo.rewriteAll(entries);
      // No FTS sync needed: tags are UNINDEXED in memory_fts (filter-only, not ranked).
      return cur;
    } finally {
      await release();
    }
  }

  /** Edit content/confidence/tags in place. id/kind/createdAt/sources preserved. */
  async editEntry(
    id: string,
    patch: { content?: string; confidence?: number; tags?: string[] },
    opts: BuildOptions,
    now: number,
  ): Promise<{ status: "edited" | "rejected"; reason?: string; entry?: MemoryEntry }> {
    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      const cur = entries.find((e) => e.id === id);
      if (!cur) return { status: "rejected", reason: "unknown id" };
      const built = buildMemoryEntry(
        {
          kind: cur.kind,
          content: patch.content ?? cur.content,
          confidence: patch.confidence ?? cur.confidence,
          sourceReferences: cur.sourceReferences,
          relatedFiles: cur.relatedFiles,
          relatedSymbols: cur.relatedSymbols,
          tags: patch.tags ?? cur.tags,
          invalidationRules: cur.invalidationRules,
          status: cur.status,
        },
        { ...opts, now },
      );
      if (!built.entry) return { status: "rejected", reason: built.rejected };
      built.entry.id = cur.id;
      built.entry.createdAt = cur.createdAt;
      const next = entries.map((e) => (e.id === id ? built.entry! : e));
      await this.repo.rewriteAll(next);
      // Sync FTS index with the edited content (sqlite driver only, no-op otherwise).
      if (this.store.ftsSync) {
        await this.store.ftsSync({
          id: built.entry!.id,
          content: built.entry!.content,
          kind: built.entry!.kind,
          tags: built.entry!.tags,
        });
      }
      try {
        await this.store.ftsSidecarInsert?.({
          id: built.entry!.id,
          kind: built.entry!.kind,
          text: built.entry!.content,
          updatedAt: built.entry!.updatedAt,
        });
      } catch (err) {
        console.warn(`[${FTS_MISSING}] sidecar edit sync skipped: ${(err as Error)?.message ?? err}`);
      }
      return { status: "edited", entry: built.entry };
    } finally {
      await release();
    }
  }

  /** Physically remove an entry by id (rewrite files without it). */
  async purge(id: string): Promise<boolean> {
    const release = await this.store.acquireLock("memory");
    try {
      const { entries } = await this.repo.loadAll();
      const next = entries.filter((e) => e.id !== id);
      if (next.length === entries.length) return false;
      await this.repo.rewriteAll(next);
      // Remove from FTS index (sqlite driver only, no-op otherwise).
      if (this.store.ftsRemove) {
        await this.store.ftsRemove(id);
      }
      return true;
    } finally {
      await release();
    }
  }
}

/**
 * Heuristic contradiction detection: same kind + token overlap at or above
 * the similarity threshold + presence of a negation asymmetry. A threshold
 * tie (>=) holds the new assertion as a candidate. Conservative to avoid
 * false disputes; never rewrites existing history.
 */
export function findContradiction(
  candidate: MemoryEntry,
  existing: MemoryEntry[],
  threshold: number = CONTRADICTION_THRESHOLD,
): MemoryEntry | null {
  const cTokens = new Set(tokenize(candidate.content));
  const cNeg = hasNegation(candidate.content);
  for (const e of existing) {
    if (e.status !== "active") continue;
    if (e.kind !== candidate.kind) continue;
    const eTokens = new Set(tokenize(e.content));
    const overlap = intersectionSize(cTokens, eTokens);
    const denom = Math.min(cTokens.size, eTokens.size) || 1;
    const ratio = overlap / denom;
    if (ratio >= threshold && cNeg !== hasNegation(e.content)) {
      return e;
    }
  }
  return null;
}

function hasNegation(text: string): boolean {
  return /\b(not|never|no|don't|cannot|can't|without|avoid|disallow|forbidden)\b/i.test(text);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}
