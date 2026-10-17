import assert from "node:assert/strict";
/**
 * Jev integration tests (preview branch only). All network calls are stubbed —
 * no live OpenRouter traffic in tests. Covers:
 *  1. validateDecisionsResponse: accept real tutorial response shape; reject malformed.
 *  2. Score->candidate mapping; unknown-ID Choice rejection; low-confidence fallback.
 *  3. No-candidate-invention: router drops unknown IDs, never adds candidates.
 *  4. Client: bounded deadline, cooldown after 3 failures, decision cache + invalidation.
 *  5. Config: jev.* defaults OFF, validation ranges; disabled-by-default behavior.
 */
import test from "node:test";
import {
  DEFAULT_CONFIG,
  JEV_MODEL,
  JEV_SYSTEMONE_URL,
  JevClient,
  fallbackRouting,
  resolveDecisionProvider,
  jevJudgeMemory,
  jevRerankMemories,
  jevReview,
  jevRoute,
  jevSelectSkillsMcp,
  memoryJudgmentQuestions,
  readChoice,
  readDepthBucket,
  readMemoryVerdict,
  readNoul,
  rerankQuestions,
  reviewQuestions,
  routingQuestions,
  scoreToCandidateRelevance,
  skillMcpQuestions,
  validateConfig,
  validateDecisionsResponse,
} from "../../packages/core/src/index.ts";
import type { JevDecisionsResponse } from "../../packages/core/src/index.ts";

// The actual tutorial response shape (captured from the live API per docs).
const TUTORIAL_RESPONSE = {
  id: "gen-dec-1790015143-AIaTutprXsJ5EwohRSjb",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    is_bug: { type: "noul", noul: 0.96 },
    team: {
      type: "choice",
      choice: "payments",
      confidence: 0.67,
      probabilities: { payments: 0.78, frontend: 0.22, account: 0 },
    },
    urgency: {
      type: "score",
      score: 1.99,
      confidence: 0.99,
      probabilities: { 0: 0, 1: 0, 2: 1 },
      legend: {
        0: "Can wait for the next release",
        1: "Should be fixed this week",
        2: "Blocking revenue right now",
      },
    },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};

test("validateDecisionsResponse accepts the documented tutorial response", () => {
  const parsed = validateDecisionsResponse(TUTORIAL_RESPONSE);
  assert.ok(parsed);
  assert.equal(parsed.model, "typesafe/jev-1.13-20260917");
  assert.equal(parsed.answers.is_bug?.type, "noul");
  if (parsed.answers.is_bug?.type === "noul") assert.equal(parsed.answers.is_bug.noul, 0.96);
  assert.equal(parsed.usage.input_tokens, 476);
});

