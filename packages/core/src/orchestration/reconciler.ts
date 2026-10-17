/**
 * Reconciler: tracks active tasks (with heartbeats) and reconciles ownership
 * against live state. Used opportunistically (engine init, session.idle,
 * session.deleted) to release stale ownership and reap abandoned tasks.
 *
 * Planning/bookkeeping only. Never touches project source files.
 * Global lock order: active-tasks -> ownership -> task-outcomes.
 */

import type { ActiveTaskRecord, TaskOutcome } from "../types.ts";
import type { StorageAdapter } from "../storage/storage-adapter.ts";
import { OwnershipManager } from "./ownership.ts";
import { randomUUID } from "node:crypto";

const ACTIVE_FILE = "tasks/active.json";
const COMPLETED_FILE = "tasks/completed.jsonl";

export interface ActiveTasksFile {
  tasks: ActiveTaskRecord[];
  updatedAt: string;
}

/** Migrate legacy { taskIds: string[] } shape into the record model.
 * `fallbackIso` is used for entries lacking their own timestamps — we prefer the
 * container's updatedAt over "now" so migrated legacy state ages correctly and
 * can be reaped rather than getting an indefinite grace window. */
function normalizeActive(raw: unknown, fallbackIso: string): ActiveTaskRecord[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const containerTs = typeof obj.updatedAt === "string" ? obj.updatedAt : fallbackIso;
  if (Array.isArray(obj.tasks)) {
    return (obj.tasks as unknown[])
      .filter((t): t is ActiveTaskRecord => !!t && typeof (t as ActiveTaskRecord).taskId === "string")
      .map((t) => ({
        taskId: t.taskId,
        ...(typeof t.incarnationId === "string" ? { incarnationId: t.incarnationId } : {}),
        startedAt: t.startedAt ?? containerTs,
        lastSeenAt: t.lastSeenAt ?? t.startedAt ?? containerTs,
        ...(t.sessionId ? { sessionId: t.sessionId } : {}),
        ...(t.title ? { title: t.title } : {}),
      }));
  }
  if (Array.isArray(obj.taskIds)) {
    return (obj.taskIds as unknown[])
      .filter((id): id is string => typeof id === "string")
      .map((id) => ({ taskId: id, startedAt: containerTs, lastSeenAt: containerTs }));
  }
  return [];
}

export class Reconciler {
  private store: StorageAdapter;
  private ownership: OwnershipManager;

  constructor(store: StorageAdapter) {
    this.store = store;
    this.ownership = new OwnershipManager(store);
  }

