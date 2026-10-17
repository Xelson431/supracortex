/**
 * End-to-end lifecycle & plugin-surface stress tests. These drive the actual
 * plugin entry and CLI, asserting idempotency, isolation, and a full realistic
 * workflow across simulated sessions.
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupraCortex } from "../../packages/opencode/src/plugin.ts";
import * as cli from "../../packages/opencode/src/cli-core.ts";

async function proj(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ci-e2e-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "opencode.json"), JSON.stringify({ plugin: [] }), "utf8");
  await writeFile(join(dir, "src/auth.ts"), "export function login(){return true}\n", "utf8");
  await writeFile(join(dir, "src/db.ts"), "export const pool = {}\n", "utf8");
  return dir;
}
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
async function loadPlugin(dir: string) {
  return SupraCortex({ directory: dir, worktree: dir, client: {}, $: undefined } as never);
}

test("install is idempotent across 5 runs (no dupes, stable file set)", async () => {
  const dir = await proj();
  const first = await cli.install({ projectRoot: dir });
  const firstSet = new Set(first.created);
  assert.ok(firstSet.size > 0);
  for (let i = 0; i < 4; i++) {
    const r = await cli.install({ projectRoot: dir });
    assert.equal(r.created.length, 0, `run ${i + 2} creates nothing`);
    assert.equal(r.edited.length, 0, `run ${i + 2} edits nothing`);
  }
});

test("full workflow: record -> prepare -> plan -> claim -> outcome across sessions", async () => {
  const dir = await proj();
  await cli.install({ projectRoot: dir });

  // Session 1: record verified knowledge via the tool.
  const s1 = await loadPlugin(dir);
  const rec = s1.tool!.cortex_record!;
  const recOut = (await rec.execute(
    {
      kind: "decision",
      content: "auth uses signed session cookies, not localStorage",
      confidence: 0.9,
      sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
      tags: ["auth", "security"],
    },
    {} as never,
  )) as { output: string };
  assert.ok(recOut.output.includes("Recorded"));
  await s1.dispose?.();

  // Session 2 (fresh plugin load): prepare context should surface that memory.
  const s2 = await loadPlugin(dir);
  const prep = s2.tool!.cortex_context!;
  const prepOut = (await prep.execute(
    { query: "change how auth sessions are stored", agent: "orchestrator" },
    {} as never,
  )) as { output: string; metadata?: Record<string, unknown> };
  assert.ok(prepOut.output.includes("session cookies"), "recorded decision retrieved next session");

  // Plan two conflicting tasks -> must be flagged not parallel-safe.
  const plan = s2.tool!.cortex_plan_tasks!;
  const planOut = (await plan.execute(
    {
      tasks: [
        { id: "x", title: "edit auth", objective: "rework session store", writeScope: ["src/auth.ts"] },
        { id: "y", title: "also auth", objective: "tweak session store", writeScope: ["src/auth.ts"] },
      ],
    },
    {} as never,
  )) as { output: string };
  const plate = JSON.parse(planOut.output);
  const x = plate.tasks.find((t: { id: string }) => t.id === "x");
  assert.equal(x.parallelSafe, false, "conflicting writers not parallel-safe");

  // Claim then outcome.
  const claim = s2.tool!.cortex_claim_files!;
  const c = (await claim.execute({ taskId: "x", files: ["src/auth.ts"] }, {} as never)) as { output: string };
  assert.ok(c.output.includes("src/auth.ts"));
  const outcome = s2.tool!.cortex_record_outcome!;
  await outcome.execute(
    { taskId: "x", status: "success", summary: "moved to cookies", touchedFiles: ["src/auth.ts"], learnings: ["cookie store implemented in src/auth.ts"] },
    {} as never,
  );
  await s2.dispose?.();

  // Metrics reflect activity.
  const s3 = await loadPlugin(dir);
  const metrics = s3.tool!.cortex_metrics!;
  const m = (await metrics.execute({}, {} as never)) as { output: string };
  assert.ok(m.output.includes("metrics"));
  await s3.dispose?.();
});

test("disabled plugin performs zero disk writes across all tool calls", async () => {
  const dir = await proj();
  await cli.install({ projectRoot: dir });
  await cli.setEnabled(dir, false);

  // Snapshot storage dir file set before.
  const storageDir = join(dir, ".supracortex");
  const before = await listAll(storageDir);

  const s = await loadPlugin(dir);
  for (const name of Object.keys(s.tool!)) {
    // Call each tool with minimal/empty args; must not throw or write.
    const t = s.tool![name]!;
    try {
      await t.execute(sampleArgs(name), {} as never);
    } catch (e) {
      assert.fail(`disabled tool ${name} threw: ${(e as Error).message}`);
    }
  }
  await s.dispose?.();

  const after = await listAll(storageDir);
  assert.deepEqual(after, before, "no files created/modified while disabled");
});

test("plugin never throws to host even with a hostile client and bad storage", async () => {
  const dir = await proj();
  // Make storage path a FILE so engine init fails.
  await writeFile(join(dir, ".supracortex"), "x", "utf8");
  const hostileClient = {
    mcp: {
      status: async () => {
        throw new Error("boom");
      },
    },
  };
  const hooks = await SupraCortex({
    directory: dir,
    worktree: dir,
    client: hostileClient,
    $: (async () => {
      throw new Error("shell down");
    }) as never,
  } as never);
  assert.ok(hooks, "hooks returned despite failures");
  // Tools respond without throwing.
  for (const name of Object.keys(hooks.tool ?? {})) {
    const out = await hooks.tool![name]!.execute(sampleArgs(name), {} as never);
    assert.ok(out !== undefined);
  }
  await hooks.dispose?.();
});

test("uninstall after heavy use leaves host config + source pristine, keeps data on request", async () => {
  const dir = await proj();
  await cli.install({ projectRoot: dir });
  const s = await loadPlugin(dir);
  await s.tool!.cortex_record!.execute(
    { kind: "failure", content: "flaky db test", confidence: 0.9 },
    {} as never,
  );
  await s.dispose?.();

  const configBefore = await readFile(join(dir, "opencode.json"), "utf8");
  const srcBefore = await readFile(join(dir, "src/auth.ts"), "utf8");

  const r = await cli.uninstall({ projectRoot: dir, keepData: true });
  assert.ok(r.removed.some((p) => p.includes("plugins/supracortex.ts")));
  assert.equal(await readFile(join(dir, "opencode.json"), "utf8"), configBefore, "opencode.json pristine");
  assert.equal(await readFile(join(dir, "src/auth.ts"), "utf8"), srcBefore, "source pristine");
  assert.ok(await exists(join(dir, ".supracortex")), "data kept");
  // Memory file still holds the recorded failure.
  const failures = await readFile(join(dir, ".supracortex/memory/failures.jsonl"), "utf8");
  assert.ok(failures.includes("flaky db test"), "recorded memory retained with --keep-data");
});

test("reset all-generated wipes cache/index but never durable memory", async () => {
  const dir = await proj();
  await cli.install({ projectRoot: dir });
  const s = await loadPlugin(dir);
  await s.tool!.cortex_record!.execute(
    {
      kind: "decision",
      content: "durable decision to keep",
      confidence: 0.9,
      sourceReferences: [{ kind: "file", value: "src/db.ts" }],
    },
    {} as never,
  );
  await s.tool!.cortex_context!.execute({ query: "db pool" }, {} as never); // builds index
  await s.dispose?.();

  assert.ok(await exists(join(dir, ".supracortex/index/repository.json")));
  await cli.reset(dir, "all-generated");
  assert.equal(await exists(join(dir, ".supracortex/index/repository.json")), false, "index wiped");
  const decisions = await readFile(join(dir, ".supracortex/memory/decisions.jsonl"), "utf8");
  assert.ok(decisions.includes("durable decision to keep"), "durable memory survives reset");
});

// ---- helpers ----
async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: string[] = [];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      const p = join(d, e);
      const st = await stat(p);
      if (st.isDirectory()) await walk(p);
      else out.push(`${p}:${st.size}`);
    }
  }
  await walk(dir);
  return out;
}

function sampleArgs(toolName: string): Record<string, unknown> {
  switch (toolName) {
    case "cortex_prepare_context":
    case "cortex_context":
      return { query: "sample" };
    case "cortex_search_memory":
    case "cortex_search":
      return { query: "sample" };
    case "cortex_record_memory":
    case "cortex_record":
      return { kind: "failure", content: "x", confidence: 0.9 };
    case "cortex_record_outcome":
      return { taskId: "t", status: "success", summary: "s" };
    case "cortex_plan_tasks":
      return { tasks: [{ title: "t", objective: "o" }] };
    case "cortex_claim_files":
      return { taskId: "t", files: ["a.ts"] };
    case "cortex_release_files":
      return { taskId: "t" };
    default:
      return {};
  }
}
