/**
 * Sweeper: the time-based garbage collector that keeps the system free of stale
 * state. OpenCode exposes no timer hook, so the sweep runs opportunistically
 * (engine init, session.idle, session.deleted) and is fully idempotent — running
 * it repeatedly on a clean system changes nothing and returns clean:true.
 *
 * Responsibilities:
 *  - reap abandoned tasks (heartbeat older than timeout, or dead session)
 *  - release ownership past TTL / held by dead task or session
 *  - expire session working state older than sessionTtl
 *  - prune stale summary-cache entries (past cache.maxAgeDays)
 *  - flag durable memory for re-verification after memoryReverifyDays
 *  - trim the completed-task audit log past retention
 *
 * All time inputs come from an injectable clock so behavior is deterministic.
 */

import { join } from "node:path";
import type { Config } from "../config.ts";
import type { MemoryEntry, SweepReport, TaskOutcome } from "../types.ts";
import type { StorageAdapter } from "../storage/storage-adapter.ts";
import { Reconciler } from "../orchestration/reconciler.ts";
import { ContextCache } from "../cache/context-cache.ts";
import { MemoryRepository } from "../memory/repository.ts";
import { collectLockGarbage } from "../storage/file-lock.ts";

const SESSIONS_DIR = "memory/sessions";
const COMPLETED_FILE = "tasks/completed.jsonl";

export interface SweepInput {
  config: Config;
  now: number;
  reason: string;
  /** Live OpenCode session ids, if known (from events). null = unknown. */
  liveSessionIds?: Set<string> | null;
  censusComplete?: boolean;
  terminalSessionId?: string;
}

export class Sweeper {
  private store: StorageAdapter;
  private reconciler: Reconciler;
  private cache: ContextCache;
  private memoryRepo: MemoryRepository;

  constructor(store: StorageAdapter, now: () => number = () => Date.now()) {
    this.store = store;
    this.reconciler = new Reconciler(store);
    this.cache = new ContextCache(store, now);
    this.memoryRepo = new MemoryRepository(store);
  }

  async sweep(input: SweepInput): Promise<SweepReport> {
    const { config, now, reason } = input;
    const liveSessions = input.liveSessionIds ?? null;
    const st = config.staleness;

    const report: SweepReport = {
      ranAt: new Date(now).toISOString(),
      reason,
      abandonedTasks: [],
      releasedOwnership: [],
      expiredSessions: [],
      prunedCacheEntries: 0,
      memoryFlaggedForReverify: [],
      prunedCompletedTasks: 0,
      collectedLocks: [],
      clean: true,
    };

    // 0. Collect lock garbage from force-quit sessions. Runs even when the
    // staleness policy is off: abandoned locks block writers, so this is a
    // liveness guarantee, not a retention preference. Silent (no stderr), so
    // later turns never trip over a dead session's locks mid-turn. This runs
    // on engine-init, which makes it the session-start garbage collector.
    try {
      const gc = await collectLockGarbage(join(this.store.root, "state"));
      report.collectedLocks = gc.removed;
    } catch {
      // Best-effort: a failed scan must never fail the sweep.
    }

    if (!st.enabled) {
      report.clean = report.collectedLocks.length === 0;
      return report;
    }

    // 1. Reap abandoned tasks + their ownership.
    const heartbeatMs = st.taskHeartbeatTimeoutMinutes * 60_000;
    const reap = await this.reconciler.reapAbandonedTasks(heartbeatMs, liveSessions, now, {
      automaticOutcomeRecording: config.integration.automaticOutcomeRecording,
      terminalSessionId: input.terminalSessionId,
      censusComplete: input.censusComplete,
    });
    report.abandonedTasks = reap.abandoned;
    report.releasedOwnership = reap.released;

    // 2. Ownership TTL / dead-session sweep is already handled inside reap via
    //    OwnershipManager.reap, but run an explicit pass for TTL-only expiry
    //    when there are no active tasks referencing them.
    //    (reap above already released expired claims; nothing more to do.)

    // 3. Expire old session working files.
    report.expiredSessions = await this.expireSessions(st.sessionTtlMinutes * 60_000, now);

    // 4. Prune stale cache entries.
    if (st.pruneStaleCacheOnSweep && config.cache.enabled) {
      report.prunedCacheEntries = await this.cache.pruneByAge(config.cache.maxAgeDays, now);
    }

    // 5. Flag durable memory for re-verification.
    if (config.memory.enabled && st.memoryReverifyDays > 0) {
      report.memoryFlaggedForReverify = await this.flagMemoryForReverify(
        st.memoryReverifyDays,
        now,
      );
    }

    // 6. Trim completed-task audit log.
    if (st.completedTaskRetentionDays > 0) {
      report.prunedCompletedTasks = await this.trimCompleted(st.completedTaskRetentionDays, now);
    }

    report.clean =
      report.abandonedTasks.length === 0 &&
      report.releasedOwnership.length === 0 &&
      report.expiredSessions.length === 0 &&
      report.prunedCacheEntries === 0 &&
      report.memoryFlaggedForReverify.length === 0 &&
      report.prunedCompletedTasks === 0;

    return report;
  }