test("validateDecisionsResponse rejects malformed responses", () => {
  assert.equal(validateDecisionsResponse(null), null);
  assert.equal(validateDecisionsResponse({}), null);
  assert.equal(validateDecisionsResponse({ model: "x", answers: {}, usage: {} }), null);
  // Bad noul value
  assert.equal(
    validateDecisionsResponse({
      model: JEV_MODEL,
      answers: { q: { type: "noul" } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    null,
  );
  // Unknown answer type
  assert.equal(
    validateDecisionsResponse({
      model: JEV_MODEL,
      answers: { q: { type: "generate", text: "hi" } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    null,
  );
  // Probability out of range
  assert.equal(
    validateDecisionsResponse({
      model: JEV_MODEL,
      answers: { q: { type: "choice", choice: "a", probabilities: { a: 1.5 } } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    null,
  );
});

test("readChoice rejects unknown candidate IDs (no invention)", () => {
  const parsed = validateDecisionsResponse(TUTORIAL_RESPONSE);
  assert.ok(parsed);
  // "payments" is not in this restricted allowlist -> null, caller keeps deterministic result.
  assert.equal(readChoice(parsed.answers.team, new Set(["frontend", "account"])), null);
  // Fully invented answer choice -> null.
  assert.equal(
    readChoice({ type: "choice", choice: "orbital-laser-team", confidence: 0.99 }, [
      "payments",
      "frontend",
    ]),
    null,
  );
  const ok = readChoice(parsed.answers.team, ["payments", "frontend", "account"]);
  assert.ok(ok && ok.choice === "payments");
  // Probabilities are filtered to the allowlist (account dropped when not allowed).
  const filtered = readChoice(parsed.answers.team, ["payments", "frontend"]);
  assert.ok(filtered && !("account" in filtered.probabilities));
});

test("readNoul + bucket/verdict readers gate on known alternatives", () => {
  const parsed = validateDecisionsResponse(TUTORIAL_RESPONSE);
  assert.ok(parsed);
  assert.equal(readNoul(parsed.answers.is_bug)?.yes, 0.96);
  assert.equal(readNoul(parsed.answers.team), null);
  assert.equal(readDepthBucket({ type: "choice", choice: "hyperdrive", confidence: 0.9 }), null);
  assert.equal(readDepthBucket({ type: "choice", choice: "deep", confidence: 0.9 })?.depth, "deep");
  assert.equal(
    readMemoryVerdict({ type: "choice", choice: "retain", confidence: 0.8 })?.verdict,
    "retain",
  );
});

test("scoreToCandidateRelevance maps positions, nulls on low confidence", () => {
  const parsed = validateDecisionsResponse(TUTORIAL_RESPONSE);
  assert.ok(parsed);
  const ids = ["a", "b", "c"];
  const rel = scoreToCandidateRelevance(parsed.answers.urgency, ids);
  assert.ok(rel);
  // score 1.99 of 3 levels -> last candidate most relevant.
  assert.ok((rel.at(2)?.score ?? -1) > (rel.at(0)?.score ?? -1));
  const low = scoreToCandidateRelevance({ type: "score", score: 2, confidence: 0.1 }, ids);
  assert.equal(low, null);
  assert.deepEqual(scoreToCandidateRelevance(parsed.answers.urgency, []), []);
});

function stubFetch(
  response: JevDecisionsResponse,
  opts: { status?: number; delayMs?: number; calls?: { n: number } } = {},
) {
  return async (_url: string, init: { signal: AbortSignal }) => {
    opts.calls && opts.calls.n++;
    if (opts.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
    }
    return {
      ok: (opts.status ?? 200) === 200,
      status: opts.status ?? 200,
      json: async () => response,
    };
  };
}

const OK_RESPONSE: JevDecisionsResponse = {
  model: "typesafe/jev-1.13-test",
  answers: {
    enrich: { type: "noul", noul: 0.9 },
    depth: { type: "choice", choice: "standard", confidence: 0.8 },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

test("client returns disabled without network when not enabled", async () => {
  const client = new JevClient({
    config: { enabled: false },
    apiKey: "k",
    fetchImpl: stubFetch(OK_RESPONSE),
  });
  const res = await client.decide({ state: {}, questions: routingQuestions() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "disabled");
});

test("client requires an API key (missing-key, no throw)", async () => {
  const client = new JevClient({
    config: { enabled: true },
    apiKey: "",
    fetchImpl: stubFetch(OK_RESPONSE),
  });
  const res = await client.decide({ state: {}, questions: routingQuestions() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "missing-key");
});

test("client enforces bounded deadline via abort", async () => {
  const client = new JevClient({
    config: { enabled: true, deadlineMs: 30 },
    apiKey: "test-key",
    fetchImpl: stubFetch(OK_RESPONSE, { delayMs: 500 }),
  });
  const res = await client.decide({ state: {}, questions: routingQuestions() });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "timeout");
});

test("client cools down after 3 consecutive failures", async () => {
  const fail = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const client = new JevClient({ config: { enabled: true }, apiKey: "k", fetchImpl: fail });
  for (let i = 0; i < 3; i++) {
    const res = await client.decide({ state: { n: i }, questions: routingQuestions() });
    assert.equal(res.ok, false);
  }
  assert.equal(client.coolingDown, true);
  const cooled = await client.decide({ state: {}, questions: routingQuestions() });
  assert.equal(cooled.ok, false);
  if (!cooled.ok) assert.equal(cooled.reason, "cooldown");
});

test("client caches identical decisions and isolates by evidence key", async () => {
  const calls = { n: 0 };
  const counting = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ) => {
    calls.n++;
    return stubFetch(OK_RESPONSE)(url, init);
  };
  const client = new JevClient({ config: { enabled: true }, apiKey: "k", fetchImpl: counting });
  const base = {
    state: { q: "x" },
    questions: routingQuestions(),
    taskKey: "t",
    policyKey: "route",
    configKey: "c",
  };
  const first = await client.decide({ ...base, evidenceKey: "e1" });
  assert.equal(first.ok, true);
  const usage1 = client.takeLastUsage();
  assert.ok(usage1?.issuedCall && !usage1.fromCache);
  assert.equal(usage1.inputTokens, OK_RESPONSE.usage.input_tokens);
  const second = await client.decide({ ...base, evidenceKey: "e1" });
  assert.equal(second.ok && second.fromCache, true);
  const usage2 = client.takeLastUsage();
  assert.ok(usage2?.fromCache && !usage2.issuedCall);
  await client.decide({ ...base, evidenceKey: "e2-changed-evidence" });
  assert.equal(calls.n, 2);
});

test("jevRoute falls back deterministically when Jev is off", async () => {
  const client = new JevClient({ config: { enabled: false }, apiKey: "k" });
  const decision = await jevRoute(client, {
    query: "fix login",
    tags: [],
    taskKey: "t",
    evidenceKey: "e",
    configKey: "c",
  });
  assert.deepEqual(decision, fallbackRouting());
  assert.equal(decision.fromJev, false);
});

test("jevRoute applies confident Jev answers", async () => {
  const client = new JevClient({
    config: { enabled: true },
    apiKey: "k",
    fetchImpl: stubFetch(OK_RESPONSE),
  });
  const decision = await jevRoute(client, {
    query: "fix login",
    tags: [],
    taskKey: "t",
    evidenceKey: "e",
    configKey: "c",
  });
  assert.equal(decision.fromJev, true);
  assert.equal(decision.enrich, true);
  assert.equal(decision.depth, "standard");
});

test("jevSelectSkillsMcp only returns supplied candidates", async () => {
  const resp: JevDecisionsResponse = {
    model: "typesafe/jev-1.13-t",
    answers: { skill: { type: "choice", choice: "invented-skill", confidence: 0.99 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const client = new JevClient({
    config: { enabled: true },
    apiKey: "k",
    fetchImpl: stubFetch(resp),
  });
  const decision = await jevSelectSkillsMcp(client, {
    query: "q",
    tags: [],
    taskKey: "t",
    evidenceKey: "e",
    configKey: "c",
    skills: [{ name: "real-skill", description: "does things" }],
    mcpTools: [],
    mcpServers: [],
  });
  // Invented skill rejected -> full fallback (never applied).
  assert.equal(decision.fromJev, false);
  assert.deepEqual(decision.skills, []);
});

test("jevRerankMemories keeps deterministic order on uncertainty", async () => {
  const uncertain: JevDecisionsResponse = {
    model: "typesafe/jev-1.13-t",
    answers: { rerank_memory: { type: "score", score: 1, confidence: 0.1 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const client = new JevClient({
    config: { enabled: true },
    apiKey: "k",
    fetchImpl: stubFetch(uncertain),
  });
  const mk = (id: string) => ({
    entry: { id, kind: "fact", content: `content ${id}`, confidence: 0.8 } as never,
    score: 0.5,
    reason: "r",
    estimatedTokens: 10,
  });
  const out = await jevRerankMemories(client, {
    query: "q",
    tags: [],
    taskKey: "t",
    evidenceKey: "e",
    configKey: "c",
    shortlisted: [mk("a"), mk("b"), mk("c")],
  });
  assert.equal(out, null);
});

test("jevJudgeMemory never vetoes: uncertain verdict returns retain fallback", async () => {
  const uncertain: JevDecisionsResponse = {
    model: "typesafe/jev-1.13-t",
    answers: {
      retain: { type: "choice", choice: "discard", confidence: 0.2 },
      kind: { type: "choice", choice: "fact", confidence: 0.9 },
      duplicate: { type: "noul", noul: 0.1 },
      contradiction: { type: "noul", noul: 0.1 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const client = new JevClient({
    config: { enabled: true },
    apiKey: "k",
    fetchImpl: stubFetch(uncertain),
  });
  const judgment = await jevJudgeMemory(client, {
    query: "q",
    tags: [],
    taskKey: "t",
    evidenceKey: "e",
    configKey: "c",
    content: "learning",
    relatedFiles: [],
    existingSummaries: [],
  });
  assert.equal(judgment.fromJev, false);
  assert.equal(judgment.verdict, "retain");
});

test("jevReview returns fallback when Jev is off", async () => {
  const client = new JevClient({ config: { enabled: false }, apiKey: "k" });
  const decision = await jevReview(client, {
    query: "q",
    tags: [],
    taskKey: "t",
    evidenceKey: "e",
    configKey: "c",
    evidence: { status: "success" },
  });
  assert.equal(decision.fromJev, false);
  assert.equal(decision.recommendReview, false);
});

test("question builders carry none/unknown alternatives and stay bounded", () => {
  const routing = routingQuestions();
  assert.ok(routing.enrich && routing.depth);
  const sm = skillMcpQuestions({
    skills: [{ name: "s", description: "d" }],
    mcpTools: [{ id: "srv:tool", description: "d" }],
    mcpServers: [{ name: "srv", description: "d" }],
  });
  assert.ok("none" in (sm.skill as { criteria: Record<string, string> }).criteria);
  const rerank = rerankQuestions([{ key: "memory", label: "memory entries", count: 5 }]);
  assert.ok(rerank.rerank_memory);
  assert.ok(memoryJudgmentQuestions().retain && reviewQuestions().review);
});

test("V2 projection carries skill/MCP guidance within final budget", async () => {
  const { projectContextPacketV2 } = await import("../../packages/core/src/context/wire-budget.ts");
  const { renderPacketForPromptDetailed } = await import(
    "../../packages/opencode/src/packet-rendering.ts"
  );
  const packet = {
    taskId: "t",
    taskSummary: "s",
    selectedMemory: [],
    selectedFiles: [],
    selectedSummaries: [],
    constraints: [],
    knownFailures: [],
    estimatedTokens: 10,
    budget: { maxTokens: 4000, usedTokens: 10, remainingTokens: 3990 },
    cacheReport: { mode: "miss", key: "k" },
    omissions: [],
    recommendedSkills: [{ name: "skill-a", reason: "jev-selected", priority: 1, needsLoad: true }],
    excludedSkills: [],
    recommendedMcpTools: [
      {
        server: "srv",
        tool: "do",
        purpose: "jev-selected",
        mutating: false,
        requiresApproval: false,
      },
    ],
    excludedMcpServers: [],
    generatedAt: new Date().toISOString(),
  } as never;
  const projected = projectContextPacketV2(packet);
  assert.equal(projected.recommendations.skills.length, 1);
  assert.equal(projected.recommendations.mcpTools.length, 1);
  const rendered = renderPacketForPromptDetailed(projected);
  assert.ok(rendered.text.includes("skill-guidance"));
  assert.ok(rendered.text.includes("mcp-guidance"));
  assert.equal(rendered.packet.recommendations.skills.length, 1);
  // Tight budget drops guidance (placed after evidence) instead of breaking limits.
  const tiny = renderPacketForPromptDetailed(projected, { maxBytes: 400 });
  assert.ok(tiny.payloadBytes <= 400);
});

test("jev config defaults on with validated ranges and permits opt-out", () => {
  assert.equal(DEFAULT_CONFIG.jev.enabled, true);
  // Empty model = inherit the provider preset; Jev's preset model is JEV_MODEL.
  assert.equal(DEFAULT_CONFIG.jev.model, "");
  assert.equal(resolveDecisionProvider(DEFAULT_CONFIG.jev).model, JEV_MODEL);
  assert.equal(DEFAULT_CONFIG.jev.deadlineMs, -1, "provider default");
  assert.equal(JEV_SYSTEMONE_URL, "https://openrouter.ai/api/v1/systemone");
  const bad = validateConfig({
    jev: { enabled: true, deadlineMs: 5, minConfidence: 9, model: "x".repeat(201) },
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes("jev.")));
  const good = validateConfig({ jev: { enabled: false } });
  assert.equal(good.valid, true);
  assert.equal(good.value.jev.enabled, false);
});
