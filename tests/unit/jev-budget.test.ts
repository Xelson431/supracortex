/**
 * P06: per-request Jev enrichment budget. Network-free (stubbed fetch);
 * engine-level test uses enrichmentBudgetMs=0 so no HTTP is ever issued.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  Engine,
  effectiveDecisionTiming,
  JsonlStore,
  resolveConfig,
  validateConfig,
  type JevDecisionsResponse,
} from "../../packages/core/src/index.ts";
import { DecisionBudget } from "../../packages/core/src/jev/budget.ts";
import { JevClient } from "../../packages/core/src/jev/client.ts";
import { routingQuestions } from "../../packages/core/src/jev/questions.ts";

const OK_RESPONSE: JevDecisionsResponse = {
  model: "typesafe/jev-1.13-test",
  answers: {
    enrich: { type: "noul", noul: 0.9 },
    depth: { type: "choice", choice: "standard", confidence: 0.8 },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

function stubFetch(response: JevDecisionsResponse, opts: { delayMs?: number; calls?: { n: number }; aborted?: { v: boolean } } = {}) {
  return async (_url: string, init: { signal: AbortSignal }) => {
    if (opts.calls) opts.calls.n++;
    if (init.signal.aborted) {
      if (opts.aborted) opts.aborted.v = true;
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    if (opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), opts.delayMs);
        init.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            if (opts.aborted) opts.aborted.v = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
    }
    return { ok: true, status: 200, json: async () => response };
  };
}

test("DecisionBudget shares one wall-clock deadline across calls", () => {
  let now = 1000;
  const budget = new DecisionBudget(1200, () => now);
  assert.equal(budget.remainingMs(), 1200);
  assert.equal(budget.exhausted(), false);
  now += 1199;
  assert.equal(budget.remainingMs(), 1);
  now += 1;
  assert.equal(budget.exhausted(), true);
  now += 5000;
  assert.equal(budget.remainingMs(), 0, "never negative");
  assert.equal(new DecisionBudget(0, () => now).exhausted(), true);
  assert.equal(new DecisionBudget(-50, () => now).exhausted(), true);
});

test("per-call timeout aborts the actual fetch (leader)", async () => {
  const calls = { n: 0 };
  const aborted = { v: false };
  const client = new JevClient({
    config: { enabled: true, deadlineMs: 30000 },
    apiKey: "k",
    fetchImpl: stubFetch(OK_RESPONSE, { delayMs: 500, calls, aborted }),
  });
  const res = await client.decide({ state: {}, questions: routingQuestions(), timeoutMs: 20 });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "timeout");
  assert.equal(calls.n, 1, "fetch was issued then aborted");
  assert.equal(aborted.v, true, "the actual fetch saw the abort");
});

test("per-call timeout wider than the fetch still succeeds", async () => {
  const client = new JevClient({
    config: { enabled: true, deadlineMs: 30000 },
    apiKey: "k",
    fetchImpl: stubFetch(OK_RESPONSE, { delayMs: 5 }),
  });
  const res = await client.decide({ state: {}, questions: routingQuestions(), timeoutMs: 5000 });
  assert.equal(res.ok, true);
});

test("exhausted budget issues no fetch; cache hits still served", async () => {
  const calls = { n: 0 };
  const client = new JevClient({
    config: { enabled: true },
    apiKey: "k",
    fetchImpl: stubFetch(OK_RESPONSE, { calls }),
  });
  const empty = await client.decide({ state: { q: "uncached" }, questions: routingQuestions(), timeoutMs: 0 });
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.reason, "timeout");
    assert.equal((empty as { detail?: string }).detail, "budget-exhausted");
  }
  assert.equal(calls.n, 0, "no HTTP on exhausted budget");
  const first = await client.decide({ state: { q: "cached" }, questions: routingQuestions() });
  assert.equal(first.ok, true);
  assert.equal(calls.n, 1);
  const cached = await client.decide({ state: { q: "cached" }, questions: routingQuestions(), timeoutMs: 0 });
  assert.equal(cached.ok, true, "free cache hits survive an exhausted budget");
  if (cached.ok) assert.equal(cached.fromCache, true);
  assert.equal(calls.n, 1, "cache hit issued no fetch");
  const usage = client.takeLastUsage();
  assert.equal(usage?.fromCache, true);
  assert.equal(usage?.issuedCall, false);
});

test("coalesced joiner timeout never aborts the leader", async () => {
  const client = new JevClient({
    config: { enabled: true },
    apiKey: "k",
    fetchImpl: stubFetch(OK_RESPONSE, { delayMs: 200 }),
  });
  const input = { state: { q: "shared" }, questions: routingQuestions() };
  const [leader, joiner] = await Promise.all([
    client.decide(input),
    (async () => {
      await new Promise((r) => setTimeout(r, 5));
      return client.decide({ ...input, timeoutMs: 20 });
    })(),
  ]);
  assert.equal(leader.ok, true, "leader completes despite joiner timeout");
  assert.equal(joiner.ok, false);
  if (!joiner.ok) {
    assert.equal(joiner.reason, "timeout");
    assert.equal((joiner as { detail?: string }).detail, "coalesced-wait");
  }
  const usage = client.takeLastUsage();
  assert.equal(usage?.issuedCall, true, "exactly one call issued, attributed to the leader");
});

test("enrichmentBudgetMs config: default, range, engine skip at zero", async () => {
  // -1 = provider default: Jev 800 ms, local Laya 2 500 ms; explicit wins.
  assert.equal(DEFAULT_CONFIG.jev.enrichmentBudgetMs, -1);
  assert.equal(effectiveDecisionTiming({ provider: "jev", enrichmentBudgetMs: -1 }).enrichmentBudgetMs, 800);
  assert.equal(effectiveDecisionTiming({ provider: "laya-local", enrichmentBudgetMs: -1 }).enrichmentBudgetMs, 2_500);
  assert.equal(effectiveDecisionTiming({ provider: "laya-local", enrichmentBudgetMs: 0 }).enrichmentBudgetMs, 0);
  assert.equal(effectiveDecisionTiming({ provider: "jev", deadlineMs: 5_000 }).deadlineMs, 5_000);
  assert.equal(effectiveDecisionTiming({ provider: "laya-local" }).maxInputChars, 1_800);
  assert.equal(validateConfig({ jev: { deadlineMs: -1, enrichmentBudgetMs: -1 } }).valid, true);
  const bad = validateConfig({ jev: { enrichmentBudgetMs: 20000 } });
  assert.ok(bad.errors.some((e) => e.includes("jev.enrichmentBudgetMs")), `expected range error, got ${bad.errors}`);
  const good = validateConfig({ jev: { enrichmentBudgetMs: 0 } });
  assert.equal(good.errors.length, 0);

  // Engine with budget 0 issues no Jev HTTP and matches deterministic output.
  const prevKey = process.env["OPENROUTER_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "test-key-unit";
  try {
    const makeEngine = async (budgetMs: number): Promise<Engine> => {
      const projectRoot = mkdtempSync(join(tmpdir(), "pi-jezbudget-"));
      const resolved = resolveConfig({
        defaults: DEFAULT_CONFIG,
        project: { jev: { enabled: true, enrichmentBudgetMs: budgetMs } },
        env: {},
      });
      return new Engine({
        config: resolved.config,
        store: new JsonlStore(join(projectRoot, ".supracortex")),
        pluginVersion: "test",
        projectRoot,
      });
    };
    const budgeted = await makeEngine(0);
    const plain = await makeEngine(0);
    // Second engine: Jev disabled entirely (deterministic baseline).
    const offProject = mkdtempSync(join(tmpdir(), "pi-jezbudget-off-"));
    const offResolved = resolveConfig({ defaults: DEFAULT_CONFIG, project: { jev: { enabled: false } }, env: {} });
    const off = new Engine({
      config: offResolved.config,
      store: new JsonlStore(join(offProject, ".supracortex")),
      pluginVersion: "test",
      projectRoot: offProject,
    });
    const [a, b] = await Promise.all([
      budgeted.prepareContext({ query: "budget test" }),
      plain.prepareContext({ query: "budget test" }),
    ]);
    assert.deepEqual(
      a?.selectedMemory.map((m) => m.entry.id),
      b?.selectedMemory.map((m) => m.entry.id),
      "zero budget is deterministic across runs",
    );
    const snap = budgeted.metricsSnapshot();
    assert.equal(snap.jevCalls, 0, "no Jev HTTP issued on exhausted budget");
    assert.equal(snap.jevDecisionsApplied, 0);
    const offPacket = await off.prepareContext({ query: "budget test" });
    assert.deepEqual(
      (a?.selectedMemory.map((m) => m.entry.id) ?? []).sort(),
      (offPacket?.selectedMemory.map((m) => m.entry.id) ?? []).sort(),
      "zero budget matches Jev-disabled order",
    );
    await budgeted.close();
    await plain.close();
    await off.close();
  } finally {
    if (prevKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = prevKey;
  }
});
