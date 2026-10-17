import test from "node:test";
import assert from "node:assert";
import {
  buildContextPacket,
  buildQueryContext,
  scoreMemory,
  estimateTokens,
  TokenBudget,
  classifySummaries,
  selectFiles,
  resolveCompactionTrigger,
  secondReadBilledTokens,
  describeWireBudget,
} from "../../packages/core/src/index.ts";
import type { IndexedFile, MemoryEntry, FileSummary } from "../../packages/core/src/index.ts";
import { renderPacketForPrompt } from "../../packages/opencode/src/packet-rendering.ts";

function idxFile(path: string, symbols: string[], tokens = 100): IndexedFile {
  return {
    path,
    hash: "h-" + path,
    sizeBytes: tokens * 4,
    estimatedTokens: tokens,
    symbols,
    imports: [],
    indexedAt: new Date().toISOString(),
    mtimeMs: 1,
  };
}

test("token budget enforces limits", () => {
  const b = new TokenBudget(100);
  assert.equal(b.tryConsume(60), true);
  assert.equal(b.tryConsume(60), false);
  assert.equal(b.remaining, 40);
});

test("estimateTokens grows with length", () => {
  assert.ok(estimateTokens("a".repeat(400)) > estimateTokens("a".repeat(40)));
});

test("classifySummaries splits valid/stale/missing", () => {
  const index = { "a.ts": idxFile("a.ts", []), "b.ts": idxFile("b.ts", []) };
  const summaries: Record<string, FileSummary> = {
    "a.ts": { path: "a.ts", sourceHash: "h-a.ts", summary: "s", estimatedTokens: 5, createdAt: "" },
    "b.ts": { path: "b.ts", sourceHash: "OLD", summary: "s", estimatedTokens: 5, createdAt: "" },
    "c.ts": { path: "c.ts", sourceHash: "x", summary: "s", estimatedTokens: 5, createdAt: "" },
  };
  const r = classifySummaries(summaries, index);
  assert.deepEqual(r.valid, ["a.ts"]);
  assert.deepEqual(r.stale, ["b.ts"]);
  assert.deepEqual(r.missing, ["c.ts"]);
});

test("context packet respects budget and explains selections", () => {
  const index: Record<string, IndexedFile> = {
    "auth/login.ts": idxFile("auth/login.ts", ["login", "authenticate"], 200),
    "unrelated/readme.md": idxFile("unrelated/readme.md", [], 5000),
  };
  const result = buildContextPacket({
    task: { query: "fix the login authenticate flow" },
    config: {
      maxTokens: 1000,
      maxRetrievedEntries: 10,
      maxRetrievedTokens: 500,
      maxRecommendedReads: 6,
      summaryThresholdTokens: 3000,
      preferChangedFiles: true,
    },
    index,
    summaries: {},
    memory: [],
    cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
  });
  const packet = result.packet;
  assert.ok(packet.estimatedTokens <= 1000);
  const login = packet.selectedFiles.find((f) => f.path === "auth/login.ts");
  assert.ok(login, "relevant file selected");
  assert.ok(login!.reason.length > 0, "selection has a reason");
});

