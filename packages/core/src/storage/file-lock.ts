/**
 * Best-effort advisory file lock using atomic directory creation (mkdir is
 * atomic on POSIX and Windows). A lock is reclaimed only when its owner is
 * provably dead (or its owner record is missing/corrupt and it is old).
 *
 * This is intentionally not a hard guarantee across networked filesystems; it
 * prevents concurrent writers within a single machine and recovers from crashes.
 * Higher-level locks follow: active-tasks -> ownership -> task-outcomes, then
 * the leaf lock `value-metrics` (may be acquired while a higher lock is held;
 * while it is held, no other lock may be acquired).
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LockOptions {
  staleMs?: number;
  /** Milliseconds between acquire attempts. */
  retryMs?: number;
  /** Max total time to wait before giving up. */
  timeoutMs?: number;
}

const DEFAULT_STALE_MS = 120_000;
const DEFAULT_RETRY_MS = 15;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 200;
/** Transient SQLite errors worth retrying with backoff (multi-agent races). */
const TRANSIENT_SQLITE_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CANTOPEN",
  "SQLITE_PROTOCOL",
  "SQLITE_IOERR",
]);

/** True for SQLite errors that are transient under multi-process contention. */
export function isTransientStorageError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code && TRANSIENT_SQLITE_CODES.has(code)) return true;
  const msg = String((err as { message?: string })?.message ?? err);
  return /SQLITE_(BUSY|LOCKED|CANTOPEN|PROTOCOL|IOERR)/.test(msg);
}

export interface TransientRetryOptions {
  retries?: number;
  retryMs?: number;
  timeoutMs?: number;
}

/**
 * Retry `fn` on transient SQLite contention errors with jittered exponential
 * backoff (no busy-loop). Non-transient errors propagate immediately.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: TransientRetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 8;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientStorageError(err) || attempt >= retries || Date.now() >= deadline) throw err;
      attempt++;
      const base = Math.min(MAX_BACKOFF_MS, retryMs * 2 ** Math.min(attempt, 6));
      await sleep(Math.min(Math.max(1, Math.floor(base * (0.5 + Math.random()))), Math.max(1, deadline - Date.now())));
    }
  }
}

/** Wall-clock start of this process; stored in owner.json as a PID-reuse guard. */
function ownProcessStartMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/**
 * One stale-lock recovery already prints a line to stderr, and the host TUI
 * renders stderr as an overlay that hides the chatbox. A single turn touches
 * several locks (summary-cache, memory, events, …), so without dedupe one
 * crashed session produces a stack of identical lines on every later run.
 * Warn at most once per lock dir per process; the recovery itself is
 * unchanged. `SUPRACORTEX_LOCK_WARNINGS=0` silences entirely.
 */
const warnedLocks = new Set<string>();
function warnOnce(lockDir: string, msg: string): void {
  if (process.env.SUPRACORTEX_LOCK_WARNINGS === "0") return;
  if (warnedLocks.has(lockDir)) return;
  warnedLocks.add(lockDir);
  console.warn(msg);
}

/** Test seam: clear the per-process warning dedupe. */
export function resetLockWarningsForTests(): void {
  warnedLocks.clear();
}

/** Remove the lock dir; return false if it is still there afterwards. */
async function removeLockDir(lockDir: string): Promise<boolean> {
  await rm(lockDir, { recursive: true, force: true });
  try {
    await stat(lockDir);
    return false;
  } catch {
    return true;
  }
}

/**
 * Best-effort start time of another PID. Linux: /proc/<pid> dir mtime.
 * Others: `ps -o etime` (elapsed wall time, immune to the TZ/DST skew that
 * makes `lstart` + Date.parse disagree with Date.now() by hours in some
 * environments). Returns undefined when unknowable, in which case callers
 * must NOT treat a PID match as proof of reuse (fail closed).
 */
