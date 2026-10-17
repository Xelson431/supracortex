/**
 * File-ownership planning and enforcement.
 *
 * Ownership prevents two concurrently-running tasks from writing the same file.
 * Claims are persisted so a crashed session can be reconciled. This is advisory
 * planning state; the host remains responsible for actual execution.
 */

import type { FileOwnership, OwnershipClaim, OwnershipClaimResult } from "../types.ts";
import type { StorageAdapter } from "../storage/storage-adapter.ts";
import { randomUUID } from "node:crypto";

const OWNERSHIP_FILE = "tasks/ownership.json";

export interface ClaimOptions {
  incarnationId?: string;
  sessionId?: string;
  /** TTL in minutes; when set, the claim carries an absolute expiry. */
  ttlMinutes?: number;
  now?: number;
}

/** Normalize legacy (path->string) or partial claim records into OwnershipClaim. */
function normalizeClaims(raw: unknown, nowIso: string): Record<string, OwnershipClaim> {
  const out: Record<string, OwnershipClaim> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      // Legacy format: path -> taskId.
      out[path] = { taskId: value, claimedAt: nowIso };
    } else if (value && typeof value === "object" && typeof (value as OwnershipClaim).taskId === "string") {
      const c = value as OwnershipClaim;
      out[path] = {
        taskId: c.taskId,
        ...(c.incarnationId ? { incarnationId: c.incarnationId } : {}),
        claimedAt: c.claimedAt ?? nowIso,
        ...(c.leaseId ? { leaseId: c.leaseId } : {}),
        ...(typeof c.fencingToken === "number" ? { fencingToken: c.fencingToken } : {}),
        ...(c.sessionId ? { sessionId: c.sessionId } : {}),
        ...(c.renewedAt ? { renewedAt: c.renewedAt } : {}),
        ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
      };
    }
  }
  return out;
}

export class OwnershipManager {
  private store: StorageAdapter;

  constructor(store: StorageAdapter) {
    this.store = store;
  }

  async load(now: number = Date.now()): Promise<FileOwnership> {
    const existing = await this.store.readJson<FileOwnership>(OWNERSHIP_FILE);
    const nowIso = new Date(now).toISOString();
    return {
      claims: normalizeClaims(existing?.claims, nowIso),
      updatedAt: existing?.updatedAt ?? nowIso,
      ...(typeof existing?.nextFencingToken === "number" ? { nextFencingToken: existing.nextFencingToken } : {}),
    };
  }

  async claim(taskId: string, files: string[], opts: ClaimOptions = {}): Promise<OwnershipClaimResult> {
    const now = opts.now ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const release = await this.store.acquireLock("ownership");
    try {
      const state = await this.load(now);
      const requested = Array.from(new Set(files));
      const denied: Array<{ path: string; heldBy: string }> = [];
      for (const f of requested) {
        const holder = state.claims[f];
        // A claim held by another LIVE (non-expired) task blocks. An expired
        // claim is silently taken over (self-healing).
        if (holder && holder.taskId !== taskId && !isExpired(holder, now)) {
          denied.push({ path: f, heldBy: holder.taskId });
        }
      }
      // Multi-file ownership is an atomic lease: a partial grant can leave a
      // worker believing it owns an unsafe subset of its intended write scope.
      if (denied.length) return { granted: [], denied };
      const leaseId = randomUUID();
      const fencingToken = Math.max(
        1,
        state.nextFencingToken ?? 1,
        ...Object.values(state.claims).map((claim) => (claim.fencingToken ?? 0) + 1),
      );
      for (const f of requested) {
        const claim: OwnershipClaim = { taskId, leaseId, fencingToken, claimedAt: nowIso, renewedAt: nowIso, ...(opts.incarnationId ? { incarnationId: opts.incarnationId } : {}) };
        if (opts.sessionId) claim.sessionId = opts.sessionId;
        if (opts.ttlMinutes && opts.ttlMinutes > 0) claim.expiresAt = new Date(now + opts.ttlMinutes * 60_000).toISOString();
        state.claims[f] = claim;
      }
      state.nextFencingToken = fencingToken + 1;
      state.updatedAt = nowIso;
      await this.store.writeJson(OWNERSHIP_FILE, state);
      return { granted: requested, denied: [], leaseId, fencingToken, ...(opts.incarnationId ? { incarnationId: opts.incarnationId } : {}) };
    } finally {
      await release();
    }
  }

  /**
   * Renew every live lease held by a task. An expired lease is deliberately
   * reported as lost rather than revived: another task may already have safely
   * taken it over. Session-bound claims also reject a mismatched session.
   */
  async renew(taskId: string, opts: ClaimOptions = {}): Promise<import("../types.ts").OwnershipRenewalResult> {
    const now = opts.now ?? Date.now();
    const nowIso = new Date(now).toISOString();
    const release = await this.store.acquireLock("ownership");
    try {
      const state = await this.load(now);
      const renewed: string[] = [];
      const lost: string[] = [];
      for (const [path, claim] of Object.entries(state.claims)) {
        if (claim.taskId !== taskId) continue;
        if (isExpired(claim, now) || (claim.sessionId && opts.sessionId && claim.sessionId !== opts.sessionId)) {
          lost.push(path);
          continue;
        }
        claim.renewedAt = nowIso;
        if (opts.ttlMinutes && opts.ttlMinutes > 0) {
          claim.expiresAt = new Date(now + opts.ttlMinutes * 60_000).toISOString();
        }
        renewed.push(path);
      }
      if (renewed.length) {
        state.updatedAt = nowIso;
        await this.store.writeJson(OWNERSHIP_FILE, state);
      }
      return { renewed, lost };
    } finally {
      await release();
    }
  }