test("context packet cache report counts per-request hits, misses, and stale rejections", () => {
  const index: Record<string, IndexedFile> = {
    "src/fresh.ts": idxFile("src/fresh.ts", ["login"], 100),
    "src/stale.ts": idxFile("src/stale.ts", ["login"], 100),
    "src/uncached.ts": idxFile("src/uncached.ts", ["login"], 100),
  };
  const summaries: Record<string, FileSummary> = {
    "src/fresh.ts": { path: "src/fresh.ts", sourceHash: "h-src/fresh.ts", summary: "fresh summary", estimatedTokens: 5, createdAt: "" },
    "src/stale.ts": { path: "src/stale.ts", sourceHash: "OLD", summary: "stale summary", estimatedTokens: 5, createdAt: "" },
  };
  const result = buildContextPacket({
    task: { query: "login" },
    config: {
      maxTokens: 1000,
      maxRetrievedEntries: 10,
      maxRetrievedTokens: 500,
      maxRecommendedReads: 6,
      summaryThresholdTokens: 3000,
      preferChangedFiles: true,
    },
    index,
    summaries,
    memory: [],
    cacheReport: { hits: 1, misses: 2, stale: 1, entries: 9 },
  });
  assert.deepEqual(result.packet.cacheReport, { hits: 1, misses: 2, stale: 1, entries: 9 });
  assert.equal(result.stats.staleSummariesRejected, 1);
  // The stale summary is never rendered as evidence, but its file can still be
  // recommended for a fresh read.
  assert.ok(!result.packet.selectedSummaries.some((s) => s.path === "src/stale.ts"));
  assert.ok(result.packet.selectedFiles.some((f) => f.path === "src/stale.ts"));
  // A path is never both selected and omitted.
  const omitted = new Set(result.packet.omissions.map((o) => o.path));
  for (const f of result.packet.selectedFiles) assert.ok(!omitted.has(f.path));
});

test("OpenCode wire renderer includes selected summary text and does not claim metadata is file content", () => {
  const packet = buildContextPacket({
    task: { query: "inspect auth" },
    config: { maxTokens: 1000, maxRetrievedEntries: 1, maxRetrievedTokens: 100, maxRecommendedReads: 1, summaryThresholdTokens: 1, preferChangedFiles: true },
    index: { "src/auth.ts": idxFile("src/auth.ts", ["login"], 10) },
    summaries: { "src/auth.ts": { path: "src/auth.ts", sourceHash: "h-src/auth.ts", summary: "exports login()", estimatedTokens: 3, createdAt: new Date().toISOString() } },
    memory: [],
    cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
  }).packet;
  packet.selectedFiles.push({ path: "src/other.ts", mode: "full", estimatedTokens: 9, score: 1, reason: "test selection" });
  const wire = renderPacketForPrompt(packet);
  assert.match(wire, /exports login\(\)/);
  assert.match(wire, /selection budget/);
  assert.match(wire, /not inline file contents/);
  assert.doesNotMatch(wire, /\(full\)/);
});

test("constraints and failures surface from memory", () => {
  const now = Date.now();
  const mem: MemoryEntry[] = [
    {
      id: "1",
      kind: "constraint",
      content: "never write to /etc",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      confidence: 0.9,
      status: "active",
      sourceReferences: [{ kind: "file", value: "x" }],
      relatedFiles: [],
      relatedSymbols: [],
      tags: ["etc"],
      invalidationRules: [],
    },
  ];
  const result = buildContextPacket({
    task: { query: "write config to etc directory", tags: ["etc"] },
    config: {
      maxTokens: 2000,
      maxRetrievedEntries: 10,
      maxRetrievedTokens: 1000,
      maxRecommendedReads: 6,
      summaryThresholdTokens: 3000,
      preferChangedFiles: true,
    },
    index: {},
    summaries: {},
    memory: mem,
    cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
    now,
  });
  assert.ok(result.packet.constraints.includes("never write to /etc"));
});

test("scoreMemory ignores superseded entries", () => {
  const ctx = buildQueryContext("login", [], [], []);
  const base: MemoryEntry = {
    id: "1",
    kind: "fact",
    content: "login uses jwt",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
    status: "superseded",
    sourceReferences: [],
    relatedFiles: [],
    relatedSymbols: [],
    tags: [],
    invalidationRules: [],
  };
  assert.equal(scoreMemory(base, ctx, Date.now()), 0);
});

