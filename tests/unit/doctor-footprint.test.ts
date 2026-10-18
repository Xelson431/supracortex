import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type FootprintFs,
  type FootprintReport,
  clean,
  computeStorageFootprint,
  footprintCheck,
  runDiagnostics,
} from "../../packages/core/src/diagnostics/index.ts";

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sc-foot-"));
}

/** Deterministic fake fs: dir -> names, file -> size. */
function fakeFs() {
  const dirs = new Map<string, string[]>();
  const sizes = new Map<string, number>();
  const statfsResult = { bsize: 4096, blocks: 1000, bavail: 400 }; // 60% used
  const fs: FootprintFs = {
    async readdir(dir) {
      return dirs.get(dir) ?? [];
    },
    async lstat(path) {
      if (sizes.has(path))
        return {
          size: sizes.get(path) ?? 0,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      for (const [d] of dirs) {
        if (d === path) return { size: 0, isDirectory: () => true, isSymbolicLink: () => false };
      }
      const e: NodeJS.ErrnoException = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    },
    statfs: () => statfsResult,
  };
  return { dirs, sizes, statfsResult, fs };
}

interface FootData {
  totalBytes: number;
  subdirs: Array<{ name: string; bytes: number }>;
  truncated: boolean;
  fs?: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
}
function data(check: unknown): FootData {
  const c = check as { data?: FootData };
  return c.data as FootData;
}

test("computeStorageFootprint sums bytes recursively and buckets by top-level subdir", async () => {
  const { dirs, sizes, fs } = fakeFs();
  const root = "/proj/.supracortex";
  dirs.set(root, ["events", "metrics", "config.json"]);
  dirs.set(join(root, "events"), ["events.jsonl", "sub"]);
  dirs.set(join(root, "events", "sub"), ["deep.bin"]);
  dirs.set(join(root, "metrics"), ["session-2024-01-01.json"]);
  sizes.set(join(root, "config.json"), 100);
  sizes.set(join(root, "events", "events.jsonl"), 1000);
  sizes.set(join(root, "events", "sub", "deep.bin"), 400);
  sizes.set(join(root, "metrics", "session-2024-01-01.json"), 200);

  const report = await computeStorageFootprint(root, fs);
  assert.equal(report.totalBytes, 1700);
  const events = report.subdirs.find((s) => s.name === "events");
  const metrics = report.subdirs.find((s) => s.name === "metrics");
  assert.ok(events);
  assert.equal(events.bytes, 1400);
  assert.ok(metrics);
  assert.equal(metrics.bytes, 200);
});

test("computeStorageFootprint tolerates a missing directory (reports 0)", async () => {
  const { fs } = fakeFs();
  const report = await computeStorageFootprint("/does/not/exist", fs);
  assert.equal(report.totalBytes, 0);
  assert.deepEqual(report.subdirs, []);
  assert.equal(report.truncated, false);
});

test("computeStorageFootprint caps the walk defensively and reports truncated", async () => {
  const { dirs, sizes, fs } = fakeFs();
  const root = "/proj/root";
  dirs.set(root, []);
  for (let i = 0; i < 10; i++) {
    const n = `f${i}`;
    (dirs.get(root) as string[]).push(n);
    sizes.set(join(root, n), 1);
  }
  const report = await computeStorageFootprint(root, fs, 5);
  assert.equal(report.totalBytes, 5);
  assert.equal(report.truncated, true);
});

test("footprintCheck status thresholds: pass <85, warn >=85, fail >=95", async () => {
  const mk = (bavail: number) => {
    const f = fakeFs();
    f.statfsResult.bavail = bavail;
    return footprintCheck("/x", "/", f.fs, 85, 95);
  };
  assert.equal((await mk(400)).status, "pass"); // 60% used
  assert.equal((await mk(100)).status, "warn"); // 90% used
  assert.equal((await mk(50)).status, "fail"); // 95% used
});

test("footprint status stays pass for huge size when disk is fine; reported fs math correct", async () => {
  const { dirs, sizes, fs, statfsResult } = fakeFs();
  dirs.set("/x", ["big.bin"]);
  sizes.set(join("/x", "big.bin"), 1 << 40);
  const check = await footprintCheck("/x", "/", fs, 85, 95);
  assert.equal(check.status, "pass");
  const d = data(check);
  assert.ok(d.totalBytes >= 1 << 40);
  assert.ok(d.fs);
  // statfs math: 60% used over 4096*1000=4,096,000 bytes
  assert.equal(d.fs.usedPercent, 60);
  assert.equal(d.fs.totalBytes, 4096000);
  assert.equal(d.fs.freeBytes, statfsResult.bavail * statfsResult.bsize);
});

test("real fs: size math correct and statfs is reported", async () => {
  const root = await project();
  try {
    const storage = join(root, ".supracortex");
    await mkdir(join(storage, "metrics"), { recursive: true });
    await writeFile(join(storage, "config.json"), "a".repeat(50), "utf8");
    await writeFile(join(storage, "metrics", "session.json"), "b".repeat(75), "utf8");
    const check = await footprintCheck(storage, root);
    assert.equal(check.id, "storage-footprint");
    const d = data(check);
    assert.equal(d.totalBytes, 125);
    assert.equal(d.subdirs.find((s) => s.name === "metrics")?.bytes, 75);
    assert.ok(d.fs && d.fs.totalBytes > 0, "statfs reports total bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDiagnostics includes a storage-footprint check", async () => {
  const root = await project();
  try {
    const storage = join(root, ".supracortex");
    await mkdir(storage, { recursive: true });
    await writeFile(join(storage, "a.bin"), "x".repeat(10), "utf8");
    const checks = await runDiagnostics({
      projectRoot: root,
      config: { storage: { directory: ".supracortex" } },
    });
    const foot = checks.find((c) => c.id === "storage-footprint");
    assert.ok(foot, "footprint check present");
    assert.ok(data(foot).totalBytes >= 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computeStorageFootprint never follows a symlink out of the root", async () => {
  const root = await project();
  const outside = await project();
  try {
    const inDir = join(root, "in");
    const outDir = join(outside, "out");
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    // A real file inside the root.
    await writeFile(join(inDir, "real.bin"), "y".repeat(500), "utf8");
    // A symlink inside the root pointing to a file outside the root.
    const outFile = join(outDir, "secret.bin");
    await writeFile(outFile, "z".repeat(90_000), "utf8");
    await symlink(outFile, join(inDir, "link.bin"));

    const report = await computeStorageFootprint(root);
    // The 90KB symlinked-over file must NOT be counted.
    assert.equal(report.totalBytes, 500);
    assert.equal(report.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("computeStorageFootprint tolerates statfs failure and degrades to fs:null, no fail", async () => {
  const { dirs, sizes, fs } = fakeFs();
  dirs.set("/x", ["data.bin"]);
  sizes.set(join("/x", "data.bin"), 4096);
  // statfs throws -> fs info null.
  fs.statfs = () => {
    throw new Error("ENOSYS");
  };
  const report = await computeStorageFootprint("/x", fs);
  assert.equal(report.totalBytes, 4096);
  assert.equal(report.fs, null);

  // footprintCheck must not throw and must not fail solely for missing statfs.
  const check = await footprintCheck("/x", "/", fs, 85, 95);
  assert.equal(check.status, "pass");
  const d = data(check);
  assert.equal(d.fs, null);
  // Size stays informational even with bytes present.
  assert.equal(d.totalBytes, 4096);
});

// ---------------------------------------------------------------------------
// Windows roots: clean() must never build a RegExp from the path.
// Before the fix a root ending in `\` produced `D:\(?=...)` and threw
// "Invalid regular expression ... Unmatched ')'".
// ---------------------------------------------------------------------------

test("clean handles Windows-style roots without building a RegExp from the path", () => {
  const driveRoot = `${String.raw`D:`}\\`; // String.raw`D:\` is not expressible directly
  const nestedRoot = String.raw`D:\a\repo`;
  const trailingRoot = `${nestedRoot}\\`;
  const metaRoot = String.raw`C:\a.b(c)\repo`;

  const cases: Array<[text: string, root: string, expected: string]> = [
    [String.raw`D:\src\a.ts`, driveRoot, "./src/a.ts"],
    [String.raw`D:\a\repo\src\b.ts`, nestedRoot, "./src/b.ts"],
    [String.raw`D:\a\repo\src\c.ts`, trailingRoot, "./src/c.ts"],
    [String.raw`C:\a.b(c)\repo\src\d.ts`, metaRoot, "./src/d.ts"],
  ];
  for (const [text, root, expected] of cases) {
    assert.doesNotThrow(() => clean(text, root), `root ${JSON.stringify(root)}`);
    assert.equal(clean(text, root), expected);
  }
});

test("clean does not replace a root that is only a prefix of another path", () => {
  // /project must not eat the leading segment of /project2.
  assert.equal(clean("/project2/src/a.ts", "/project"), "/project2/src/a.ts");
});

test("footprintCheck renders Windows-style subdir paths project-relative", async () => {
  const { dirs, sizes, fs } = fakeFs();
  const root = String.raw`D:\a\repo`;
  const storage = String.raw`D:\a\repo\.supracortex`;
  const winSubdir = String.raw`D:\a\repo\metrics`;
  const winFile = join(storage, winSubdir, "events.jsonl");
  dirs.set(storage, [winSubdir]);
  dirs.set(join(storage, winSubdir), ["events.jsonl"]);
  sizes.set(winFile, 128);

  const report = await computeStorageFootprint(storage, fs);
  assert.equal(report.totalBytes, 128);

  const check = await footprintCheck(storage, root, fs);
  assert.equal(check.status, "pass");
  assert.ok(check.detail.includes("./metrics=128"), check.detail);
  assert.ok(!check.detail.includes(root), "project root is not leaked");
});
