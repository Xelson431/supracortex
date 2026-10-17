/**
 * P05 unit (network-free, fake runner): admission, dedup, queue bounds,
 * cancellation races, delivery identity, shutdown, recovery, store safety.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../../packages/pi/src/agents.ts";
import type { ChildOutcome } from "../../packages/pi/src/child-runner.ts";
import type { CliConfig } from "../../packages/pi/src/config.ts";
import { JobStore } from "../../packages/pi/src/job-store.ts";
import { CortexService } from "../../packages/pi/src/service.ts";
import { Supervisor, taskHash, type ParentContext } from "../../packages/pi/src/supervisor.ts";

const AGENT: AgentDefinition = {
  name: "explorer",
  description: "test",
  tools: ["read"],
  skills: [],
  body: "test",
  layer: "bundled",
  path: "explorer.md",
};

const PARENT: ParentContext = { sessionFile: "/tmp/sess-1.jsonl", sessionId: "s1", cwd: "/tmp" };

function okResult(summary: string): ChildOutcome {
  return {
    result: { schemaVersion: 1, summary, findings: [], recommendedActions: [], unresolved: [] },
    textFallback: null,
    reads: [],
    events: [],
  };
}

async function harness(opts: {
  runner?: (spec: never, o: never) => Promise<ChildOutcome>;
  cli?: CliConfig | null;
  runId?: string;
} = {}) {
  const project = mkdtempSync(join(tmpdir(), "pi-jobs-"));
  const service = await CortexService.create(project);
  const store = await JobStore.create(service.storagePath);
  const agents = new Map([["explorer", AGENT]]);
  const supervisor = new Supervisor({
    store,
    runId: opts.runId ?? "run-unit-1",
    service,
    cli: opts.cli ?? null,
    agentDir: "/tmp/pi-agent",
    agents,
    mainModel: { provider: "p", id: "m" },
    runner: (opts.runner as never) ?? (async () => okResult("fake")),
  });
  return { supervisor, store, service, project };
}

test("taskHash is stable and discriminates scope", () => {
  const base = {
    parentSessionFile: "/s.jsonl",
    role: "explorer",
    model: { provider: "p", id: "m" },
    task: "do  thing",
    hints: [] as string[],
    handoffText: "",
  };
  assert.equal(taskHash(base), taskHash({ ...base, task: "do thing" }));
  assert.notEqual(taskHash(base), taskHash({ ...base, role: "reviewer" }));
  assert.notEqual(taskHash(base), taskHash({ ...base, parentSessionFile: "/other.jsonl" }));
});

test("delegate rejects unknown role, bad hints, invalid shape before spawning", async () => {
  const { supervisor, service } = await harness();
  try {
    await assert.rejects(supervisor.delegate({ role: "nope", task: "t", mode: "wait" }, PARENT), /unknown role/);
    await assert.rejects(
      supervisor.delegate({ role: "explorer", task: "t", mode: "wait", hintFiles: ["../escape"] }, PARENT),
      /hint file rejected/,
    );
    await assert.rejects(supervisor.delegate({ role: "explorer", task: "", mode: "wait" }, PARENT), /invalid delegation/);
  } finally {
    await service.close();
  }
});

test("duplicate scope returns the same job; wait mode resolves terminal", async () => {
  let calls = 0;
  const { supervisor, service } = await harness({
    runner: (async () => {
      calls++;
      return okResult("scoped");
    }) as never,
  });
  try {
    const bg = (await supervisor.delegate({ role: "explorer", task: "same task", mode: "background" }, PARENT)) as { jobId: string };
    assert.ok(bg.jobId);
    const dup = (await supervisor.delegate({ role: "explorer", task: "same  task", mode: "background" }, PARENT)) as { jobId: string };
    assert.equal(dup.jobId, bg.jobId, "same scope must not spawn twice");
    for (let i = 0; i < 100 && (await supervisor.lookup(bg.jobId)).record.state !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await supervisor.lookup(bg.jobId)).record.state, "succeeded");
    assert.equal(calls, 1);
    const waited = (await supervisor.delegate({ role: "explorer", task: "other task", mode: "wait" }, PARENT)) as { state: string; result: { summary: string } | null };
    assert.equal(waited.state, "succeeded");
    assert.equal(waited.result?.summary, "scoped");
  } finally {
    await service.close();
  }
});

test("queue bound enforced; queued cancel settles immediately", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { supervisor, service } = await harness({
    cli: { schemaVersion: 1, jobs: { maxRunning: 1, maxQueued: 1 } },
    runner: (async () => {
      await gate;
      return okResult("gated");
    }) as never,
  });
  try {
    const first = supervisor.delegate({ role: "explorer", task: "occupy", mode: "background" }, PARENT);
    const second = supervisor.delegate({ role: "explorer", task: "queued", mode: "background" }, PARENT);
    const pair = (await Promise.all([first, second])) as Array<{ jobId: string }>;
    const f = pair[0]!;
    const s = pair[1]!;
    await assert.rejects(supervisor.delegate({ role: "explorer", task: "overflow", mode: "background" }, PARENT), /queue full/);
    const cancelled = await supervisor.cancel(s.jobId);
    assert.equal(cancelled, "cancelled");
    release();
    const outcome = (await supervisor.delegate({ role: "explorer", task: "after", mode: "wait" }, PARENT)) as { state: string };
    assert.equal(outcome.state, "succeeded");
    assert.equal(f.jobId.length, 36);
  } finally {
    await service.close();
  }
});

test("running cancel aborts and settles cancelled; delivery respects parent", async () => {
  let observedAbort = false;
  const { supervisor, service } = await harness({
    runner: ((async (_spec: never, o: { signal?: AbortSignal }) => {
      if (o.signal?.aborted) {
        observedAbort = true;
        return { result: null, textFallback: "partial", reads: [], events: [], failureCode: "ABORTED" as const };
      }
      await new Promise<void>((resolve) => {
        o.signal?.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        });
      });
      return { result: null, textFallback: "partial", reads: [], events: [], failureCode: "ABORTED" as const };
    }) as never),
  });
  try {
    const pending = supervisor.delegate({ role: "explorer", task: "long", mode: "background" }, PARENT);
    const { jobId } = (await pending) as { jobId: string };
    await new Promise((r) => setTimeout(r, 50));
    const state = await supervisor.cancel(jobId);
    assert.equal(state, "cancelled");
    assert.equal(observedAbort, true);
    // Terminal background job with no result: nothing deliverable, wrong parent never matches.
    const sent: string[] = [];
    const n = await supervisor.deliverPending({
      currentSessionFile: "/tmp/other.jsonl",
      send: (t) => void sent.push(t),
    });
    assert.equal(n, 0);
    assert.equal(sent.length, 0);
  } finally {
    await service.close();
  }
});

test("stuck abort reports cancelling and blocks admissions (no fake success)", async () => {
  const project = mkdtempSync(join(tmpdir(), "pi-jobs-stuck-"));
  const service = await CortexService.create(project);
  const store = await JobStore.create(service.storagePath);
  const supervisor = new Supervisor({
    store,
    runId: "run-stuck",
    service,
    cli: null,
    agentDir: "/tmp",
    agents: new Map([["explorer", AGENT]]),
    mainModel: { provider: "p", id: "m" },
    stuckAfterMs: 50,
    runner: (async () => {
      await new Promise(() => undefined); // never settles, ignores abort
      throw new Error("unreachable");
    }) as never,
  });
  try {
    const { jobId } = (await supervisor.delegate({ role: "explorer", task: "stuck", mode: "background" }, PARENT)) as { jobId: string };
    for (let i = 0; i < 100 && (await supervisor.lookup(jobId)).record.state !== "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const state = await supervisor.cancel(jobId);
    assert.equal(state, "cancelling", "stuck child stays cancelling, never faked");
    assert.equal(supervisor.isAdmissionsBlocked(), true);
    await assert.rejects(supervisor.delegate({ role: "explorer", task: "next", mode: "background" }, PARENT), /admissions blocked/);
  } finally {
    await service.close();
  }
});

test("background success delivers once to the original parent only", async () => {
  const { supervisor, service } = await harness();
  try {
    const { jobId } = (await supervisor.delegate({ role: "explorer", task: "bg work", mode: "background" }, PARENT)) as { jobId: string };
    for (let i = 0; i < 100 && (await supervisor.lookup(jobId)).record.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const { record } = await supervisor.lookup(jobId);
    assert.equal(record.state, "succeeded");
    const sent: string[] = [];
    const wrong = await supervisor.deliverPending({ currentSessionFile: "/tmp/other.jsonl", send: (t) => void sent.push(t) });
    assert.equal(wrong, 0);
    const right = await supervisor.deliverPending({ currentSessionFile: PARENT.sessionFile, send: (t) => void sent.push(t) });
    assert.equal(right, 1);
    assert.ok(sent[0]!.includes("fake"));
    const again = await supervisor.deliverPending({ currentSessionFile: PARENT.sessionFile, send: (t) => void sent.push(t) });
    assert.equal(again, 0, "no duplicate delivery");
  } finally {
    await service.close();
  }
});

test("cortex_delegate/job tools route, validate UUIDs, and format", async () => {
  const { cortexDelegateTool, cortexJobTool } = await import("../../packages/pi/src/tools.ts");
  const delegated: unknown[] = [];
  const fake = {
    currentRunId: "run-fake",
    delegate: (async (raw: unknown) => {
      delegated.push(raw);
      return { jobId: "22222222-2222-4222-8222-222222222222", state: "queued" };
    }) as never,
    lookup: (async () => ({ record: { id: "22222222-2222-4222-8222-222222222222", role: "explorer", state: "succeeded" } })) as never,
    cancel: (async () => "cancelled") as never,
    loadResultText: (async () => "summary: done") as never,
  };
  const ctx = {
    cwd: "/tmp",
    sessionManager: { getSessionFile: () => "/tmp/s.jsonl", getSessionId: () => "s" },
  } as never;
  const delegateTool = cortexDelegateTool(async () => fake as never);
  const out = await delegateTool.execute("1", { role: "explorer", task: "t", mode: "background" }, undefined, undefined, ctx);
  assert.match((out.content[0] as { text: string }).text, /22222222/);
  assert.deepEqual(delegated.length, 1);
  const jobTool = cortexJobTool(async () => fake as never);
  const bad = await jobTool.execute("2", { action: "status", jobId: "not-a-uuid" }, undefined, undefined, ctx);
  assert.match((bad.content[0] as { text: string }).text, /invalid jobId/);
  const status = await jobTool.execute("3", { action: "status", jobId: "22222222-2222-4222-8222-222222222222" }, undefined, undefined, ctx);
  assert.match((status.content[0] as { text: string }).text, /succeeded/);
  const result = await jobTool.execute("4", { action: "result", jobId: "22222222-2222-4222-8222-222222222222" }, undefined, undefined, ctx);
  assert.match((result.content[0] as { text: string }).text, /done/);
  const cancelled = await jobTool.execute("5", { action: "cancel", jobId: "22222222-2222-4222-8222-222222222222" }, undefined, undefined, ctx);
  assert.match((cancelled.content[0] as { text: string }).text, /cancelled/);
});

test("recover interrupts prior-run jobs; store quarantines corrupt records", async () => {
  const { supervisor, store, service } = await harness({ runId: "run-new" });
  try {
    await store.saveJob(
      {
        schemaVersion: 1,
        id: "11111111-1111-4111-8111-111111111111",
        runId: "run-old",
        parentSessionId: "p",
        taskHash: "h",
        role: "explorer",
        model: { provider: "p", id: "m" },
        state: "running",
        createdAt: new Date(0).toISOString(),
      },
      "run-old",
    );
    const { interrupted } = await supervisor.recover();
    assert.equal(interrupted, 1);
    const stale = await store.loadJob("run-old", "11111111-1111-4111-8111-111111111111");
    assert.equal(stale?.state, "interrupted");
    // Corrupt + escaping names.
    const badPath = join(store.root, "runs", "run-old", "jobs", "bad.json");
    writeFileSync(badPath, "{not json");
    assert.equal(await store.loadJob("run-old", "bad"), null);
    await assert.rejects(store.loadJob("run-old", "../../escape"), /unsafe/);
  } finally {
    await service.close();
  }
});
