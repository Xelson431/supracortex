import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type PruneFs,
  pruneSessionMetrics,
  sessionFileDate,
} from "../../packages/core/src/metrics/session-prune.ts";

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sc-prune-"));
}

/** In-memory fs so we don't rely on timestamps or real deletion for correctness of selection. */
function memoryFs(): { fs: PruneFs; files: Map<string, string>; calls: { rm: string[] } } {
  const files = new Map<string, string>();
  const calls = { rm: [] as string[] };
  const fs: PruneFs = {
    async readdir(dir) {
      return [...files.keys()].map((p) => p.split("/").pop() as string);
    },
    async lstat(path) {
      if (files.has(path)) {
        return { isFile: () => true, isSymbolicLink: () => false };
      }
      const e: NodeJS.ErrnoException = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    },
    async rm(path, _opts) {
      calls.rm.push(path);
    },
  };
  return { fs, files, calls };
}

test("sessionFileDate parses valid names and rejects non-matching/implausible names", () => {
  assert.equal(
    sessionFileDate("session-2024-01-15.json")?.toISOString().slice(0, 10),
    "2024-01-15",
  );
  assert.equal(sessionFileDate("session-2024-13-01.json"), null); // month 13
  assert.equal(sessionFileDate("session-2024-02-30.json"), null); // impossible day
  assert.equal(sessionFileDate("session-2024-01-15.txt"), null);
  assert.equal(sessionFileDate("notes.json"), null);
  assert.equal(sessionFileDate("other-2024-01-15.json"), null);
});

test("prune deletes only session files older than retentionDays", () => {
  const { fs, calls, files } = memoryFs();
  const now = Date.UTC(2024, 0, 20, 0, 0, 0); // 2024-01-20
  const metricsDir = "/metrics";
  const names = [
    "session-2023-01-01.json",
    "session-2023-07-01.json",
    "session-2023-12-31.json",
    "session-2024-01-19.json",
    "session-2024-01-20.json",
    "notes.json",
    "session-bad.json",
  ];
  for (const n of names) files.set(join(metricsDir, n), "");
  fs.readdir = async () => names;
  return pruneSessionMetrics({ metricsDir, retentionDays: 90, now, fs }).then((result) => {
    assert.deepEqual([...result.deleted].sort(), [
      "session-2023-01-01.json",
      "session-2023-07-01.json",
    ]);
    assert.equal(result.considered, 5);
    assert.equal(calls.rm.length, 2);
  });
});

test("prune keeps all session files when retentionDays is 0 or negative", () => {
  const { fs, calls } = memoryFs();
  fs.readdir = async () => ["session-2022-01-01.json", "session-2021-01-01.json"];
  return pruneSessionMetrics({
    metricsDir: "/metrics",
    retentionDays: 0,
    now: Date.UTC(2024, 0, 1),
    fs,
  })
    .then((r0) => {
      assert.equal(r0.deleted.length, 0);
      assert.equal(r0.considered, 0);
      assert.equal(calls.rm.length, 0);
      return pruneSessionMetrics({
        metricsDir: "/metrics",
        retentionDays: -5,
        now: Date.UTC(2024, 0, 1),
        fs,
      });
    })
    .then((rn) => {
      assert.equal(rn.deleted.length, 0);
      assert.equal(rn.considered, 0);
      assert.equal(calls.rm.length, 0);
    });
});

test("prune tolerates a missing / unreadable metrics dir without throwing", () => {
  const fs: PruneFs = {
    async readdir() {
      const e: NodeJS.ErrnoException = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    },
    async lstat() {
      throw new Error("never called");
    },
    async rm(path, _opts) {
      throw new Error("never called");
    },
  };
  return pruneSessionMetrics({
    metricsDir: "/does-not-exist",
    retentionDays: 90,
    now: Date.now(),
    fs,
  }).then((r) => {
    assert.deepEqual(r.deleted, []);
    assert.equal(r.considered, 0);
  });
});

test("prune never throws on a per-file removal failure", () => {
  const { fs, files } = memoryFs();
  const metricsDir = "/metrics";
  files.set(join(metricsDir, "session-2023-01-01.json"), "");
  fs.readdir = async () => ["session-2023-01-01.json"];
  fs.rm = async (_p, _o) => {
    throw new Error("EACCES");
  };
  return pruneSessionMetrics({
    metricsDir,
    retentionDays: 90,
    now: Date.UTC(2024, 0, 1),
    fs,
    logger: { debug: () => {} },
  }).then((r) => {
    assert.equal(r.deleted.length, 0);
    assert.equal(r.considered, 1);
  });
});

test("real fs integration: writes old files, deletes them, keeps new ones", async () => {
  const root = await project();
  const metricsDir = join(root, "metrics");
  try {
    await mkdir(metricsDir, { recursive: true });
    const now = new Date("2024-06-01T00:00:00Z").getTime();
    await writeFile(join(metricsDir, "session-2024-01-01.json"), "old", "utf8");
    await writeFile(
      join(metricsDir, "session-2024-05-01.json"),
      "older-but-retained-31d?no-keep",
      "utf8",
    );
    await writeFile(join(metricsDir, "session-2024-05-31.json"), "recent", "utf8");
    await writeFile(join(metricsDir, "session-2024-06-01.json"), "today", "utf8");
    await writeFile(join(metricsDir, "notes.txt"), "unrelated", "utf8");

    const r = await pruneSessionMetrics({ metricsDir, retentionDays: 15, now });
    assert.deepEqual(
      r.deleted.sort(),
      ["session-2024-05-01.json", "session-2024-01-01.json"].sort(),
    );

    const remaining = (await readdir(metricsDir)).sort();
    assert.deepEqual(
      remaining,
      ["notes.txt", "session-2024-05-31.json", "session-2024-06-01.json"].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prune leaves a matching-named directory intact (isFile guard)", async () => {
  const root = await project();
  const metricsDir = join(root, "metrics");
  try {
    // A real older file (should be pruned) and a matching-named directory that must survive.
    await mkdir(join(metricsDir, "session-2024-01-01.json"), { recursive: true });
    await writeFile(join(metricsDir, "session-2024-01-02.json"), "old", "utf8");

    const now = new Date("2024-06-01T00:00:00Z").getTime();
    const r = await pruneSessionMetrics({ metricsDir, retentionDays: 90, now });
    assert.deepEqual(r.deleted.sort(), ["session-2024-01-02.json"]);

    const stat = await import("node:fs/promises");
    const entries = (await readdir(metricsDir)).sort();
    assert.deepEqual(entries, ["session-2024-01-01.json"]); // dir left intact
    // Confirm the surviving entry is still a directory, not a removed-then-something.
    const st = await stat.lstat(join(metricsDir, "session-2024-01-01.json"));
    assert.ok(st.isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