test("reserve trigger fires at window-reserve (params, not hardcoded)", () => {
  // Direct: threshold is exactly contextWindow - reserve.
  const fired = resolveCompactionTrigger(80, { contextWindow: 100, reserveTokensForSummary: 20 });
  assert.equal(fired.threshold, 80);
  assert.ok(fired.triggerReason, "fires when used reaches window-reserve");
  const quiet = resolveCompactionTrigger(79, { contextWindow: 100, reserveTokensForSummary: 20 });
  assert.equal(quiet.triggerReason, undefined);
  // Window unknown → safe default + reason only when firing.
  const unknownFired = resolveCompactionTrigger(1_000_000, {});
  assert.equal(unknownFired.windowUnknown, true);
  assert.match(unknownFired.triggerReason!, /safe default/);
  // Reserve > window → clamp + still a valid threshold.
  const clamped = resolveCompactionTrigger(0, {
    contextWindow: 50,
    reserveTokensForSummary: 10_000,
    floorBufferTokens: 5,
  });
  assert.equal(clamped.clamped, true);
  assert.ok(clamped.threshold >= 0 && clamped.threshold <= 50);
});

test("builder surfaces reserve trigger when selection reaches window-reserve", () => {
  const result = buildContextPacket({
    task: { query: "login" },
    config: {
      maxTokens: 1000,
      maxRetrievedEntries: 10,
      maxRetrievedTokens: 500,
      maxRecommendedReads: 6,
      summaryThresholdTokens: 3000,
      preferChangedFiles: true,
      contextWindow: 10,
      reserveTokensForSummary: 5,
      floorBufferTokens: 1,
    },
    index: { "src/auth.ts": idxFile("src/auth.ts", ["login"], 100) },
    summaries: {},
    memory: [],
    cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
  });
  assert.ok(result.stats.triggerReason, "trigger reason surfaced");
  assert.match(result.stats.triggerReason!, /compaction-trigger/);
});

test("second agent read is billed fresh, never a free reference", () => {
  const result = buildContextPacket({
    task: { query: "fix the login authenticate flow" },
    config: {
      maxTokens: 1000,
      maxRetrievedEntries: 10,
      maxRetrievedTokens: 500,
      maxRecommendedReads: 6,
      summaryThresholdTokens: 3000,
      preferChangedFiles: true,
    },
    index: { "auth/login.ts": idxFile("auth/login.ts", ["login", "authenticate"], 200) },
    summaries: {},
    memory: [],
    cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
  });
  const login = result.packet.selectedFiles.find((f) => f.path === "auth/login.ts");
  assert.ok(login, "relevant file selected");
  // Wire framing is metadata-only; the billed charge is the full source body.
  assert.ok(login!.estimatedTokens < 200, "wire charge is framing only");
  assert.equal(login!.estimatedSourceTokens, 200);
  assert.ok(result.stats.billedEstimate >= 200, "billedEstimate counts the full second read");
  assert.equal(secondReadBilledTokens(result.packet.selectedFiles), result.stats.billedEstimate);
  const wire = describeWireBudget(result.packet);
  assert.equal(wire.secondReadBilledTokens, result.stats.billedEstimate);
});

test("budget and selector charges are labeled estimated, never billed as measured", () => {
  const b = new TokenBudget(1000);
  const r = b.tryConsumeText("hello world, this is a label check");
  assert.equal(typeof r.estimated, "boolean");
  assert.equal(b.estimated, r.estimated);
  const result = buildContextPacket({
    task: { query: "login" },
    config: {
      maxTokens: 1000,
      maxRetrievedEntries: 10,
      maxRetrievedTokens: 500,
      maxRecommendedReads: 6,
      summaryThresholdTokens: 3000,
      preferChangedFiles: true,
    },
    index: { "src/auth.ts": idxFile("src/auth.ts", ["login"], 100) },
    summaries: {},
    memory: [],
    cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
  });
  assert.equal(result.stats.estimated, true);
  assert.equal((result.packet.budget as { estimated?: boolean }).estimated, true);
  const ctx = buildQueryContext("login", [], [], []);
  const sel = selectFiles({
    index: { "src/auth.ts": idxFile("src/auth.ts", ["login"], 100) },
    summaries: {},
    ctx,
    budget: new TokenBudget(1000),
    options: { maxRecommendedReads: 6, summaryThresholdTokens: 3000, preferChangedFiles: true },
  });
  assert.equal(sel.estimated, true);
  assert.ok(sel.billedEstimate >= 0);
});
