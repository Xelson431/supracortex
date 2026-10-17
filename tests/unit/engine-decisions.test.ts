/**
 * Engine-level decision enrichment: one HTTP request per prepareContext, a
 * real per-candidate reorder is applied, and failures leave the deterministic
 * packet untouched. `globalThis.fetch` is stubbed; no network.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";

async function engineWithMemory(): Promise<Engine> {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-decisions-"));
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "a.ts"), "export const provider = 'jev';\n");
  const config = resolveConfig({
    defaults: DEFAULT_CONFIG,
    project: {
      enabled: true,
      jev: { enabled: true, provider: "jev", enrichmentBudgetMs: 30_000, deadlineMs: 30_000 },
      graph: { enabled: false },
      supraspace: { enabled: false },
    },
    env: {},
  }).config;
  const engine = new Engine({ config, store: new JsonlStore(join(projectRoot, ".supracortex")), pluginVersion: "test", projectRoot });
  engine_ = engine;
  for (const [kind, content] of [
    ["decision", "Provider switching: jev.provider in the global config selects the decision provider."],
    ["fact", "The provider preset supplies endpoint, model and credential env var for jev."],
    ["fact", "The TUI wordmark animation settles after the provider reveal sweep."],
  ] as const) {
    const r = await engine.recordMemory({ kind, content, confidence: 0.9, sourceReferences: [{ kind: "file", value: "src/a.ts" }] });
    assert.equal(r.status, "recorded");
  }
  return engine;
}

let engine_: Engine | null = null;
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const key = process.env.OPENROUTER_API_KEY;
  globalThis.fetch = impl;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    // Health gate: a provider is used only after a successful health request.
    // Probe with the stub so each scenario starts from a known state.
    await engine_?.warmDecisions();
    return await fn();
  } finally {
    globalThis.fetch = real;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
  }
}

test("prepareContext makes at most ONE decision request and applies per-candidate relevance", async () => {
  const engine = await engineWithMemory();
  const baseline = await withFetch((async () => { throw new Error("offline"); }) as never, () => engine.prepareContext({ query: "provider switching jev preset" }));
  const deterministic = baseline!.selectedMemory.map((m) => m.entry.content);
  assert.ok(deterministic.length >= 2, "fixture must select at least two memories");

  let calls = 0;
  let questions: Record<string, { instructions: string }> = {};
  const fake = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (body.state?.probe) {
      // Health-gate probe (session warm-up), not a turn request.
      return new Response(JSON.stringify({ model: "typesafe/jev-1.13-test", answers: { ready: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
    }
    calls++;
    questions = body.questions;
    // Judge each memory question by its own text: the TUI entry is irrelevant.
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      if (!/^[ms]\d+$/.test(key)) continue;
      answers[key] = { type: "noul", noul: /wordmark/.test(q.instructions) ? 0.02 : /endpoint/.test(q.instructions) ? 0.95 : 0.7 };
    }
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13-test", answers, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  }) as never;

  const packet = await withFetch(fake, () => engine.prepareContext({ query: "provider switching jev preset" }));
  assert.equal(calls, 1, "exactly one decision HTTP request per turn");
  const contents = packet!.selectedMemory.map((m) => m.entry.content);
  assert.ok(contents[0]!.includes("endpoint"), `most relevant first, got ${JSON.stringify(contents)}`);
  if (deterministic.some((c) => c.includes("wordmark")) && deterministic.length > 2) {
    assert.ok(!contents.some((c) => c.includes("wordmark")), "confident reject dropped");
    assert.ok(packet!.omissions.some((o) => o.reason === "low-relevance" && o.path.startsWith("memory:")));
  }
  assert.ok(packet!.estimatedTokens <= baseline!.estimatedTokens, "enrichment never adds tokens");
  const summary = engine.lastDecisionSummary();
  assert.equal(summary?.ok, true);
  assert.equal(summary?.memoryReordered, true);
  await engine.close();
});

test("decision failure leaves the deterministic packet unchanged", async () => {
  const engine = await engineWithMemory();
  const a = await withFetch((async () => { throw new Error("offline"); }) as never, () => engine.prepareContext({ query: "provider switching jev preset" }));
  const b = await withFetch((async () => new Response("{}", { status: 500 })) as never, () => engine.prepareContext({ query: "provider switching jev preset again" }));
  assert.deepEqual(
    a!.selectedMemory.map((m) => m.entry.id).sort(),
    b!.selectedMemory.map((m) => m.entry.id).sort(),
  );
  assert.equal(engine.lastDecisionSummary()?.ok, false);
  await engine.close();
});
