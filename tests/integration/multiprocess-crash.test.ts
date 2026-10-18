/**
 * Multi-process durability tests.
 *
 * These are deliberately process-boundary tests: in-process Promise.all tests
 * cannot prove that two independent writers (or a writer killed by SIGKILL)
 * leave the on-disk store usable. Children import the same repo source as the
 * test suite and talk to a shared temp storage root.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSqliteStore, JsonlStore } from "../../packages/core/src/index.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const isolateConfigPath = join(repoRoot, "tests/isolate-config.ts");
const coreUrl = pathToFileURL(join(repoRoot, "packages/core/src/index.ts")).href;

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunningChild {
  child: ReturnType<typeof spawn>;
  exited: Promise<ChildResult>;
  getStdout(): string;
  getStderr(): string;
}

function startChild(args: string[], timeoutMs = 60_000): RunningChild {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const exited = new Promise<ChildResult>((resolve) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}spawn error: ${error.message}\n`,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });

  timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  return {
    child,
    exited,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function runChild(args: string[], timeoutMs = 60_000): Promise<ChildResult> {
  const result = await startChild(args, timeoutMs).exited;
  if (result.timedOut) {
    throw new Error(`child exceeded ${timeoutMs}ms timeout\nstderr:\n${result.stderr}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `child failed (code ${result.code}, signal ${result.signal})\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

/** Poll a child's captured stdout until the marker appears or the deadline passes. */
async function waitForMarker(running: RunningChild, marker: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (running.getStdout().includes(marker)) return;
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(
        `child exited before reporting ${marker}\nstdout:\n${running.getStdout()}\nstderr:\n${running.getStderr()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  running.child.kill("SIGKILL");
  throw new Error(
    `child did not report ${marker} within ${timeoutMs}ms\nstdout:\n${running.getStdout()}\nstderr:\n${running.getStderr()}`,
  );
}

/**
 * Each writer opens the same SQLite store and commits 50 JSONL rows plus 20
 * JSON docs. The parent seeds the DB, then reopens it after both processes exit.
 */
const sqliteWriterScript = `
import { createSqliteStore } from ${JSON.stringify(coreUrl)};

const storage = process.argv[2];
const writer = process.argv[3];
const store = await createSqliteStore(storage);
try {
  for (let i = 0; i < 50; i++) {
    await store.appendJsonl("history/multiprocess.jsonl", [{ writer, i, payload: "row-" + writer + "-" + i }]);
  }
  for (let i = 0; i < 20; i++) {
    await store.writeJson("docs/" + writer + "-" + i + ".json", { writer, i });
  }
  console.log(JSON.stringify({ ok: true, writer }));
} finally {
  await store.close();
}
`;

/**
 * Holds the advisory lock, commits one known-complete batch, reports progress,
 * then streams large batches until the parent SIGKILLs it. The lock directory is
 * therefore left behind by a provably dead owner.
 */
const crashWriterScript = `
import { JsonlStore } from ${JSON.stringify(coreUrl)};

const storage = process.argv[2];
const store = new JsonlStore(storage);
const release = await store.acquireLock("sigkill-mid-write", { timeoutMs: 10000, staleMs: 60000 });
void release; // never released: the parent kills this process while it holds the lock
await store.appendJsonl(
  "history/crash.jsonl",
  Array.from({ length: 25 }, (_, i) => ({ committed: true, i })),
);
console.log("PROGRESS committed=25");
for (;;) {
  await store.appendJsonl(
    "history/crash.jsonl",
    Array.from({ length: 25 }, (_, i) => ({
      committed: false,
      batch: Date.now(),
      i,
      text: "z".repeat(4096),
    })),
  );
}
`;

test(
  "two processes appending to one SQLite store lose no rows or docs",
  {
    skip:
      process.platform === "win32"
        ? "multi-process SQLite children are not portable here (child ESM loader/sqlite on Windows)"
        : false,
  },
  async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sc-multiprocess-sqlite-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const storage = join(base, ".supracortex");

  let seed: Awaited<ReturnType<typeof createSqliteStore>>;
  try {
    seed = await createSqliteStore(storage);
  } catch (error) {
    const message = (error as Error).message;
    if (/node:sqlite|SQLite runtime is unavailable/i.test(message)) {
      t.skip(`node:sqlite unavailable in this runtime: ${message}`);
      return;
    }
    throw error;
  }
  // Seed the schema before racing two writers so the test measures row
  // durability under contention, not DDL races during first open.
  await seed.close();

  const publisher = join(base, "sqlite-writer.mjs");
  await writeFile(publisher, sqliteWriterScript, "utf8");
  const childArgs = (writer: string) => ["--import", isolateConfigPath, publisher, storage, writer];

  const results = await Promise.all([runChild(childArgs("writer-a")), runChild(childArgs("writer-b"))]);
  for (const result of results) {
    assert.match(result.stdout, /"ok":true/, `both writers reported success\nstderr:\n${result.stderr}`);
  }

  const reopened = await createSqliteStore(storage);
  try {
    const history = await reopened.readJsonl<{ writer: string; i: number }>("history/multiprocess.jsonl");
    assert.equal(history.corruptLines, 0, "reopened SQLite JSONL has no corrupt rows");
    assert.equal(history.entries.length, 100, "every row from both writers is present");

    for (const writer of ["writer-a", "writer-b"]) {
      const indices = new Set(history.entries.filter((entry) => entry.writer === writer).map((entry) => entry.i));
      assert.equal(indices.size, 50, `${writer} contributed all 50 rows`);
      for (let i = 0; i < 50; i++) assert.ok(indices.has(i), `${writer} row ${i} survived`);
    }

    const docs = await reopened.listFiles("docs");
    assert.equal(docs.length, 40, "every JSON doc from both writers is present");
    for (const writer of ["writer-a", "writer-b"]) {
      for (let i = 0; i < 20; i++) {
        const doc = await reopened.readJson<{ writer: string; i: number }>(`docs/${writer}-${i}.json`);
        assert.deepEqual(doc, { writer, i }, `${writer} doc ${i} survived intact`);
      }
    }
  } finally {
    await reopened.close();
  }
});

test(
  "SIGKILL mid-write leaves readable JSONL and a reclaimable advisory lock",
  { skip: process.platform === "win32" ? "SIGKILL semantics are POSIX-only" : false },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "sc-multiprocess-crash-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const storage = join(base, ".supracortex");
    const publisher = join(base, "crash-writer.mjs");
    await writeFile(publisher, crashWriterScript, "utf8");

    const running = startChild(["--import", isolateConfigPath, publisher, storage], 60_000);
    let markerFailure: Error | undefined;
    try {
      await waitForMarker(running, "PROGRESS committed=25", 15_000);
    } catch (error) {
      markerFailure = error as Error;
    }
    if (markerFailure) {
      const result = await running.exited;
      throw new Error(`${markerFailure.message}\nfinal stderr:\n${result.stderr}`);
    }

    running.child.kill("SIGKILL");
    const result = await running.exited;
    assert.equal(result.signal, "SIGKILL", `child was killed by SIGKILL\nstderr:\n${result.stderr}`);

    const store = new JsonlStore(storage);
    await assert.doesNotReject(
      () => store.readJsonl("history/crash.jsonl"),
      "readJsonl must not throw after an abrupt process death",
    );
    const history = await store.readJsonl<{ committed: boolean }>("history/crash.jsonl");
    assert.equal(
      history.entries.filter((entry) => entry.committed === true).length,
      25,
      "the complete batch committed before the marker is retained",
    );
    assert.ok(
      history.corruptLines <= 1,
      `at most one partial tail line may be unreadable, saw ${history.corruptLines}`,
    );

    const started = Date.now();
    const release = await store.acquireLock("sigkill-mid-write", { timeoutMs: 5_000, retryMs: 25 });
    try {
      t.diagnostic(`reclaimed the dead writer's lock in ${Date.now() - started}ms`);
    } finally {
      await release();
    }
  },
);