  private async expireSessions(ttlMs: number, now: number): Promise<string[]> {
    if (ttlMs <= 0) return [];
    const expired: string[] = [];
    // Sessions are stored as JSON files under memory/sessions/<id>.json.
    // We rely on the stored `updatedAt` field, not mtime, for determinism.
    const files = await this.listSessionFiles();
    for (const rel of files) {
      const doc = await this.store.readJson<{ id?: string; updatedAt?: string }>(rel);
      if (!doc) continue;
      const ts = doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
      if (now - ts > ttlMs) {
        await this.store.remove(rel);
        expired.push(doc.id ?? rel);
      }
    }
    return expired;
  }

  private async listSessionFiles(): Promise<string[]> {
    // The storage adapter has no directory listing in its interface, so we scan
    // via a manifest the engine maintains. If absent, nothing to expire.
    const manifest = await this.store.readJson<{ files: string[] }>(
      `${SESSIONS_DIR}/manifest.json`,
    );
    return manifest?.files ?? [];
  }

  private async flagMemoryForReverify(reverifyDays: number, now: number): Promise<string[]> {
    // Same lock as every MemoryManager mutation: load+mutate+rewrite must be a
    // single critical section or a concurrent record between load and rewrite
    // is silently lost.
    const release = await this.store.acquireLock("memory");
    try {
      const cutoff = now - reverifyDays * 86_400_000;
      const { entries } = await this.memoryRepo.loadAll();
      const flagged: string[] = [];
      let changed = false;
      const DURABLE = new Set(["fact", "decision", "convention", "constraint"]);
      for (const e of entries) {
        if (e.status !== "active") continue;
        if (!DURABLE.has(e.kind)) continue;
        // Age is advisory: it marks an entry for re-verification but never
        // demotes it. Re-running the sweep must not move an existing marker.
        if (e.needsReverifyAt) continue;
        const ref = e.lastVerifiedAt ?? e.updatedAt;
        const refMs = new Date(ref).getTime();
        if (refMs < cutoff) {
          (e as MemoryEntry).needsReverifyAt = new Date(now).toISOString();
          flagged.push(e.id);
          changed = true;
        }
      }
      if (changed) await this.memoryRepo.rewriteAll(entries);
      return flagged;
    } finally {
      await release();
    }
  }

  private async trimCompleted(retentionDays: number, now: number): Promise<number> {
    const release = await this.store.acquireLock("task-outcomes");
    try {
    const cutoff = now - retentionDays * 86_400_000;
    const res = await this.store.readJsonl<TaskOutcome>(COMPLETED_FILE);
    if (res.entries.length === 0) return 0;
    const kept = res.entries.filter((o) => {
      const ts = o.recordedAt ? new Date(o.recordedAt).getTime() : now;
      return ts >= cutoff;
    });
    const removed = res.entries.length - kept.length;
    if (removed > 0) await this.store.rewriteJsonl(COMPLETED_FILE, kept);
    return removed;
    } finally { await release(); }
  }
}
