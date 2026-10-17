/**
 * Lock garbage collector: force-quit sessions leave `state/*.lock` dirs
 * behind. The sweep removes dead owners' locks at session start, silently, so
 * later turns never trip over them mid-turn (and never print the stderr
 * warning that hides the host chatbox).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireFileLock, collectLockGarbage } from "../../packages/core/src/storage/file-lock.ts";

const LOCK = "abcdef0123456789.lock";

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cortex-lockgc-"));
  await mkdir(join(dir, "state"), { recursive: true });
  return join(dir, "state");
}

async function plant(state: string, name: string, meta: unknown, oldMtime = false): Promise<string> {
  const lockDir = join(state, name);
  await mkdir(lockDir, { recursive: true });
  if (meta !== null) await writeFile(join(lockDir, "owner.json"), JSON.stringify(meta));
  if (oldMtime) {
    const ancient = new Date(0);
    await utimes(lockDir, ancient, ancient);
  }
  return lockDir;
}

async function silentGc(state: string): Promise<{ removed: string[]; kept: string[]; warnings: number }> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  try {
    const r = await collectLockGarbage(state, { staleMs: 60_000 });
    return { ...r, warnings: warnings.filter((w) => w.includes("broke stale lock")).length };
  } finally {
    console.warn = orig;
  }
}

test("removes dead-owner locks silently, keeps live ones, ignores foreign dirs", async () => {
  const state = await stateDir();
  const deadPid = 999_999_999;
  await plant(state, LOCK, { pid: deadPid, token: "dead", at: new Date(0).toISOString() });
  // Live owner: our own pid with a matching start time is never collected.
  await plant(state, "1111111111111111.lock", {
    pid: process.pid,
    token: "live",
    at: new Date().toISOString(),
    ownerStartMs: Date.now() - process.uptime() * 1000,
  });
  // Foreign dirs are not lock dirs and must never be touched.
  await plant(state, "not-a-lock", { pid: deadPid });
  await plant(state, "random.lock", { pid: deadPid });
  // No-meta lock older than the threshold goes; a fresh one stays.
  await plant(state, "2222222222222222.lock", null, true);
  await plant(state, "3333333333333333.lock", null, false);

  const { removed, kept, warnings } = await silentGc(state);
  assert.deepEqual(removed.sort(), [LOCK, "2222222222222222.lock"].sort());
  assert.deepEqual(kept.sort(), ["1111111111111111.lock", "3333333333333333.lock"].sort());
  assert.equal(warnings, 0, "GC is silent; the acquire path owns the one warning");
  assert.equal(existsSync(join(state, LOCK)), false);
  assert.equal(existsSync(join(state, "not-a-lock")), true);
  assert.equal(existsSync(join(state, "random.lock")), true);
});

test("collects a recycled-PID lock (owner dead, pid reused by a live process)", async () => {
  const state = await stateDir();
  await plant(state, LOCK, {
    pid: process.pid,
    token: "crashed",
    at: new Date(0).toISOString(),
    // Our own pid, but a start time 10 minutes off: proves PID reuse.
    ownerStartMs: Date.now() - process.uptime() * 1000 - 600_000,
  });
  const { removed, warnings } = await silentGc(state);
  assert.deepEqual(removed, [LOCK]);
  assert.equal(warnings, 0);
});

test("after GC, acquiring the collected lock is warning-free", async () => {
  const state = await stateDir();
  await plant(state, LOCK, { pid: 999_999_999, token: "dead", at: new Date(0).toISOString() });
  await collectLockGarbage(state, { staleMs: 60_000 });
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  try {
    const release = await acquireFileLock(join(state, LOCK), { staleMs: 60_000, timeoutMs: 2_000 });
    await release();
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.filter((w) => w.includes("broke stale lock")).length, 0);
});

test("missing state dir is a clean no-op", async () => {
  const r = await collectLockGarbage(join(tmpdir(), "cortex-lockgc-missing-xyz"), {});
  assert.deepEqual(r, { removed: [], kept: [] });
});