function otherProcessStartMs(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      // /proc/<pid> mtime approximates process start; sync stat keeps the
      // reclaim path simple (single stat, no async race).
      return statSync(`/proc/${pid}`).mtimeMs;
    } catch {
      return undefined;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
    const elapsedMs = parseEtimeMs(out);
    return elapsedMs == null ? undefined : Date.now() - elapsedMs;
  } catch {
    return undefined;
  }
}

/** Parse `ps -o etime` (`[[dd-]hh:]mm:ss[.cc]`) into elapsed milliseconds. */
function parseEtimeMs(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(s);
  if (!m) return undefined;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const secs = Number(m[4] ?? 0);
  if ([days, hours, mins, secs].some((n) => !Number.isFinite(n))) return undefined;
  return ((days * 24 + hours) * 60 + mins) * 60_000 + secs * 1000;
}

/** Best-effort liveness probe: signal 0 checks existence without killing. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not ours (alive).
    return (err as { code?: string }).code === "EPERM";
  }
}

export async function acquireFileLock(
  lockDir: string,
  opts: LockOptions = {},
): Promise<() => Promise<void>> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const metaPath = join(lockDir, "owner.json");
  const deadline = Date.now() + timeoutMs;
  // Unique token per acquisition; release only removes the lock we still own.
  // ownerStartMs guards against PID reuse: a recycled PID with a mismatched
  // start time is not the original owner.
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerStartMs = ownProcessStartMs();
  let attempt = 0;
  let lastOwner = "unknown";

  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      await writeFile(
        metaPath,
        JSON.stringify({ pid: process.pid, token, at: new Date().toISOString(), ownerStartMs }),
        "utf8",
      );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        // Only remove if we still own it (a stale-reclaim may have handed the
        // lock to another owner; do not delete theirs).
        try {
          const raw = await readFile(metaPath, "utf8");
          const meta = JSON.parse(raw) as { token?: string };
          if (meta.token && meta.token !== token) return;
        } catch {
          // Missing/corrupt meta: fall through and remove.
        }
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      // ENOENT here means our freshly mkdir'd lock dir was concurrently
      // removed (a legit stale-break racing our acquire): treat as contention
      // and retry within the deadline rather than failing the writer.
      if (!isEexist(err) && !isEnoent(err)) throw err;
      // Lock exists. Never steal a proven-live writer merely because a long
      // operation exceeded an arbitrary age threshold.
      const reclaimed = await reclaimIfStale(lockDir, metaPath, staleMs);
      if (!reclaimed) {
        lastOwner = await describeOwner(metaPath);
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring lock at ${lockDir} (held by ${lastOwner})`);
        }
        // Jittered, capped exponential backoff to avoid thundering-herd
        // starvation under heavy contention (fairness through randomization).
        attempt++;
        const base = Math.min(MAX_BACKOFF_MS, retryMs * 2 ** Math.min(attempt, 6));
        const wait = Math.max(1, Math.floor(base * (0.5 + Math.random())));
        await sleep(Math.min(wait, Math.max(1, deadline - Date.now())));
      }
    }
  }
}

/**
 * Decide whether a lock dir is abandoned, without touching anything. Single
 * source of truth for both the acquire path (reclaimIfStale) and the garbage
 * collector (collectLockGarbage), so the two can never disagree about what
 * "provably dead owner" means.
 */
