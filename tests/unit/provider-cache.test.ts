/**
 * Provider cache policy tests.
 *
 * Covers:
 * - Default modes for known/unknown/router providers
 * - optimize-safe only on positive capability + allowlist
 * - zero-data-retention forces observe-only
 * - Digests are SHA-256 hex, stable per inputs, differ across provider/model family
 * - No raw paths/secrets in intent
 * - Adapter never mutates (applied: false)
 * - Capability downgrade path
 */

import test from "node:test";
import assert from "node:assert";
import {
  resolveProviderCachePolicy,
  type ProviderCachePolicyIntent,
  type HostCapabilities,
  measureTokens,
  measureTokensAsync,
  loadTiktokenESM,
  estimateTokens,
  estimateBytesTokens,
  normalizeProviderUsage,
  mapFlatUsageToNested,
} from "../../packages/core/src/index.ts";
import { processProviderCacheIntent, summarizeNativeUsageForStatus } from "../../packages/opencode/src/provider-cache-adapter.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_HOST_CAPS = {
  setProviderOptions: "unsupported" as const,
  setCacheBreakpoints: "unsupported" as const,
};

function makeCaps(
  overrides: Partial<HostCapabilities> = {},
): Pick<HostCapabilities, "setProviderOptions" | "setCacheBreakpoints"> {
  return { ...BASE_HOST_CAPS, ...overrides };
}

