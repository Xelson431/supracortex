/**
 * One-request decision enrichment: correctness of per-candidate reranking,
 * request-size bounding, and fail-safe behaviour. No network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { JevClient } from "../../packages/core/src/index.ts";
import { DROP_BELOW, decideGroup, enrichContext, planQuestions } from "../../packages/core/src/jev/enrich.ts";

function stub(answers: Record<string, unknown>, calls: { n: number; body?: Record<string, unknown> } = { n: 0 }) {
  return async (_url: string, init: { body: string }) => {
    calls.n++;
    calls.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ model: "typesafe/jev-1.13-x", answers, usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
}

const noul = (p: number) => ({ type: "noul", noul: p });
const keys = { taskKey: "t", configKey: "c", evidenceKey: "e" };
const mem = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, text: `memory ${i}` }));

test("decideGroup orders by each candidate's own relevance, not by position", () => {
  const ids = ["a", "b", "c", "d"];
  // Relevance is inverse to position: the old position-mapped design could
  // never produce this order.
  const d = decideGroup(ids, ids, { x0: noul(0.3), x1: noul(0.5), x2: noul(0.7), x3: noul(0.9) }, "x");
  assert.deepEqual(d?.order, ["d", "c", "b", "a"]);
});

test("decideGroup drops confident rejects but never below two", () => {
  const ids = ["a", "b", "c", "d"];
  const d = decideGroup(ids, ids, { x0: noul(0.9), x1: noul(0.05), x2: noul(0.8), x3: noul(0.01) }, "x");
  assert.deepEqual(d?.order, ["a", "c"]);
  assert.deepEqual(d?.dropped, ["b", "d"]);
  const allLow = decideGroup(ids, ids, { x0: noul(0.1), x1: noul(0.05), x2: noul(0.02), x3: noul(0.01) }, "x");
  assert.equal(allLow?.order.length, 2, "keeps the two best even if all are low");
  assert.ok(DROP_BELOW > 0 && DROP_BELOW < 0.5);
});

test("decideGroup: unchanged order or missing answers -> null (keep deterministic)", () => {
  const ids = ["a", "b", "c"];
  assert.equal(decideGroup(ids, ids, { x0: noul(0.9), x1: noul(0.8), x2: noul(0.7) }, "x"), null);
  assert.equal(decideGroup(ids, ids, { x0: noul(0.1), x2: noul(0.9) }, "x"), null);
  assert.equal(decideGroup(["a"], ["a"], { x0: noul(0.9) }, "x"), null);
});

test("decideGroup keeps unjudged tail candidates after judged ones", () => {
  const d = decideGroup(["a", "b", "c", "d"], ["a", "b"], { x0: noul(0.2 + 0.1), x1: noul(0.9) }, "x");
  assert.deepEqual(d?.order, ["b", "a", "c", "d"]);
});

test("planQuestions never exceeds the size cap and degrades by judging fewer candidates", () => {
  const base = { query: "fix the thing", memory: mem(8), summaries: mem(8).map((m) => ({ ...m, id: `f${m.id}` })), skills: [], mcpTools: [] };
  const big = planQuestions({ ...base, maxInputChars: 100_000 });
  assert.equal(big.memoryIds.length, 8);
  assert.equal(big.summaryIds.length, 8);
  const small = planQuestions({ ...base, maxInputChars: 1_800 });
  assert.ok(small.chars <= 1_800, `plan ${small.chars} chars exceeds cap`);
  assert.ok(small.memoryIds.length >= 2 && small.memoryIds.length < 8);
  // Round-robin: both groups get judged, best-first.
  assert.equal(small.memoryIds[0], "m0");
  assert.equal(small.summaryIds[0], "fm0");
});

test("enrichContext issues exactly ONE request for all questions", async () => {
  const calls = { n: 0 } as { n: number; body?: Record<string, unknown> };
  const answers: Record<string, unknown> = {
    m0: noul(0.1), m1: noul(0.9), m2: noul(0.6),
    s0: noul(0.8), s1: noul(0.9),
    skill: { type: "choice", choice: "b", confidence: 0.9 },
  };
  const client = new JevClient({ config: { enabled: true, modelMatch: "" }, apiKey: "k", fetchImpl: stub(answers, calls) as never });
  const r = await enrichContext(client, {
    query: "q",
    memory: mem(3),
    summaries: [{ id: "x.ts", text: "x" }, { id: "y.ts", text: "y" }],
    skills: [{ name: "a", description: "A" }, { name: "b", description: "B" }],
    mcpTools: [],
    maxInputChars: 12_000,
    timeoutMs: 1_000,
    keys,
  });
  assert.equal(calls.n, 1);
  assert.equal(r.ok, true);
  // m0 (p=0.1) is a confident reject and two candidates remain, so it drops.
  assert.deepEqual(r.memory?.order, ["m1", "m2"]);
  assert.deepEqual(r.memory?.dropped, ["m0"]);
  assert.deepEqual(r.summaries?.order, ["y.ts", "x.ts"]);
  assert.equal(r.skill, "b");
  const questions = (calls.body?.questions ?? {}) as Record<string, unknown>;
  assert.ok("m0" in questions && "s1" in questions && "skill" in questions);
});

test("enrichContext: abstention and low confidence change nothing; failures are safe", async () => {
  const none = new JevClient({
    config: { enabled: true, modelMatch: "" },
    apiKey: "k",
    fetchImpl: stub({ skill: { type: "choice", choice: "none", confidence: 0.99 } }) as never,
  });
  const r = await enrichContext(none, { query: "q", memory: [], summaries: [], skills: [{ name: "a", description: "" }, { name: "b", description: "" }], mcpTools: [], maxInputChars: 12_000, timeoutMs: 1_000, keys });
  assert.equal(r.ok, true);
  assert.equal(r.skill, null);

  const failing = new JevClient({
    config: { enabled: true, modelMatch: "" },
    apiKey: "k",
    fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as never,
  });
  const f = await enrichContext(failing, { query: "q", memory: mem(3), summaries: [], skills: [], mcpTools: [], maxInputChars: 12_000, timeoutMs: 1_000, keys });
  assert.equal(f.ok, false);
  assert.equal(f.memory, null);
});

test("planQuestions honours a per-provider question cap, relevance first", () => {
  const plan = planQuestions({
    query: "q",
    memory: mem(4),
    summaries: [{ id: "x.ts", text: "x" }, { id: "y.ts", text: "y" }],
    skills: [{ name: "a", description: "A" }, { name: "b", description: "B" }],
    mcpTools: [],
    maxInputChars: 100_000,
    maxQuestions: 3,
  });
  assert.deepEqual(Object.keys(plan.questions), ["m0", "s0", "m1"]);
});
