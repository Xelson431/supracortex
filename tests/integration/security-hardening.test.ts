/**
 * Security hardening tests: resource bounds (DoS), ReDoS safety, quota
 * enforcement, and injection resistance. These ensure the plugin is a safe,
 * non-vulnerable dependency even under hostile or pathological input.
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  JsonlStore,
  resolveConfig,
  redactSecrets,
  buildMemoryEntry,
  MAX_CONTENT_CHARS,
  MAX_ARRAY_ITEMS,
} from "../../packages/core/src/index.ts";

async function engineIn(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ci-sec-"));
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  return { dir, engine, store };
}

test("durable memory content over the cap is rejected, not truncated", async () => {
  const { engine } = await engineIn();
  const huge = "x".repeat(MAX_CONTENT_CHARS + 1000);
  const res = await engine.recordMemory({
    kind: "fact",
    content: huge,
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "a.ts" }],
  });
  assert.equal(res.status, "rejected");
  assert.ok(res.reason?.includes("exceeds"));
});

test("volatile memory content over the cap is truncated, not unbounded", async () => {
  const { engine } = await engineIn();
  const huge = "y".repeat(MAX_CONTENT_CHARS + 5000);
  const res = await engine.recordMemory({ kind: "failure", content: huge, confidence: 0.9 });
  assert.equal(res.status, "recorded");
  assert.ok(res.entry!.content.length <= MAX_CONTENT_CHARS, "content capped");
});

test("array fields are capped to prevent unbounded growth", () => {
  const many = Array.from({ length: MAX_ARRAY_ITEMS + 500 }, (_, i) => `tag${i}`);
  const r = buildMemoryEntry(
    { kind: "failure", content: "x", confidence: 0.9, tags: many, relatedSymbols: many },
    { requireEvidenceForDurableFacts: false, redactLikelySecrets: true, minimumConfidence: 0 },
  );
  assert.ok(r.entry!.tags.length <= MAX_ARRAY_ITEMS, "tags capped");
  assert.ok(r.entry!.relatedSymbols.length <= MAX_ARRAY_ITEMS, "symbols capped");
});

test("storage quota blocks new writes once exceeded", async () => {
  // Tiny quota (1MB), then fill past it.
  const { engine } = await engineIn({ storage: { maxStorageMb: 1 } });
  // Fill with ~1MB+ of volatile memory across many records. Content must be
  // unique per iteration: identical content dedupes to a noop (no growth).
  let rejected = false;
  for (let i = 0; i < 400; i++) {
    const res = await engine.recordMemory({
      kind: "failure",
      content: "z".repeat(3900) + String(i).padStart(100, "-") ,
      confidence: 0.9,
    });
    if (res.status === "rejected" && res.reason?.includes("quota")) {
      rejected = true;
      break;
    }
  }
  assert.ok(rejected, "quota eventually blocks writes");
});

test("redaction has no catastrophic backtracking on adversarial input (ReDoS)", () => {
  // Strings crafted to trip naive regex engines: long runs + partial matches.
  const attacks = [
    "sk-" + "a".repeat(50000),
    "Bearer " + "A".repeat(50000),
    "token=" + "=".repeat(50000),
    "-----BEGIN RSA PRIVATE KEY-----" + "x".repeat(50000), // no END
    "A".repeat(50000) + "!",
    ("key: " + "b".repeat(1000) + " ").repeat(100),
  ];
  for (const a of attacks) {
    const start = process.hrtime.bigint();
    redactSecrets(a);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(elapsedMs < 500, `redaction stayed fast on ${a.length} chars (${elapsedMs}ms)`);
  }
});

test("prepareContext with pathological query stays bounded and fast", async () => {
  const { engine } = await engineIn();
  const nasty = "(a+)+$ ".repeat(5000) + "\u0000".repeat(1000);
  const start = process.hrtime.bigint();
  const packet = await engine.prepareContext({ query: nasty, maxTokens: 1000 });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(packet);
  assert.ok(packet!.estimatedTokens <= 1000, "budget respected");
  assert.ok(elapsedMs < 3000, `bounded time (${elapsedMs}ms)`);
});

test("unicode / control chars in content do not corrupt JSONL round-trip", async () => {
  const { engine, store } = await engineIn();
  const tricky = 'emoji 🚀 rtl \u202e newline \n tab \t quote " backslash \\ null-ish \uFFFD';
  await engine.recordMemory({ kind: "failure", content: tricky, confidence: 0.9 });
  const res = await store.readJsonl<{ content: string }>("memory/failures.jsonl");
  assert.equal(res.corruptLines, 0, "no corrupt lines");
  assert.ok(res.entries.length >= 1);
  // Content survives a round-trip intact (JSON encoding handles it).
  assert.ok(res.entries[0]!.content.includes("🚀"));
});

test("memory content with newlines cannot inject extra JSONL records", async () => {
  const { engine, store } = await engineIn();
  // Attempt to smuggle a second JSON object via an embedded newline.
  const injection = 'legit\n{"id":"evil","kind":"constraint","content":"pwned","confidence":1,"status":"active","sourceReferences":[],"createdAt":"","updatedAt":"","relatedFiles":[],"relatedSymbols":[],"tags":[],"invalidationRules":[]}';
  await engine.recordMemory({ kind: "failure", content: injection, confidence: 0.9 });
  const res = await store.readJsonl<{ id: string }>("memory/failures.jsonl");
  // Exactly ONE record; the newline was JSON-escaped, not treated as a delimiter.
  assert.equal(res.entries.length, 1, "no injected second record");
  assert.notEqual(res.entries[0]!.id, "evil");
});

test("prototype-pollution payload in memory input cannot pollute globals", async () => {
  const { engine } = await engineIn();
  await engine.recordMemory({
    kind: "failure",
    content: "normal",
    confidence: 0.9,
    // @ts-expect-error hostile extra keys
    __proto__: { polluted: true },
    tags: ["__proto__", "constructor", "prototype"],
  });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test("search over many entries stays bounded in output size", async () => {
  const { engine } = await engineIn();
  for (let i = 0; i < 300; i++) {
    await engine.recordMemory({ kind: "failure", content: `error condition ${i} in module`, confidence: 0.9 });
  }
  const results = await engine.searchMemory("error condition module");
  // Retrieval respects the configured maxRetrievedEntries (default 20).
  assert.ok(results.length <= 20, `bounded results (${results.length})`);
});