  async release(taskId: string, files?: string[]): Promise<string[]> {
    const release = await this.store.acquireLock("ownership");
    try {
      return this.releaseUnlocked(taskId, files);
    } finally {
      await release();
    }
  }

  async releaseUnlocked(taskId: string, files?: string[]): Promise<string[]> {
      const state = await this.load();
      const released: string[] = [];
      for (const [path, claim] of Object.entries(state.claims)) {
        if (claim.taskId !== taskId) continue;
        if (!files || files.includes(path)) { delete state.claims[path]; released.push(path); }
      }
      state.updatedAt = new Date().toISOString();
      await this.store.writeJson(OWNERSHIP_FILE, state);
      return released;
  }

  async releaseIncarnation(taskId: string, incarnationId: string, files?: string[]): Promise<string[]> {
    const release = await this.store.acquireLock("ownership");
    try {
      return this.releaseIncarnationUnlocked(taskId, incarnationId, files);
    } finally { await release(); }
  }

  async releaseIncarnationUnlocked(taskId: string, incarnationId: string, files?: string[]): Promise<string[]> {
      const state = await this.load();
      const released: string[] = [];
      for (const [path, claim] of Object.entries(state.claims)) {
        if (claim.taskId === taskId && claim.incarnationId === incarnationId && (!files || files.includes(path))) {
          delete state.claims[path]; released.push(path);
        }
      }
      if (released.length) { state.updatedAt = new Date().toISOString(); await this.store.writeJson(OWNERSHIP_FILE, state); }
      return released;
  }

  /**
   * Fenced release for cooperating callers. A stale lease ID or fencing token
   * is a no-op, so an old worker cannot release a successor's paths.
   */
  async releaseLease(
    taskId: string,
    leaseId: string,
    fencingToken: number,
    files?: string[],
  ): Promise<string[]> {
    const release = await this.store.acquireLock("ownership");
    try {
      const state = await this.load();
      const released: string[] = [];
      for (const [path, claim] of Object.entries(state.claims)) {
        if (claim.taskId !== taskId || claim.leaseId !== leaseId || claim.fencingToken !== fencingToken) continue;
        if (!files || files.includes(path)) {
          delete state.claims[path];
          released.push(path);
        }
      }
      if (released.length) {
        state.updatedAt = new Date().toISOString();
        await this.store.writeJson(OWNERSHIP_FILE, state);
      }
      return released;
    } finally {
      await release();
    }
  }

  /**
   * Release any claim that is expired, or whose owning task/session is not in
   * the provided live sets. Returns released paths. Idempotent.
   */
  async reap(
    liveTaskIds: Set<string>,
    liveSessionIds: Set<string> | null,
    now: number = Date.now(),
  ): Promise<string[]> {
    const release = await this.store.acquireLock("ownership");
    try {
      const state = await this.load(now);
      const released: string[] = [];
      for (const [path, claim] of Object.entries(state.claims)) {
        const expired = isExpired(claim, now);
        const taskDead = !liveTaskIds.has(claim.taskId);
        const sessionDead =
          liveSessionIds !== null && claim.sessionId != null && !liveSessionIds.has(claim.sessionId);
        if (expired || taskDead || sessionDead) {
          delete state.claims[path];
          released.push(path);
        }
      }
      if (released.length) {
        state.updatedAt = new Date(now).toISOString();
        await this.store.writeJson(OWNERSHIP_FILE, state);
      }
      return released;
    } finally {
      await release();
    }
  }

  /** Remove all claims (used on reset / reconcile). */
  async clear(): Promise<void> {
    await this.store.writeJson(OWNERSHIP_FILE, {
      claims: {},
      updatedAt: new Date().toISOString(),
    });
  }
}

function isExpired(claim: OwnershipClaim, now: number): boolean {
  return claim.expiresAt != null && new Date(claim.expiresAt).getTime() <= now;
}

/**
 * Compute a non-conflicting ownership assignment for a wave of tasks. Returns
 * which files each task should own and any conflicts that force serialization.
 */
export function planOwnership(
  wave: Array<{ id: string; writeScope: string[] }>,
): { assignments: Record<string, string[]>; conflicts: Array<{ path: string; taskIds: string[] }> } {
  const owner = new Map<string, string>();
  const assignments: Record<string, string[]> = {};
  const conflictMap = new Map<string, string[]>();

  for (const t of wave) {
    const owned: string[] = [];
    assignments[t.id] = owned;
    for (const f of t.writeScope) {
      const existing = owner.get(f);
      if (existing == null) {
        owner.set(f, t.id);
        owned.push(f);
      } else {
        const list = conflictMap.get(f) ?? [existing];
        list.push(t.id);
        conflictMap.set(f, list);
      }
    }
  }

  const conflicts = Array.from(conflictMap.entries()).map(([path, taskIds]) => ({
    path,
    taskIds: Array.from(new Set(taskIds)),
  }));
  return { assignments, conflicts };
}