function resolve(
  overrides: Partial<{
    host: string;
    providerHint: string;
    modelHint: string;
    hostVersion: string;
    capability: Pick<HostCapabilities, "setProviderOptions" | "setCacheBreakpoints">;
    projectKey: string;
    stablePrefix: string;
    privacyPolicy: { zeroDataRetention?: boolean; dataResidency?: string };
  }>,
): ProviderCachePolicyIntent {
  return resolveProviderCachePolicy({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps(),
    projectKey: "/home/user/project",
    stablePrefix: "cache/v1",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Mode decisions
// ---------------------------------------------------------------------------

test("known host with unsupported setCacheBreakpoints → host-managed", () => {
  const intent = resolve({});
  assert.equal(intent.mode, "host-managed");
});

test("unknown host → observe-only", () => {
  const intent = resolve({
    host: "unknown",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "unsupported" }),
  });
  assert.equal(intent.mode, "observe-only");
});

test("mcp host → observe-only", () => {
  const intent = resolve({
    host: "mcp",
    providerHint: "anthropic",
    capability: makeCaps({ setCacheBreakpoints: "unsupported" }),
  });
  assert.equal(intent.mode, "observe-only");
});

test("optimize-safe when setCacheBreakpoints supported + known host + known provider", () => {
  const intent = resolve({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
    hostVersion: "1.18.0",
  });
  assert.equal(intent.mode, "optimize-safe");
});

test("optimize-safe for claude-code:anthropic when setCacheBreakpoints supported", () => {
  const intent = resolve({
    host: "claude-code",
    providerHint: "anthropic",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
    hostVersion: "0.1.0",
  });
  assert.equal(intent.mode, "optimize-safe");
});

test("setCacheBreakpoints supported + unknown provider → observe-only (not on allowlist)", () => {
  const intent = resolve({
    host: "opencode",
    providerHint: "unknown",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
  });
  assert.equal(intent.mode, "observe-only");
});

test("setCacheBreakpoints supported + unknown host → observe-only", () => {
  const intent = resolve({
    host: "unknown",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
  });
  assert.equal(intent.mode, "observe-only");
});

test("setCacheBreakpoints supported + router provider → observe-only", () => {
  // "unknown" provider hint acts as a router/unspecified provider
  const intent = resolve({
    host: "opencode",
    providerHint: "google",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
  });
  // "opencode:google" is not in the capability table
  assert.equal(intent.mode, "observe-only");
});

test("unknown hostVersion → observe-only, adapter applied:false + reason (fail-closed)", () => {
  const intent = resolve({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
    // hostVersion omitted → unknown
  });
  assert.equal(intent.mode, "observe-only");
  const result = processProviderCacheIntent(intent);
  assert.equal(result.applied, false);
  assert.ok(result.reason.includes("observe-only"));
});

test("malformed hostVersion → observe-only (fail-closed)", () => {
  for (const hostVersion of ["", "not-a-version", "1.x.0"]) {
    const intent = resolve({
      host: "opencode",
      providerHint: "openai",
      capability: makeCaps({ setCacheBreakpoints: "supported" }),
      hostVersion,
    });
    assert.equal(intent.mode, "observe-only", `version ${JSON.stringify(hostVersion)}`);
  }
});

test("known newer hostVersion ≥ sinceVersion → optimize-safe", () => {
  const intent = resolve({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
    hostVersion: "2.0.0",
  });
  assert.equal(intent.mode, "optimize-safe");
  assert.equal(intent.requestedTtl, "1h");
});

// ---------------------------------------------------------------------------
// Zero-data-retention
// ---------------------------------------------------------------------------

test("zeroDataRetention forces observe-only even when optimize-safe eligible", () => {
  const intent = resolve({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
    privacyPolicy: { zeroDataRetention: true },
  });
  assert.equal(intent.mode, "observe-only");
  assert.equal(intent.requestedTtl, undefined, "must omit requestedTtl");
});

test("zeroDataRetention forces observe-only for host-managed case", () => {
  const intent = resolve({
    host: "opencode",
    privacyPolicy: { zeroDataRetention: true },
  });
  assert.equal(intent.mode, "observe-only");
  assert.equal(intent.requestedTtl, undefined);
});

test("zeroDataRetention forces observe-only for unknown host", () => {
  const intent = resolve({
    host: "unknown",
    capability: makeCaps({ setCacheBreakpoints: "unsupported" }),
    privacyPolicy: { zeroDataRetention: true },
  });
  assert.equal(intent.mode, "observe-only");
  assert.equal(intent.requestedTtl, undefined);
});

// ---------------------------------------------------------------------------
// Digest stability and properties
// ---------------------------------------------------------------------------

test("digests are SHA-256 hex (64 chars)", () => {
  const intent = resolve({});
  assert.match(intent.projectKeyDigest, /^[a-f0-9]{64}$/);
  assert.match(intent.stablePrefixDigest, /^[a-f0-9]{64}$/);
});

test("digests are stable for identical inputs", () => {
  const a = resolve({});
  const b = resolve({});
  assert.equal(a.projectKeyDigest, b.projectKeyDigest);
  assert.equal(a.stablePrefixDigest, b.stablePrefixDigest);
});

test("digests differ across provider families", () => {
  const openai = resolve({ providerHint: "openai" });
  const anthropic = resolve({ providerHint: "anthropic" });
  assert.notEqual(openai.projectKeyDigest, anthropic.projectKeyDigest);
  assert.notEqual(openai.stablePrefixDigest, anthropic.stablePrefixDigest);
});

test("digests differ across model hints", () => {
  const gpt4 = resolve({ modelHint: "gpt-4o" });
  const claude = resolve({ modelHint: "claude-sonnet-4-20250514" });
  assert.notEqual(gpt4.projectKeyDigest, claude.projectKeyDigest);
});

test("digests differ across hosts", () => {
  const oc = resolve({ host: "opencode" });
  const cc = resolve({ host: "claude-code" });
  assert.notEqual(oc.projectKeyDigest, cc.projectKeyDigest);
});

test("digests are domain-scoped: key and prefix digests differ", () => {
  const intent = resolve({});
  assert.notEqual(intent.projectKeyDigest, intent.stablePrefixDigest);
  const otherKey = resolve({ projectKey: "/home/user/other-project" });
  assert.notEqual(otherKey.projectKeyDigest, intent.projectKeyDigest);
  assert.equal(otherKey.stablePrefixDigest, intent.stablePrefixDigest);
});

test("digests contain no raw paths or secrets", () => {  const intent = resolve({
    projectKey: "/home/user/project",
    stablePrefix: "cache/v1",
  });
  // SHA-256 hex means only 0-9 a-f — no slashes, dots, or raw text.
  assert.match(intent.projectKeyDigest, /^[a-f0-9]{64}$/);
  assert.match(intent.stablePrefixDigest, /^[a-f0-9]{64}$/);
  // Specifically ensure the raw values are not present.
  assert.doesNotMatch(intent.projectKeyDigest, /home/);
  assert.doesNotMatch(intent.stablePrefixDigest, /cache/);
});

// ---------------------------------------------------------------------------
// Adapter tests
// ---------------------------------------------------------------------------

test("adapter returns applied:false for host-managed", () => {
  const intent = resolve({});
  const result = processProviderCacheIntent(intent);
  assert.equal(result.applied, false);
  assert.ok(result.reason.includes("host-managed"));
});

test("adapter returns applied:false for observe-only", () => {
  const intent = resolve({
    host: "unknown",
    capability: makeCaps({ setCacheBreakpoints: "unsupported" }),
  });
  const result = processProviderCacheIntent(intent);
  assert.equal(result.applied, false);
  assert.ok(result.reason.includes("observe-only"));
});

test("adapter returns applied:false for optimize-safe with gated explanation", () => {
  const intent = resolve({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
    hostVersion: "1.18.0",
  });
  const result = processProviderCacheIntent(intent);
  assert.equal(result.applied, false);
  assert.ok(result.reason.includes("gated experimental"));
});

test("adapter never mutates (all modes applied:false)", () => {
  // All three modes
  const modes = ["host-managed", "observe-only", "optimize-safe"] as const;
  for (const mode of modes) {
    const intent: ProviderCachePolicyIntent = {
      mode,
      projectKeyDigest: "0".repeat(64),
      stablePrefixDigest: "0".repeat(64),
    };
    const result = processProviderCacheIntent(intent);
    assert.equal(result.applied, false, `mode ${mode} must have applied: false`);
  }
});

// ---------------------------------------------------------------------------
// Capability downgrade path
// ---------------------------------------------------------------------------

test("capability downgrade supported→unsupported falls back to host-managed", () => {
  // With supported + known host+provider + known version → optimize-safe
  const supported = resolve({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
    hostVersion: "1.18.0",
  });
  assert.equal(supported.mode, "optimize-safe");

  // Same inputs but unsupported → host-managed
  const unsupported = resolve({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "unsupported" }),
  });
  assert.equal(unsupported.mode, "host-managed");
});

