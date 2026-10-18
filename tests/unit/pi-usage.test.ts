/**
 * P08: ledger exactly-once, no fabricated costs, child/main reconciliation.
 * Synthetic events only (no provider).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChildOutcome } from "../../packages/pi/src/child-runner.ts";
import { reconcileChildUsage } from "../../packages/pi/src/child-runner.ts";
import { JobStore } from "../../packages/pi/src/job-store.ts";
import { CortexService } from "../../packages/pi/src/service.ts";
import { Supervisor } from "../../packages/pi/src/supervisor.ts";
import { toUsageRecord, UsageLedger } from "../../packages/pi/src/usage.ts";

function ledgerDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-usage-"));
}

test("usage records keep provider costs, never invent them", () => {
  const priced = toUsageRecord({
    runId: "r",
    sessionId: "s",
    requestKey: "k1",
    source: "child",
    provider: "p",
    modelId: "m",
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.001 } },
    complete: true,
  });
  assert.equal(priced.cost, 0.001);
  assert.equal(priced.costSource, "provider");
  const free = toUsageRecord({
    runId: "r",
    sessionId: "s",
    requestKey: "k2",
    source: "main",
    provider: "p",
    modelId: "m",
    usage: { input: 10, output: 5, cost: { total: 0 } },
    complete: true,
  });
  assert.equal(free.cost, 0, "explicit provider-reported zero stays zero");
  const unknown = toUsageRecord({
    runId: "r",
    sessionId: "s",
    requestKey: "k3",
    source: "main",
    provider: "",
    modelId: "",
    usage: { input: -5, output: Number.NaN },
    complete: true,
  });
  assert.equal(unknown.cost, undefined, "absent cost is unknown, not zero-priced");
  assert.equal(unknown.input, 0);
  assert.equal(unknown.model.provider, "unknown");
});

test("ledger is exactly-once across restarts; corrupt lines skipped", async () => {
  const dir = ledgerDir();
  const first = await UsageLedger.open("run-u1", dir);
  assert.equal(first.skipped, 0);
  const rec = {
    runId: "run-u1",
    sessionId: "s",
    requestKey: "e1",
    source: "main" as const,
    provider: "p",
    modelId: "m",
    usage: { input: 3, output: 4 },
    complete: true,
  };
  assert.ok(await first.ledger.record(rec));
  assert.equal(await first.ledger.record(rec), null, "duplicate within session");
  const second = await UsageLedger.open("run-u1", dir);
  assert.equal(second.ledger.count(), 1);
  assert.equal(await second.ledger.record(rec), null, "duplicate across restart");
  const totals = second.ledger.totals("main");
  assert.deepEqual([totals.requests, totals.input, totals.output, totals.incomplete], [1, 3, 4, 0]);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "usage.jsonl"), "{corrupt\n", { flag: "a" });
  const third = await UsageLedger.open("run-u1", dir);
  assert.equal(third.skipped, 1);
  assert.equal(third.ledger.count(), 1);
});

function assistantEnd(input: number, output: number, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "message_end",
    message: { role: "assistant", usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...extra }, provider: "p", model: "m" },
  };
}

test("child reconciliation: authoritative ends only, deduped, host-projected", async () => {
  const dir = ledgerDir();
  const { ledger } = await UsageLedger.open("run-u2", dir);
  const hosted: unknown[] = [];
  const sink = {
    ledger,
    runId: "run-u2",
    recordHostUsage: (async (o: unknown) => {
      hosted.push(o);
      return { recorded: true, duplicate: false };
    }) as never,
  };
  const outcome: ChildOutcome = {
    result: null,
    textFallback: null,
    reads: [],
    events: [
      { type: "message_update", message: { role: "assistant", usage: { input: 999, output: 999 } } },
      assistantEnd(100, 20),
      { type: "message_end", message: { role: "user" } },
      { type: "message_end", message: { role: "assistant" } },
      assistantEnd(200, 30),
    ],
  };
  const n = await reconcileChildUsage(sink, "sess-1", "inv-1", outcome);
  assert.equal(n, 2, "only assistant ends with numeric usage");
  assert.equal(hosted.length, 2);
  assert.deepEqual((hosted[0] as { messageId: string }).messageId, "inv-1#m0");
  // Streaming snapshots must NOT appear in totals.
  const totals = ledger.totals("child");
  assert.deepEqual([totals.input, totals.output], [300, 50]);
  // Rerun is a no-op (same invocation id).
  assert.equal(await reconcileChildUsage(sink, "sess-1", "inv-1", outcome), 0);
  assert.equal(hosted.length, 2);
  // Failed attempt with no usage records incomplete zeros.
  const m = await reconcileChildUsage(sink, "sess-1", "inv-2", {
    result: null,
    textFallback: null,
    reads: [],
    events: [],
    failureCode: "ABORTED",
  });
  assert.equal(m, 0);
  const all = ledger.totals();
  assert.equal(all.incomplete, 1);
  assert.equal(all.requests, 3);
});

test("main entries reconcile by entry id through the supervisor", async () => {
  const project = mkdtempSync(join(tmpdir(), "pi-usagemain-"));
  const service = await CortexService.create(project);
  const store = await JobStore.create(service.storagePath);
  const supervisor = new Supervisor({
    store,
    runId: "run-u3",
    service,
    cli: null,
    agentDir: "/tmp",
    agents: new Map(),
  });
  try {
    const entries = [
      { id: "e-1", type: "message", message: { role: "assistant", usage: { input: 7, output: 8 }, provider: "p", model: "m" } },
      { id: "e-2", type: "message", message: { role: "user" } },
      { id: "e-3", type: "usage", usage: { input: 1, output: 1 } },
    ];
    assert.equal(await supervisor.reconcileMainEntries("sess-9", entries), 1);
    assert.equal(await supervisor.reconcileMainEntries("sess-9", entries), 0, "entry ids dedupe");
    const totals = (await supervisor.usageLedger()).totals("main");
    assert.deepEqual([totals.requests, totals.input, totals.output], [1, 7, 8]);
  } finally {
    await service.close();
  }
});
