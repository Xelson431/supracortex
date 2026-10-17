/**
 * Decision-provider contract tests: the System One wire protocol is shared by
 * Jev, Laya and custom endpoints, so providers differ by configuration only.
 * All network calls are stubbed — no live traffic in tests. Covers:
 *  1. Preset resolution incl. the documented sentinel rule.
 *  2. Config validation for provider/auth/endpoint/key fields.
 *  3. Client auth modes (bearer required vs self-hosted none).
 *  4. Response model-echo enforcement per provider family.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  JevClient,
  resolveDecisionProvider,
  validateConfig,
} from "../../packages/core/src/index.ts";

const LAYA_RESPONSE = {
  id: "laya-1",
  model: "convaiinnovations/laya",
  answers: { is_bug: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 5 },
};

const QUESTIONS = { is_bug: { type: "noul", instructions: "bug?" } } as never;

function stubFetch(response: unknown, capture?: { headers?: Record<string, string>; url?: string }) {
  return async (url: string, init: { headers: Record<string, string> }) => {
    if (capture) {
      capture.url = url;
      capture.headers = init.headers;
    }
    return { ok: true, status: 200, json: async () => response };
  };
}

test("defaults resolve to the Jev preset", () => {
  const resolved = resolveDecisionProvider({});
  assert.equal(resolved.id, "jev");
  assert.equal(resolved.endpoint, "https://openrouter.ai/api/v1/systemone");
  assert.equal(resolved.model, "typesafe/jev-1.13");
  assert.equal(resolved.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(resolved.requireAuth, true);
  assert.equal(resolved.modelMatch, "jev");
});

test("laya-local inherits its preset; legacy model counts as unset", () => {
  const resolved = resolveDecisionProvider({ provider: "laya-local" });
  assert.equal(resolved.endpoint, "http://127.0.0.1:8000/v1/systemone");
  assert.equal(resolved.model, "convaiinnovations/laya");
  assert.equal(resolved.apiKeyEnv, "LAYA_API_KEY");
  // laya-serve is bearer-protected; unprotected dev servers opt out explicitly.
  assert.equal(resolved.requireAuth, true);
  assert.equal(resolveDecisionProvider({ provider: "laya-local", auth: "none" }).requireAuth, false);
  assert.equal(resolved.modelMatch, "laya");
  // Empty model and the legacy default both inherit the preset.
  assert.equal(resolveDecisionProvider({ provider: "laya-local", model: "" }).model, "convaiinnovations/laya");
  assert.equal(resolveDecisionProvider({ provider: "laya-local", model: "typesafe/jev-1.13" }).model, "convaiinnovations/laya");
  assert.equal(resolveDecisionProvider({ provider: "jev", model: "" }).model, "typesafe/jev-1.13");
  // Explicit choice always wins, even the legacy default on custom.
  assert.equal(
    resolveDecisionProvider({ provider: "laya-local", model: "my-fork/laya" }).model,
    "my-fork/laya",
  );
  assert.equal(
    resolveDecisionProvider({ provider: "custom", endpoint: "https://x/v1", model: "typesafe/jev-1.13" }).model,
    "typesafe/jev-1.13",
  );
});

test("explicit endpoint/key/auth/match override presets", () => {
  const resolved = resolveDecisionProvider({
    provider: "jev",
    endpoint: "https://proxy/v1/systemone",
    apiKeyEnv: "CORP_KEY",
    auth: "none",
    modelMatch: "",
  });
  assert.equal(resolved.endpoint, "https://proxy/v1/systemone");
  assert.equal(resolved.apiKeyEnv, "CORP_KEY");
  assert.equal(resolved.requireAuth, false);
  assert.equal(resolved.modelMatch, "jev");
  assert.equal(resolveDecisionProvider({ provider: "jev", auth: "bearer" }).requireAuth, true);
});

test("config validation gates provider fields", () => {
  assert.equal(validateConfig({ jev: { provider: "wat" } }).valid, false);
  assert.equal(validateConfig({ jev: { provider: "custom" } }).valid, false);
  assert.equal(validateConfig({ jev: { provider: "laya-hosted" } }).valid, false);
  assert.equal(validateConfig({ jev: { endpoint: "ftp://x" } }).valid, false);
  assert.equal(validateConfig({ jev: { apiKeyEnv: "not a var!" } }).valid, false);
  assert.equal(validateConfig({ jev: { auth: "sometimes" } }).valid, false);
  const good = validateConfig({
    jev: { provider: "laya-local", auth: "none", endpoint: "", apiKeyEnv: "", modelMatch: "" },
  });
  assert.equal(good.valid, true);
  assert.equal(good.value.jev.provider, "laya-local");
  const custom = validateConfig({
    jev: { provider: "custom", endpoint: "https://x/v1/systemone", model: "acme/d-1" },
  });
  assert.equal(custom.valid, true);
});

test("self-hosted auth none proceeds without a key and sends no header", async () => {
  const capture: { headers?: Record<string, string>; url?: string } = {};
  const client = new JevClient({
    config: {
      enabled: true,
      model: "convaiinnovations/laya",
      endpoint: "http://127.0.0.1:8000/v1/systemone",
      apiKeyEnv: "LAYA_API_KEY_DEFINITELY_UNSET",
      requireAuth: false,
      modelMatch: "laya",
      projectKey: "test",
    },
    fetchImpl: stubFetch(LAYA_RESPONSE, capture),
  });
  const result = await client.decide({ state: {}, questions: QUESTIONS });
  assert.equal(result.ok, true);
  assert.ok(!("Authorization" in (capture.headers ?? {})));
});

test("bearer auth still fails closed without a key", async () => {
  const client = new JevClient({
    config: {
      enabled: true,
      model: "typesafe/jev-1.13",
      endpoint: "https://openrouter.ai/api/v1/systemone",
      apiKeyEnv: "OPENROUTER_API_KEY_DEFINITELY_UNSET",
      requireAuth: true,
      modelMatch: "jev",
      projectKey: "test",
    },
    fetchImpl: stubFetch(LAYA_RESPONSE),
  });
  const result = await client.decide({ state: {}, questions: QUESTIONS });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-key");
});

test("response model echo is enforced per provider family", async () => {
  const jevClient = new JevClient({
    config: { enabled: true, requireAuth: false, modelMatch: "jev", projectKey: "t" },
    apiKey: null,
    fetchImpl: stubFetch(LAYA_RESPONSE),
  });
  const rejected = await jevClient.decide({ state: {}, questions: QUESTIONS });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "invalid-response");

  const openClient = new JevClient({
    config: { enabled: true, requireAuth: false, modelMatch: "", projectKey: "t" },
    apiKey: null,
    fetchImpl: stubFetch(LAYA_RESPONSE),
  });
  assert.equal((await openClient.decide({ state: {}, questions: QUESTIONS })).ok, true);
});

test("apiKeyEnv selects the credential variable", async () => {
  process.env.SUPRACORTEX_TEST_DECISION_KEY = "sekret";
  try {
    const capture: { headers?: Record<string, string> } = {};
    const client = new JevClient({
      config: {
        enabled: true,
        apiKeyEnv: "SUPRACORTEX_TEST_DECISION_KEY",
        requireAuth: true,
        modelMatch: "",
        projectKey: "t",
      },
      fetchImpl: stubFetch(LAYA_RESPONSE, capture),
    });
    assert.equal((await client.decide({ state: {}, questions: QUESTIONS })).ok, true);
    assert.equal(capture.headers?.Authorization, "Bearer sekret");
  } finally {
    delete process.env.SUPRACORTEX_TEST_DECISION_KEY;
  }
});