test("capability downgrade for unknown host → observe-only in both cases", () => {
  const supported = resolve({
    host: "unknown",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
  });
  assert.equal(supported.mode, "observe-only");

  const unsupported = resolve({
    host: "unknown",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "unsupported" }),
  });
  assert.equal(unsupported.mode, "observe-only");
});

test("requestedTtl only present for optimize-safe, absent for others", () => {
  const optimizeSafe = resolve({
    host: "opencode",
    providerHint: "openai",
    capability: makeCaps({ setCacheBreakpoints: "supported" }),
    hostVersion: "1.18.0",
  });
  assert.equal(optimizeSafe.mode, "optimize-safe");
  assert.equal(optimizeSafe.requestedTtl, "1h");

  const hostManaged = resolve({ host: "opencode" });
  assert.equal(hostManaged.requestedTtl, undefined);

  const observeOnly = resolve({
    host: "unknown",
    capability: makeCaps({ setCacheBreakpoints: "unsupported" }),
  });
  assert.equal(observeOnly.requestedTtl, undefined);
});

// ---------------------------------------------------------------------------
// Measurement honesty: tiktoken primary, labeled estimate fallback (2c)
// ---------------------------------------------------------------------------

test("measureTokens returns a labeled result; empty text measures 0", () => {
  const empty = measureTokens("");
  assert.equal(empty.tokens, 0);
  assert.equal(empty.estimated, false);
  const r = measureTokens("hello world", "gpt-4o");
  assert.ok(Number.isInteger(r.tokens) && r.tokens > 0);
  assert.equal(typeof r.estimated, "boolean");
  assert.ok(r.method.startsWith("tiktoken:") || r.method === "chars/4-fallback");
  if (r.estimated) {
    assert.equal(r.method, "chars/4-fallback");
    assert.ok(r.modelRatioNote?.includes("gpt-4o"), "fallback names the model ratio");
  }
});

test("measureTokens fallback is always labeled estimated:true with a ratio note", () => {
  // An unknown model forces the tokenizer-mismatch path when tiktoken exists,
  // and the unavailable path when it does not — both must be labeled.
  const r = measureTokens("some text", "definitely-not-a-real-model-xyz");
  assert.equal(typeof r.estimated, "boolean");
  if (r.estimated) {
    assert.equal(r.method, "chars/4-fallback");
    assert.ok(typeof r.modelRatioNote === "string" && r.modelRatioNote.length > 0);
  }
  // The splitting heuristic stays available and honest about being an estimate.
  assert.ok(estimateTokens("hello world") > 0);
  assert.equal(estimateBytesTokens(Number.NaN), 0);
  assert.equal(estimateBytesTokens(-5), 0);
});

