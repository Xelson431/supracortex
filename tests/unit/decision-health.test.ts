/**
 * Decision-provider health gate: decisions are used only when a key is present
 * AND a real health request succeeded; otherwise every caller takes the
 * deterministic path immediately and the provider is re-checked later.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";
import { DecisionHealth, RECHECK_MS } from "../../packages/core/src/jev/health.ts";

const OK = { ok: true as const, response: { model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } as never, fromCache: false };
const DOWN = { ok: false as const, reason: "http-error" as const, detail: "status 503" };

test("gate: checking -> active on a successful probe; never blocks the caller", async () => {
  let release!: () => void;
  const probe = () => new Promise<typeof OK>((r) => { release = () => r(OK); });
  const h = new DecisionHealth(probe as never);
  assert.equal(h.usable(), false, "first call starts the probe and returns immediately");
  assert.equal(h.snapshot().state, "checking");
  release();
  await h.kick();
  assert.equal(h.usable(), true);
  assert.equal(h.snapshot().state, "active");
});

test("gate: failed probe -> unreachable with reason; re-probed only after RECHECK_MS", async () => {
  let now = 1_000;
  let calls = 0;
  let result: unknown = DOWN;
  const h = new DecisionHealth(async () => { calls++; return result as never; }, () => now);
  await h.kick();
  assert.equal(h.snapshot().state, "unreachable");
  assert.match(h.snapshot().reason ?? "", /http-error: status 503/);
  assert.equal(h.usable(), false);
  assert.equal(calls, 1, "no re-probe inside the recheck window");
  result = OK;
  now += RECHECK_MS;
  assert.equal(h.usable(), false, "re-probe starts, caller still not blocked");
  await h.kick();
  assert.equal(calls, 2);
  assert.equal(h.usable(), true, "recovered provider is used again");
});

test("gate: runtime outage demotes, a per-turn timeout does not", async () => {
  const h = new DecisionHealth(async () => OK as never);
  await h.kick();
  h.observe({ ok: false, reason: "timeout", detail: "budget-exhausted" });
  assert.equal(h.snapshot().state, "active", "tight per-turn budget miss is not an outage");
  h.observe(DOWN);
  assert.equal(h.snapshot().state, "unreachable");
});

function engine(jev: Record<string, unknown>): Engine {
  const root = mkdtempSync(join(tmpdir(), "sc-health-"));
  const config = resolveConfig({ defaults: DEFAULT_CONFIG, project: { enabled: true, jev }, env: {} }).config;
  return new Engine({ config, store: new JsonlStore(join(root, ".supracortex")), pluginVersion: "t", projectRoot: root });
}

test("engine: no key -> no-key state, no network, deterministic context", async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("must not be called"); }) as never;
  try {
    const e = engine({ enabled: true, provider: "jev", credentialsFile: "/nonexistent" });
    const snap = await e.warmDecisions();
    // A developer machine may still resolve a key from ~/.config/supracortex;
    // the suite runs under a throwaway HOME, so none is found here.
    assert.equal(snap.state, "no-key");
    assert.equal(e.jevStatus().state, "no-key");
    assert.ok(await e.prepareContext({ query: "anything" }));
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  }
});

test("engine: disabled -> disabled state", () => {
  assert.equal(engine({ enabled: false }).jevStatus().state, "disabled");
});

test("engine: unreachable provider -> turns never call it until recheck", async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "k";
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response("down", { status: 503 }); }) as never;
  try {
    const e = engine({ enabled: true, provider: "jev" });
    const snap = await e.warmDecisions();
    assert.equal(snap.state, "unreachable");
    const before = fetched;
    const t0 = Date.now();
    await e.prepareContext({ query: "anything at all" });
    await e.prepareContext({ query: "another turn" });
    assert.equal(fetched, before, "no decision requests while unreachable");
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(e.jevStatus().state, "unreachable");
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
});
