/**
 * P11: SupraCode identity builders — pure strings, bounded, one voice.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  disabledCortex,
  footerStatus,
  headerLines,
  PRODUCT_NAME,
  projectLabel,
  PROVIDER_USER_AGENT,
  providerSessionHeaders,
  unavailable,
  windowTitle,
} from "../../packages/pi/src/brand.ts";
import supracortexExtension from "../../packages/pi/src/extension.ts";
import { wrapFetchForOpenCodeParity } from "../../packages/pi/src/provider-fetch.ts";

test("identity: name, header, title, project label bounds", () => {
  assert.equal(PRODUCT_NAME, "SupraCode Pi");
  const lines = headerLines({ project: "esim-saudi", cortex: "on" });
  assert.ok(lines[1]!.includes("SupraCode Pi") && lines[1]!.includes("esim-saudi") && lines[1]!.includes("cortex on"));
  assert.equal(windowTitle("/root/projects/esim-saudi"), "SupraCode Pi — projects/esim-saudi");
  assert.equal(projectLabel("/"), "project");
  const long = projectLabel(`/${"a".repeat(100)}`);
  assert.ok(long.length <= 40);
});

test("footer slot: idle clears, running counts, stuck is explicit", () => {
  assert.equal(footerStatus({ running: 0, stuck: false, admissionsBlocked: false }), undefined);
  assert.equal(footerStatus({ running: 2, stuck: false, admissionsBlocked: false }), "cortex: 2 job(s)");
  assert.ok((footerStatus({ running: 0, stuck: true, admissionsBlocked: false }) ?? "").includes("stuck"));
  const blocked = footerStatus({ running: 1, stuck: false, admissionsBlocked: true });
  assert.ok(blocked?.includes("admissions blocked") && blocked.includes("exit CLI"));
});

test("voice: errors name the fix location", () => {
  assert.ok(unavailable("boom").includes("supracortex logs"));
  assert.ok(disabledCortex("SUPRACORTEX_DISABLE").includes("Pi still runs"));
});

test("provider identity: User-Agent matches OpenCode", async () => {
  assert.match(PROVIDER_USER_AGENT, /^opencode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/[\d.]+ runtime\/bun\/[\d.]+$/);
  const pair = providerSessionHeaders();
  assert.match(pair["x-session-affinity"] ?? "", /^ses_[a-z0-9]+$/);
  assert.equal(pair["x-session-id"], pair["x-session-affinity"]);
  const hooks = new Map<string, (event: never) => Promise<unknown>>();
  const fakePi = {
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (event: string, handler: (event: never) => Promise<unknown>) => {
      hooks.set(event, handler);
      return () => undefined;
    },
    sendUserMessage: () => undefined,
  };
  supracortexExtension(fakePi as never);
  const handler = hooks.get("before_provider_headers");
  assert.ok(handler, "user-agent hook registered");
  const headers: Record<string, string | null> = {
    "User-Agent": "pi-default",
    "x-stainless-lang": "js",
    "X-Stainless-Runtime": "node",
  };
  await handler({ type: "before_provider_headers", headers } as never);
  assert.equal(headers["User-Agent"], PROVIDER_USER_AGENT);
  assert.equal(headers["x-stainless-lang"], null);
  assert.equal(headers["X-Stainless-Runtime"], null);
});

test("provider payload normalized to OpenCode shape", async () => {
  const hooks = new Map<string, (event: never) => Promise<unknown>>();
  const fakePi = {
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (event: string, handler: (event: never) => Promise<unknown>) => {
      hooks.set(event, handler);
      return () => undefined;
    },
    sendUserMessage: () => undefined,
  };
  supracortexExtension(fakePi as never);
  const handler = hooks.get("before_provider_request");
  assert.ok(handler, "payload hook registered");
  const out = (await handler({
    type: "before_provider_request",
    payload: { model: "m", messages: [], max_completion_tokens: 100, store: true, tools: [{ type: "function" }] },
  } as never)) as Record<string, unknown>;
  assert.equal(out["max_tokens"], 100);
  assert.ok(!("max_completion_tokens" in out) && !("store" in out));
  assert.equal(out["tool_choice"], "auto");
  const reasoning = (await handler({
    type: "before_provider_request",
    payload: {
      model: "m",
      messages: [],
      reasoning: { effort: "high" },
      reasoning_effort: "high",
      thinkingLevel: "high",
      thinking: { type: "enabled" },
    },
  } as never)) as Record<string, unknown>;
  for (const key of ["reasoning", "reasoning_effort", "thinkingLevel", "thinking"]) {
    assert.ok(!(key in reasoning), `${key} stripped like OpenCode's wire`);
  }
  const passthrough = await handler({ type: "before_provider_request", payload: null } as never);
  assert.equal(passthrough, undefined);
});

test("local OpenCode-compatible fetch strips only SDK fingerprint headers", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const wrapped = wrapFetchForOpenCodeParity(fakeFetch);
  const res = await wrapped("http://127.0.0.1:20128/v1/chat/completions", {
    method: "POST",
    headers: {
      "User-Agent": PROVIDER_USER_AGENT,
      "x-stainless-lang": "js",
      "x-stainless-runtime": "node",
      "x-session-id": "ses_test",
    },
    body: "{}",
  });
  assert.equal(res.status, 200);
  const headers = new Headers(captured[0]?.init?.headers);
  assert.equal(headers.get("x-stainless-lang"), null);
  assert.equal(headers.get("x-stainless-runtime"), null);
  assert.equal(headers.get("x-session-id"), "ses_test");
  assert.equal(headers.get("x-title"), "opencode");
  assert.equal(headers.get("referer"), "https://opencode.ai/");

  captured.length = 0;
  await wrapped("https://api.anthropic.com/v1/messages", {
    headers: { "User-Agent": PROVIDER_USER_AGENT, "x-stainless-lang": "js" },
  });
  assert.equal(captured[0]?.init?.headers && new Headers(captured[0].init.headers).get("x-stainless-lang"), "js", "non-loopback unchanged");
});