async function classifyLock(
  lockDir: string,
  metaPath: string,
  staleMs: number,
): Promise<{ reclaimable: boolean; reason: string }> {
  const dead = (reason: string) => ({ reclaimable: true as const, reason });
  const live = (reason: string) => ({ reclaimable: false as const, reason });
  try {
    const st = await stat(lockDir);
    let ageMs = Date.now() - st.mtimeMs;
    let pid: number | undefined;
    let ownerStartMs: number | undefined;
    try {
      const raw = await readFile(metaPath, "utf8");
      const meta = JSON.parse(raw) as { at?: string; pid?: number; ownerStartMs?: number };
      if (meta.at) ageMs = Date.now() - new Date(meta.at).getTime();
      pid = meta.pid;
      ownerStartMs = meta.ownerStartMs;
    } catch {
      // Missing/corrupt meta: fall back to dir mtime age.
    }
    // A known live process is authoritative. `staleMs` only recovers an
    // abandoned lock with no trustworthy owner record.
    if (pid != null) {
      if (isProcessAlive(pid)) {
        // PID-reuse guard: a recycled PID has a different start time than the
        // recorded owner, so the lock is abandoned, not live.
        if (ownerStartMs != null) {
          const actual = otherProcessStartMs(pid);
          if (actual != null && Math.abs(actual - ownerStartMs) > 60_000) {
            return dead(`pid ${pid} reused (owner dead)`);
          }
        }
        return live(`held by live pid ${pid}`);
      }
      return dead(`owner pid ${pid} dead`);
    }
    if (ageMs > staleMs) return dead(`no owner record, age ${Math.round(ageMs)}ms`);
    return live(`no owner record, age ${Math.round(ageMs)}ms < stale threshold`);
  } catch {
    // Dir vanished mid-classification: nothing to reclaim.
    return live("lock dir vanished");
  }
}

async function reclaimIfStale(lockDir: string, metaPath: string, staleMs: number): Promise<boolean> {
  const verdict = await classifyLock(lockDir, metaPath, staleMs);
  if (!verdict.reclaimable) {
    // Vanished dir races a concurrent acquire: the mkdir retry below sorts it
    // out, so report reclaimable (the old code returned true here too).
    try {
      await stat(lockDir);
    } catch {
      return true;
    }
    return false;
  }
  if (!(await removeLockDir(lockDir))) return false;
  warnOnce(lockDir, `[storage] broke stale lock at ${lockDir}: ${verdict.reason}`);
  return true;
}

/** Lock dirs are driver-hashed (`<sha256hex[0:16]>.lock`); never touch anything else. */
const LOCK_DIR_RE = /^[0-9a-f]{16}\.lock$/;

export interface LockGarbageReport {
  /** Lock dir basenames removed (owners provably dead). */
  removed: string[];
  /** Lock dir basenames left alone (live owner or too young). */
  kept: string[];
}

/**
 * Garbage-collect abandoned lock dirs under a storage `state/` directory.
 * This is the force-quit cleanup: SIGKILL'd sessions can never release their
 * locks, so the sweep removes dead owners' locks at session start (and on
 * every sweep) instead of each writer tripping over them mid-turn.
 *
 * Silent by design — no stderr warnings. The acquire path still warns once
 * per lock per process on the rare live race the GC didn't get to first.
 * Uses the same classifier as the acquire path, so liveness guarantees are
 * identical: a lock is removed only when its owner is provably dead.
 */
export async function collectLockGarbage(
  stateDir: string,
  opts: { staleMs?: number } = {},
): Promise<LockGarbageReport> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const report: LockGarbageReport = { removed: [], kept: [] };
  let names: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    names = await readdir(stateDir);
  } catch {
    return report;
  }
  for (const name of names) {
    if (!LOCK_DIR_RE.test(name)) continue;
    const lockDir = join(stateDir, name);
    const verdict = await classifyLock(lockDir, join(lockDir, "owner.json"), staleMs);
    if (!verdict.reclaimable) {
      report.kept.push(name);
      continue;
    }
    if (await removeLockDir(lockDir)) report.removed.push(name);
    else report.kept.push(name);
  }
  return report;
}

async function describeOwner(metaPath: string): Promise<string> {
  try {
    const raw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as { pid?: number; at?: string };
    return `live pid ${meta.pid ?? "?"} since ${meta.at ?? "?"}`;
  } catch {
    return "unknown owner";
  }
}

export async function isLockStale(lockDir: string, staleMs = DEFAULT_STALE_MS): Promise<boolean> {
  try {
    const st = await stat(lockDir);
    return Date.now() - st.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "EEXIST";
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