test("loader tries ESM then falls back labeled; async path never throws", async () => {
  // js-tiktoken is an optional dep: absent → ESM import resolves null, sync
  // require probe misses, result is the labeled chars/4 fallback (never throws).
  const esm = await loadTiktokenESM();
  assert.ok(esm === null || typeof esm.encodingForModel === "function" || typeof esm.getEncoding === "function");
  const r = await measureTokensAsync("hello world estimator probe", "gpt-4o");
  assert.ok(r.method.startsWith("tiktoken:") || r.method === "chars/4-fallback");
  assert.equal(typeof r.estimated, "boolean");
  if (r.method === "chars/4-fallback") {
    assert.equal(r.estimated, true);
    assert.ok(r.modelRatioNote?.includes("gpt-4o"));
  }
});

// ---------------------------------------------------------------------------
// Disjoint billed usage: measured only, N/A never 0% (2d)
// ---------------------------------------------------------------------------

test("normalizeProviderUsage maps OpenAI fields disjointly", () => {
  const u = normalizeProviderUsage(
    { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 },
    "openai",
  );
  assert.equal(u.supported, true);
  assert.equal(u.cacheRead, 400);
  assert.equal(u.cacheWrite, 100);
  assert.equal(u.input, 600, "input is exclusive of reads (disjoint)");
  assert.equal(u.billedInput, 600 + 400 + 100);
  assert.equal(u.hitRate, 0.4);
  assert.equal(u.invariantOk, true);
});

test("normalizeProviderUsage maps Anthropic cached_tokens", () => {
  const u = normalizeProviderUsage(
    { input_tokens: 500, cached_tokens: 250 },
    "anthropic",
  );
  assert.equal(u.supported, true);
  assert.equal(u.cacheRead, 250);
  assert.equal(u.input, 250);
  assert.equal(u.billedInput, 500);
  assert.equal(u.hitRate, 0.5);
});

test("normalizeProviderUsage DeepSeek hit+miss must equal prompt_tokens", () => {
  const ok = normalizeProviderUsage(
    { prompt_tokens: 100, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70 },
    "deepseek",
  );
  assert.equal(ok.supported, true);
  assert.equal(ok.invariantOk, true);
  assert.equal(ok.cacheRead, 30);
  const bad = normalizeProviderUsage(
    { prompt_tokens: 100, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 60 },
    "deepseek",
  );
  assert.equal(bad.invariantOk, false, "hit+miss != prompt_tokens violates the invariant");
});

test("normalizeProviderUsage enforces read+created≤total by clamping", () => {
  const u = normalizeProviderUsage(
    { input_tokens: 100, cache_read_input_tokens: 90, cache_creation_input_tokens: 50 },
    "openai",
  );
  assert.equal(u.invariantOk, false);
  assert.ok(u.cacheRead + u.cacheWrite <= 100, "clamped into the total");
  assert.equal(u.billedInput, u.input + u.cacheRead + u.cacheWrite);
});

test("normalizeProviderUsage N/A provider: supported:false, hitRate:null, never 0%", () => {
  for (const provider of ["ollama", "local"]) {
    const u = normalizeProviderUsage({ input_tokens: 10 }, provider);
    assert.equal(u.supported, false);
    assert.equal(u.hitRate, null);
  }
  const missing = normalizeProviderUsage({}, "openai");
  assert.equal(missing.supported, false);
  assert.equal(missing.hitRate, null);
  const nul = normalizeProviderUsage(null, "openai");
  assert.equal(nul.supported, false);
  assert.equal(nul.hitRate, null);
});

test("mapFlatUsageToNested maps OmniRoute flat keys", () => {
  const nested = mapFlatUsageToNested({
    inputTokens: 1000,
    outputTokens: 50,
    cacheReadTokens: 200,
    cacheWriteTokens: 20,
  });
  assert.equal(nested.input_tokens, 1000);
  assert.equal(nested.output_tokens, 50);
  assert.equal(nested.cache_read_input_tokens, 200);
  assert.equal(nested.cache_creation_input_tokens, 20);
  const u = normalizeProviderUsage(nested, "openai");
  assert.equal(u.supported, true);
  assert.equal(u.cacheRead, 200);
  assert.equal(u.billedInput, 800 + 200 + 20);
});

test("adapter status helper reports N/A honestly, measured values otherwise", () => {
  const na = summarizeNativeUsageForStatus({ input_tokens: 5 }, "ollama");
  assert.ok(na.summary.includes("N/A"));
  assert.equal(na.usage.supported, false);
  const ok = summarizeNativeUsageForStatus(
    { input_tokens: 1000, cache_read_input_tokens: 500 },
    "openai",
  );
  assert.ok(ok.summary.includes("reads 500"));
  assert.ok(ok.summary.includes("hit rate 50.0%"));
});
