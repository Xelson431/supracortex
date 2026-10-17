/**
 * Stale-lock recovery must not spam stderr: one warning per lock dir per
 * process, no warning when the reclaim is a repeat, silence via env.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireFileLock, resetLockWarningsForTests } from "../../packages/core/src/storage/file-lock.ts";

async function staleLock(): Promise<{ dir: string; lockDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cortex-lockwarn-"));
  const lockDir = join(dir, "abc123.lock");
  await mkdir(lockDir);
  await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 999_999_999, token: "dead", at: new Date(0).toISOString() }));
  return { dir, lockDir };
}

async function warnedCount(fn: () => Promise<void>): Promise<number> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return lines.filter((l) => l.includes("broke stale lock")).length;
}

test("repeated reclaims of the same lock warn once per process", async () => {
  resetLockWarningsForTests();
  const n = await warnedCount(async () => {
    for (let i = 0; i < 3; i++) {
      const { lockDir } = await staleLock();
      const release = await acquireFileLock(lockDir, { staleMs: 10, timeoutMs: 2_000 });
      await release();
    }
  });
  // Three different lock dirs -> one line each, never stacked repeats.
  assert.equal(n, 3);
  const m = await warnedCount(async () => {
    const { lockDir } = await staleLock();
    // Same dir reclaimed twice in one process: second reclaim stays silent.
    const r1 = await acquireFileLock(lockDir, { staleMs: 10, timeoutMs: 2_000 });
    await r1();
    await mkdir(lockDir);
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 999_999_999, token: "dead2", at: new Date(0).toISOString() }));
    const r2 = await acquireFileLock(lockDir, { staleMs: 10, timeoutMs: 2_000 });
    await r2();
  });
  assert.equal(m, 1, "first reclaim of a lock warns; the repeat in the same process stays silent");
});

test("SUPRACORTEX_LOCK_WARNINGS=0 silences recovery warnings", async () => {
  resetLockWarningsForTests();
  process.env.SUPRACORTEX_LOCK_WARNINGS = "0";
  try {
    const n = await warnedCount(async () => {
      const { lockDir } = await staleLock();
      const release = await acquireFileLock(lockDir, { staleMs: 10, timeoutMs: 2_000 });
      await release();
    });
    assert.equal(n, 0);
  } finally {
    delete process.env.SUPRACORTEX_LOCK_WARNINGS;
  }
});