  private mint(taskId: string, nowIso: string, meta: { sessionId?: string; title?: string } = {}): ActiveTaskRecord {
    return { taskId, incarnationId: randomUUID(), startedAt: nowIso, lastSeenAt: nowIso,
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}), ...(meta.title ? { title: meta.title } : {}) };
  }

  async loadActive(now: number = Date.now()): Promise<ActiveTaskRecord[]> {
    const raw = await this.store.readJson<unknown>(ACTIVE_FILE);
    return normalizeActive(raw, new Date(now).toISOString());
  }

  private async saveActive(tasks: ActiveTaskRecord[], now: number = Date.now()): Promise<void> {
    await this.store.writeJson(ACTIVE_FILE, {
      tasks,
      updatedAt: new Date(now).toISOString(),
    } satisfies ActiveTasksFile);
  }

  /** Mark a task active (or refresh its heartbeat). Idempotent per taskId.
   *
   * `mint` controls whether a missing task is registered. The heartbeat path
   * passes `mint: false` so a task that was deliberately reaped is never
   * resurrected by a queued heartbeat that ran after the reap's destructive
   * act. Only explicit registration (claimFiles/planner) may create a record,
   * so the reap's serialized outcome cannot be undone by a stale heartbeat.
   */
  async touch(
    taskId: string,
    meta: { sessionId?: string; title?: string } = {},
    now: number = Date.now(),
    opts: { mint?: boolean } = {},
  ): Promise<void> {
    const release = await this.store.acquireLock("active-tasks");
    try {
      const nowIso = new Date(now).toISOString();
      const tasks = await this.loadActive(now);
      const existing = tasks.find((t) => t.taskId === taskId);
      if (existing) {
        existing.lastSeenAt = nowIso;
        if (meta.sessionId) existing.sessionId = meta.sessionId;
        if (meta.title) existing.title = meta.title;
        await this.saveActive(tasks, now);
      } else if (opts.mint !== false) {
        tasks.push(this.mint(taskId, nowIso, meta));
        await this.saveActive(tasks, now);
      }
    } finally {
      await release();
    }
  }

  /** Replace the entire active set (used by planner). */
  async markActive(taskIds: string[], sessionId?: string, now: number = Date.now()): Promise<void> {
    const release = await this.store.acquireLock("active-tasks");
    try {
      const nowIso = new Date(now).toISOString();
      const existing = await this.loadActive(now);
      const byId = new Map(existing.map((t) => [t.taskId, t]));
      const tasks: ActiveTaskRecord[] = taskIds.map((id) => {
        const prev = byId.get(id);
        return {
          taskId: id,
          incarnationId: prev?.incarnationId ?? this.mint(id, nowIso).incarnationId,
          startedAt: prev?.startedAt ?? nowIso,
          lastSeenAt: nowIso,
          ...(sessionId ? { sessionId } : prev?.sessionId ? { sessionId: prev.sessionId } : {}),
          ...(prev?.title ? { title: prev.title } : {}),
        };
      });
      await this.saveActive(tasks, now);
    } finally {
      await release();
    }
  }

  async recordOutcome(
    outcome: TaskOutcome,
    now: number = Date.now(),
  ): Promise<{ recorded: boolean; operationId: string }> {
    if (!outcome.operationId) throw new Error("task outcome requires an operationId");
    let recorded: boolean;
    const activeLock = await this.store.acquireLock("active-tasks");
    try {
      const current = (await this.loadActive(now)).find((t) => t.taskId === outcome.taskId);
      const allowed = current && (current.incarnationId === undefined
        ? outcome.incarnationId === undefined
        : outcome.incarnationId === current.incarnationId);
      const ownershipLock = await this.store.acquireLock("ownership");
      try {
        const outcomeLock = await this.store.acquireLock("task-outcomes");
        try {
          const completed = await this.store.readJsonl<TaskOutcome>(COMPLETED_FILE);
          recorded = !completed.entries.some((entry) => entry.taskId === outcome.taskId &&
            (outcome.incarnationId !== undefined ? entry.incarnationId === outcome.incarnationId : entry.incarnationId === undefined));
          if (recorded) await this.store.appendJsonl(COMPLETED_FILE, [outcome]);
        } finally { await outcomeLock(); }
        // Persist first, then perform replayable fenced cleanup. A modern
        // taskId-only outcome is intentionally recorded but not destructive.
        if (allowed && current) {
          if (current.incarnationId) await this.ownership.releaseIncarnationUnlocked(outcome.taskId, current.incarnationId);
          else await this.ownership.releaseUnlocked(outcome.taskId);
          const latest = await this.loadActive(now);
          const stillCurrent = latest.find((t) => t.taskId === outcome.taskId);
          if (stillCurrent && (current.incarnationId === undefined || stillCurrent.incarnationId === current.incarnationId)) {
            await this.saveActive(latest.filter((t) => t.taskId !== outcome.taskId ||
              (current.incarnationId !== undefined && t.incarnationId !== current.incarnationId)), now);
          }
        }
      } finally { await ownershipLock(); }
    } finally { await activeLock(); }
    return { recorded, operationId: outcome.operationId };
  }

  async activeCount(now: number = Date.now()): Promise<number> {
    return (await this.loadActive(now)).length;
  }

  async liveTaskIds(now: number = Date.now()): Promise<Set<string>> {
    return new Set((await this.loadActive(now)).map((t) => t.taskId));
  }

  async completedOutcomes(): Promise<TaskOutcome[]> {
    const res = await this.store.readJsonl<TaskOutcome>(COMPLETED_FILE);
    return res.entries;
  }

  /**
   * Reap tasks whose heartbeat is older than the timeout, and release the
   * ownership they held. Returns abandoned task ids + released paths. Idempotent.
   */
  async reapAbandonedTasks(
    heartbeatTimeoutMs: number,
    liveSessionIds: Set<string> | null,
    now: number = Date.now(),
    opts: { automaticOutcomeRecording?: boolean; terminalSessionId?: string; censusComplete?: boolean } = {},
  ): Promise<{ abandoned: string[]; released: string[] }> {
    const snapshot = await this.loadActive(now);
    const candidates = snapshot.filter((t) =>
      (heartbeatTimeoutMs > 0 && now - new Date(t.lastSeenAt).getTime() > heartbeatTimeoutMs) ||
      (opts.censusComplete === true && liveSessionIds !== null && t.sessionId !== undefined && !liveSessionIds.has(t.sessionId)) ||
      (opts.terminalSessionId !== undefined && t.sessionId === opts.terminalSessionId));
    const abandoned: string[] = [];
    const released: string[] = [];
    for (const candidate of candidates) {
      const lock = await this.store.acquireLock("active-tasks");
      try {
        const current = (await this.loadActive(now)).find((t) => t.taskId === candidate.taskId);
        if (!current || current.incarnationId !== candidate.incarnationId || current.lastSeenAt !== candidate.lastSeenAt) continue;
        // Keep active-tasks held from this revalidation through persistence and
        // both destructive cleanup steps. Ownership helpers are deliberately
        // unlocked variants because ownership is nested under this lock.
        const ownershipLock = await this.store.acquireLock("ownership");
        try {
          const completed = await this.store.readJsonl<TaskOutcome>(COMPLETED_FILE);
          const existing = completed.entries.find((e) => e.taskId === candidate.taskId &&
            (candidate.incarnationId === undefined ? e.incarnationId === undefined : e.incarnationId === candidate.incarnationId));
          const ttlExpired = heartbeatTimeoutMs > 0 && now - new Date(candidate.lastSeenAt).getTime() > heartbeatTimeoutMs;
          const terminal = opts.terminalSessionId !== undefined && candidate.sessionId === opts.terminalSessionId;
          const absentFromLiveSet = opts.censusComplete === true && liveSessionIds !== null && candidate.sessionId !== undefined && !liveSessionIds.has(candidate.sessionId);
          if (absentFromLiveSet && !ttlExpired && !terminal) {
            released.push(...(candidate.incarnationId
              ? await this.ownership.releaseIncarnationUnlocked(candidate.taskId, candidate.incarnationId)
              : await this.ownership.releaseUnlocked(candidate.taskId)));
            await this.saveActive((await this.loadActive(now)).filter((t) => t.taskId !== candidate.taskId || t.incarnationId !== candidate.incarnationId), now);
            abandoned.push(candidate.taskId);
            continue;
          }
          if (opts.automaticOutcomeRecording === false) continue;
          const inferred: TaskOutcome = existing ?? {
            taskId: candidate.taskId, incarnationId: candidate.incarnationId, source: "inferred",
            status: "partial", summary: "Task ended without an explicit outcome.", touchedFiles: [], learnings: [],
            recordedAt: new Date(now).toISOString(),
          };
          if (!existing) {
            const outcomeLock = await this.store.acquireLock("task-outcomes");
            try { await this.store.appendJsonl(COMPLETED_FILE, [inferred]); } finally { await outcomeLock(); }
          }
          released.push(...(candidate.incarnationId
            ? await this.ownership.releaseIncarnationUnlocked(candidate.taskId, candidate.incarnationId)
            : await this.ownership.releaseUnlocked(candidate.taskId)));
          await this.saveActive((await this.loadActive(now)).filter((t) => t.taskId !== candidate.taskId || t.incarnationId !== candidate.incarnationId), now);
          abandoned.push(candidate.taskId);
        } finally { await ownershipLock(); }
      } finally { await lock(); }
    }
    const active = await this.loadActive(now);
    released.push(...await this.ownership.reap(new Set(active.map((t) => t.taskId)), null, now));
    return { abandoned, released };
  }

  /** Release ownership for tasks no longer active (crash recovery). Idempotent. */
  async reconcileOwnership(now: number = Date.now()): Promise<{ released: string[] }> {
    const liveIds = await this.liveTaskIds(now);
    const released = await this.ownership.reap(liveIds, null, now);
    return { released };
  }
}
