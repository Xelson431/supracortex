import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";
import type { ProviderUsageEvent } from "../../packages/core/src/index.ts";
import { Reconciler } from "../../packages/core/src/orchestration/reconciler.ts";
import { Sweeper } from "../../packages/core/src/orchestration/sweeper.ts";
import type { TaskOutcome } from "../../packages/core/src/index.ts";

async function projectEngine(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ci-eng-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return true; }\n", "utf8");
  await writeFile(join(dir, "src/util.ts"), "export const clamp = (n: number) => n;\n", "utf8");
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  return { dir, engine, store };
}

test("engine indexes files and prepares relevant context", async () => {
  const { engine } = await projectEngine();
  const packet = await engine.prepareContext({ query: "fix the login function in auth" });
  assert.ok(packet);
  const auth = packet!.selectedFiles.find((f) => f.path === "src/auth.ts");
  assert.ok(auth, "auth.ts selected for a login query");
});

test("context cache metrics report request-local valid, miss, and stale states", async () => {
  const { engine } = await projectEngine();
  await engine.prepareContext({ query: "login" });
  const first = engine.metricsSnapshot();
  assert.ok(first.cacheMisses > 0, "an empty cache cannot be reported as a hit");
  await engine.prepareContext({ query: "login" });
  const second = engine.metricsSnapshot();
  assert.ok(second.cacheHits >= first.cacheHits, "only hash-valid summaries count as hits");
  assert.equal(second.filesOpened, 0, "recommendations are not observed file reads");
});

test("host usage ledger deduplicates replays and records cumulative deltas without content", async () => {
  const { engine, store } = await projectEngine();
  const base = {
    messageId: "assistant-1",
    sessionId: "session-1",
    provider: "opencode-go",
    model: "kimi-k3",
    reportedCost: 0.1,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 3,
    cacheReadTokens: 80,
    cacheWriteTokens: 5,
  };
  assert.deepEqual(await engine.recordHostUsage(base), { recorded: true, duplicate: false });
  assert.deepEqual(await engine.recordHostUsage(base), { recorded: false, duplicate: true });
  assert.deepEqual(await engine.recordHostUsage({
    ...base,
    reportedCost: 0.15,
    inputTokens: 150,
    outputTokens: 30,
    cacheReadTokens: 120,
  }), { recorded: true, duplicate: false });

  const ledger = await store.readJsonl<{
    delta: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    [key: string]: unknown;
  }>("metrics/provider-usage.jsonl");
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.entries[1]!.delta.inputTokens, 50);
  assert.equal(ledger.entries[1]!.delta.outputTokens, 10);
  assert.equal(ledger.entries[1]!.delta.cacheReadTokens, 40);
  const serialized = JSON.stringify(ledger.entries);
  assert.ok(!/prompt|response|toolResult|content/i.test(serialized));
  const metrics = engine.metricsSnapshot();
  assert.equal(metrics.hostInputTokens, 150);
  assert.equal(metrics.providerCacheReadTokens, 120);
});

test("telemetry off performs zero host-usage ledger writes", async () => {
  const { engine, store } = await projectEngine({ telemetry: { mode: "off" } });
  const result = await engine.recordHostUsage({
    messageId: "assistant-off",
    sessionId: "session-off",
    provider: "provider",
    model: "model",
    reportedCost: 1,
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(result, { recorded: false, duplicate: false });
  assert.equal(await store.exists("metrics/provider-usage.jsonl"), false);
});

test("annotated metrics distinguish estimated from host-observed origins", async () => {
  const { engine } = await projectEngine();
  await engine.prepareContext({ query: "login" });
  const annotated = engine.annotatedMetrics();
  assert.equal(annotated.origins.estimatedTokensSelected, "estimated");
  assert.equal(annotated.origins.contextPacketTokens, "estimated");
  // No host usage recorded yet -> unavailable, not 0 masquerading as observed.
  assert.equal(annotated.origins.hostInputTokens, "unavailable");
  assert.equal(annotated.origins.hostOutputTokens, "unavailable");
  assert.equal(annotated.origins.providerCacheReadTokens, "unavailable");
  assert.equal(annotated.origins.hostReportedCost, "unavailable");

  // After recording host usage, those origins become host-observed.
  await engine.recordHostUsage({
    messageId: "assistant-1",
    sessionId: "session-1",
    provider: "opencode-go",
    model: "kimi-k3",
    reportedCost: 0.1,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 3,
    cacheReadTokens: 80,
    cacheWriteTokens: 5,
  });
  const after = engine.annotatedMetrics();
  assert.equal(after.origins.hostInputTokens, "host-observed");
  assert.equal(after.origins.providerCacheReadTokens, "provider-observed");
  assert.equal(after.origins.hostReportedCost, "host-observed");
});

test("compaction audit trail is durably persisted to a separate file", async () => {
  const { engine, store, dir } = await projectEngine();
  // Record two facts; supersede one with a newer decision.
  const older = await engine.recordMemory({
    kind: "fact",
    content: "Old fact to be superseded",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
  });
  assert.equal(older.status, "recorded");
  await engine.recordMemory({
    kind: "decision",
    content: "New decision that supersedes the old fact",
    confidence: 0.95,
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
    supersedes: [older.entry!.id],
  });
  const result = await engine.compactMemory();
  assert.ok(result.auditTrail.length > 0, "compaction produced audit entries");
  const audit = await store.readJsonl<{ runId: string; action: string; entryId: string; at: string }>(
    "memory/compaction-audit.jsonl",
  );
  assert.ok(audit.entries.length > 0, "audit trail persisted to disk");
  assert.ok(audit.entries.every((e) => typeof e.runId === "string" && e.runId.length > 0), "each entry has a runId");
  assert.ok(audit.entries.every((e) => e.action === "superseded" || e.action === "expired" || e.action === "stale"), "valid action");
});

test("host usage retention is bounded and rejects observations outside its age window", async () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  const dir = await mkdtemp(join(tmpdir(), "ci-usage-retention-"));
  await mkdir(join(dir, "src"), { recursive: true });
  const { config } = resolveConfig({
    project: {
      enabled: true,
      telemetry: { mode: "local", maxEvents: 2, maxAgeDays: 30 },
    },
  });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir, now: () => now });
  const usage = (messageId: string, observedAt?: string) => ({
    messageId,
    sessionId: "session",
    provider: "provider",
    model: "model",
    observedAt,
    reportedCost: 0,
    inputTokens: 10,
    outputTokens: 1,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  assert.deepEqual(
    await engine.recordHostUsage(usage("too-old", "2026-05-01T00:00:00.000Z")),
    { recorded: false, duplicate: false },
  );
  await engine.recordHostUsage(usage("one"));
  await engine.recordHostUsage(usage("two"));
  await engine.recordHostUsage(usage("three", "not-a-date"));
  const ledger = await store.readJsonl<ProviderUsageEvent>("metrics/provider-usage.jsonl");
  assert.deepEqual(ledger.entries.map((event) => event.messageId), ["two", "three"]);
  assert.equal(ledger.entries[1]!.observedAt, "2026-07-19T12:00:00.000Z");
});

test("vault export activates a complete manifest before cleaning obsolete notes", async () => {
  const { engine, dir } = await projectEngine();
  const recorded = await engine.recordMemory({ kind: "decision", content: "Use transactional vault exports", confidence: 0.9, sourceReferences: [{ kind: "file", value: "src/auth.ts" }] });
  assert.equal(recorded.status, "recorded");
  const id = recorded.entry!.id;
  await engine.exportSnapshot();
  const note = join(dir, ".supracortex", "vault", "Memory", "Decisions", `${id}.md`);
  await access(note);
  await engine.review({ type: "purge", id });
  const snapshot = await engine.exportSnapshot();
  assert.ok(snapshot);
  await assert.rejects(() => access(note));
});

test("memory writes refresh the local snapshot without requiring a manual command", async () => {
  const { engine, dir } = await projectEngine();
  await engine.recordMemory({ kind: "decision", content: "Snapshot follows durable memory", confidence: 0.9, sourceReferences: [{ kind: "file", value: "src/auth.ts" }] });
  const snapshot = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, ".supracortex", "snapshot.json"), "utf8")) as { memory: unknown[] };
  assert.equal(snapshot.memory.length, 1);
});

test("repeat ensureIndex calls within the TTL are served from the in-memory cache", async () => {
  const { engine } = await projectEngine();
  const first = await engine.ensureIndex();
  const second = await engine.ensureIndex();
  assert.equal(first, second, "second call returns the same in-memory index (no second walk)");
  const forced = await engine.ensureIndex(true);
  assert.notEqual(forced, first, "force builds a fresh index generation");
});

test("invalidateIndexCache forces a fresh walk that reflects an in-session edit", async () => {
  const { dir, engine } = await projectEngine();
  const first = await engine.ensureIndex();
  assert.ok(first.files["src/auth.ts"], "auth.ts indexed on the cold walk");
  // Edit within the TTL: a plain ensureIndex() still serves the cached generation.
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return false; }\n", "utf8");
  assert.equal(await engine.ensureIndex(), first, "the TTL still serves the cached generation");
  // Invalidation (what a file-mutating tool hook triggers) closes that window.
  engine.invalidateIndexCache();
  const fresh = await engine.ensureIndex();
  assert.notEqual(fresh, first, "invalidation produced a fresh generation");
  assert.notEqual(
    fresh.files["src/auth.ts"]?.hash,
    first.files["src/auth.ts"]?.hash,
    "fresh generation reflects the edit",
  );
});

test("editing a file invalidates its cached summary", async () => {
  const { dir, engine, store } = await projectEngine();
  await engine.ensureIndex();
  // Seed a summary for auth.ts with the current hash.
  const summary = await engine.cacheSummaryFromContent(
    "src/auth.ts",
    "export function login() { return true; }\n",
  );
  assert.ok(summary);

  // Edit the file, re-index, then validate cache.
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return false; }\n", "utf8");
  await engine.ensureIndex(true);
  const report = await engine.validateCache();
  assert.ok(report.stale.includes("src/auth.ts"), "stale summary detected after edit");
});

test("memory persists across engine re-creation (simulated restart)", async () => {
  const { dir, engine } = await projectEngine();
  await engine.recordMemory({
    kind: "decision",
    content: "auth uses session cookies",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
    tags: ["auth"],
  });

  // New engine instance over the same storage dir.
  const { config } = resolveConfig({ project: { enabled: true } });
  const store2 = new JsonlStore(join(dir, ".supracortex"));
  const engine2 = new Engine({ config, store: store2, pluginVersion: "0.1.0", projectRoot: dir });
  const found = await engine2.searchMemory("how does auth work", { tags: ["auth"] });
  assert.ok(found.length >= 1, "memory survived restart");
});

test("disabled engine performs no indexing or retrieval", async () => {
  const { dir } = await projectEngine();
  const { config } = resolveConfig({ project: { enabled: false } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  assert.equal(await engine.prepareContext({ query: "x" }), null);
  assert.deepEqual(await engine.searchMemory("x"), []);
  assert.equal(engine.planTasks([{ title: "t", objective: "o" }]), null);
});

test("file ownership prevents overlapping claims", async () => {
  const { engine } = await projectEngine();
  const first = await engine.claimFiles("task-a", ["src/auth.ts"]);
  assert.deepEqual(first.granted, ["src/auth.ts"]);
  const second = await engine.claimFiles("task-b", ["src/auth.ts"]);
  assert.equal(second.granted.length, 0);
  assert.equal(second.denied[0]!.heldBy, "task-a");
  assert.ok(first.leaseId);
  assert.ok(first.fencingToken);
  await engine.releaseFiles("task-a", first.leaseId!, first.fencingToken!);
  const third = await engine.claimFiles("task-b", ["src/auth.ts"]);
  assert.deepEqual(third.granted, ["src/auth.ts"]);
});

test("recordOutcome persists learnings and releases ownership", async () => {
  const { engine } = await projectEngine();
  await engine.claimFiles("t1", ["src/util.ts"]);
  await engine.recordOutcome({
    taskId: "t1",
    status: "success",
    summary: "added clamp helper",
    touchedFiles: ["src/util.ts"],
    learnings: ["clamp lives in src/util.ts"],
    recordedAt: new Date().toISOString(),
  });
  const active = await engine.activeTaskCount();
  assert.equal(active, 1);
  // A taskId-only outcome cannot destructively affect a modern incarnation.
  const claim = await engine.claimFiles("t2", ["src/util.ts"]);
  assert.equal(claim.granted.length, 0);
});

test("recordOutcome replay is idempotent and does not persist duplicate learnings", async () => {
  const { engine, store } = await projectEngine();
  const outcome = {
    operationId: "outcome-op-1",
    taskId: "retry-task",
    status: "success" as const,
    summary: "completed once",
    touchedFiles: ["src/util.ts"],
    learnings: ["retry outcome learning"],
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
  const first = await engine.recordOutcome(outcome);
  const replay = await engine.recordOutcome({ ...outcome, recordedAt: "2026-01-01T00:01:00.000Z" });
  assert.equal(first?.recorded, true);
  assert.equal(replay?.recorded, false);
  const completed = await store.readJsonl<{ operationId?: string }>("tasks/completed.jsonl");
  assert.equal(completed.entries.filter((entry) => entry.operationId === "outcome-op-1").length, 1);
  const memories = await engine.searchMemory("retry outcome learning");
  assert.equal(memories.filter((selection) => selection.entry.content === "retry outcome learning").length, 1);
});

test("recordOutcome fences a stale incarnation without clearing current state", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("incarnation-task", ["src/util.ts"]);
  const activeBefore = (await engine.activeTasks()).find((task) => task.taskId === "incarnation-task")!;
  await engine.recordOutcome({
    operationId: "stale-incarnation-outcome",
    taskId: "incarnation-task",
    incarnationId: "different-incarnation",
    status: "success",
    summary: "late result",
    touchedFiles: [],
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const completed = await store.readJsonl<{ operationId?: string; incarnationId?: string }>("tasks/completed.jsonl");
  const ownership = await store.readJson<{ claims: Record<string, { taskId: string; incarnationId?: string }> }>("tasks/ownership.json");
  const active = (await engine.activeTasks()).find((task) => task.taskId === "incarnation-task");
  assert.ok(completed.entries.some((entry) => entry.operationId === "stale-incarnation-outcome" && entry.incarnationId === "different-incarnation"));
  assert.equal(active?.incarnationId, activeBefore.incarnationId);
  assert.equal(ownership?.claims["src/util.ts"]?.taskId, "incarnation-task");
  assert.equal(ownership?.claims["src/util.ts"]?.incarnationId, activeBefore.incarnationId);
});

test("recordOutcome without an incarnation keeps legacy taskId cleanup", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("legacy-outcome-task", ["src/util.ts"]);
  const activePath = join(store.root, "tasks/active.json");
  const activeRecord = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<Record<string, unknown>> };
  delete activeRecord.tasks[0]!.incarnationId;
  await writeFile(activePath, JSON.stringify(activeRecord), "utf8");
  await engine.recordOutcome({
    operationId: "legacy-outcome",
    taskId: "legacy-outcome-task",
    status: "success",
    summary: "legacy result",
    touchedFiles: [],
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const active = (await engine.activeTasks()).find((task) => task.taskId === "legacy-outcome-task");
  const ownership = await store.readJson<{ claims: Record<string, { taskId: string }> }>("tasks/ownership.json");
  const available = await engine.claimFiles("replacement-task", ["src/util.ts"]);
  assert.equal(active, undefined);
  assert.equal(Object.values(ownership?.claims ?? {}).some((claim) => claim.taskId === "legacy-outcome-task"), false);
  assert.deepEqual(available.granted, ["src/util.ts"]);
});

test("reusing a task id creates an incarnation and does not replay the old outcome", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("reuse", ["src/util.ts"]);
  const first = (await engine.activeTasks())[0]!;
  await engine.recordOutcome({ taskId: "reuse", incarnationId: first.incarnationId, status: "success", summary: "old", touchedFiles: [], learnings: [], recordedAt: "2026-01-01T00:00:00.000Z" });
  await engine.claimFiles("reuse", ["src/util.ts"]);
  const second = (await engine.activeTasks())[0]!;
  assert.notEqual(second.incarnationId, first.incarnationId);
  assert.equal((await engine.activeTasks()).length, 1);
  assert.equal((await store.readJsonl<TaskOutcome>("tasks/completed.jsonl")).entries.length, 1);
});

test("claim and recordOutcome round-trip fences taskId-only cleanup with incarnationId", async () => {
  const { engine, store } = await projectEngine();
  const claim = await engine.claimFiles("round-trip-task", ["src/auth.ts"]);
  assert.ok(claim.incarnationId, "claim returns a non-empty incarnationId");

  await engine.recordOutcome({
    operationId: "round-trip-task-only",
    taskId: "round-trip-task",
    status: "success",
    summary: "task-id-only result",
    touchedFiles: [],
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const stillActive = (await engine.activeTasks()).find((task) => task.taskId === "round-trip-task");
  const stillOwned = await store.readJson<{ claims: Record<string, { taskId: string }> }>("tasks/ownership.json");
  assert.ok(stillActive, "taskId-only outcome does not clear the modern active record");
  assert.equal(stillOwned?.claims["src/auth.ts"]?.taskId, "round-trip-task", "taskId-only outcome does not release claims");

  await engine.recordOutcome({
    operationId: "round-trip-matching",
    taskId: "round-trip-task",
    incarnationId: claim.incarnationId,
    status: "success",
    summary: "matching incarnation result",
    touchedFiles: [],
    recordedAt: "2026-01-01T00:00:01.000Z",
  });
  const active = (await engine.activeTasks()).find((task) => task.taskId === "round-trip-task");
  const ownership = await store.readJson<{ claims: Record<string, { taskId: string }> }>("tasks/ownership.json");
  const completed = await store.readJsonl<{ operationId?: string; incarnationId?: string }>("tasks/completed.jsonl");
  assert.equal(active, undefined, "matching incarnation outcome clears active state");
  assert.equal(ownership?.claims["src/auth.ts"], undefined, "matching incarnation outcome releases claims");
  assert.ok(completed.entries.some((entry) => entry.operationId === "round-trip-matching" && entry.incarnationId === claim.incarnationId));
});

test("reconciliation revival guard preserves a task changed after the stale snapshot", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("revive", ["src/auth.ts"], { sessionId: "s" });
  const active = (await engine.activeTasks())[0]!;
  await store.writeJson("tasks/active.json", { tasks: [{ ...active, lastSeenAt: "2020-01-01T00:00:00.000Z" }], updatedAt: "2020-01-01T00:00:00.000Z" });
  await engine.heartbeat("revive", { sessionId: "s" });
  await engine.sweep("stale", { force: true, liveSessionIds: new Set(["s"]) });
  assert.equal((await store.readJsonl<TaskOutcome>("tasks/completed.jsonl")).entries.length, 0);
  assert.equal((await engine.activeTasks()).length, 1);
  assert.equal((await engine.claimFiles("other", ["src/auth.ts"])).granted.length, 0);
});

test("synthetic provenance never persists learnings", async () => {
  const { engine } = await projectEngine();
  await engine.recordOutcome({ taskId: "synthetic", source: "synthetic" as TaskOutcome["source"], status: "success", summary: "x", touchedFiles: [], learnings: ["must not persist"], recordedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal((await engine.searchMemory("must not persist")).length, 0);
});

test("absent provenance retains agent learning persistence", async () => {
  const { engine } = await projectEngine();
  await engine.recordOutcome({ taskId: "legacy-agent", status: "success", summary: "x", touchedFiles: [], learnings: ["legacy agent learning"], recordedAt: "2026-01-01T00:00:00.000Z" });
  assert.ok((await engine.searchMemory("legacy agent learning")).some((x) => x.entry.content === "legacy agent learning"));
});

test("recording an already-appended outcome replays cleanup", async () => {
  const { engine, store } = await projectEngine();
  const claim = await engine.claimFiles("crash-replay", ["src/util.ts"]);
  const active = (await engine.activeTasks())[0]!;
  const outcome: TaskOutcome = { taskId: "crash-replay", incarnationId: active.incarnationId, operationId: "replay-op", status: "success", summary: "done", touchedFiles: [], learnings: [], recordedAt: "2026-01-01T00:00:00.000Z" };
  await store.appendJsonl("tasks/completed.jsonl", [outcome]);
  await engine.recordOutcome(outcome);
  assert.equal((await engine.activeTasks()).length, 0);
  assert.deepEqual((await engine.claimFiles("next", ["src/util.ts"])).granted, ["src/util.ts"]);
  assert.ok(claim.leaseId);
});

test("session.idle does not infer or release a live task", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("idle", ["src/util.ts"], { sessionId: "idle-session" });
  await engine.sweep("session.idle", { force: true, liveSessionIds: new Set(["idle-session"]) });
  assert.equal((await store.readJsonl<TaskOutcome>("tasks/completed.jsonl")).entries.length, 0);
  assert.equal((await engine.activeTasks()).length, 1);
  assert.equal((await engine.claimFiles("next", ["src/util.ts"])).granted.length, 0);
});

test("session.deleted infers exactly one outcome on repeated delivery", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("deleted", ["src/util.ts"], { sessionId: "deleted-session" });
  await engine.sweep("session.deleted", { force: true, terminalSessionId: "deleted-session", liveSessionIds: new Set() });
  await engine.sweep("session.deleted", { force: true, terminalSessionId: "deleted-session", liveSessionIds: new Set() });
  const entries = (await store.readJsonl<TaskOutcome>("tasks/completed.jsonl")).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.source, "inferred");
});

test("inferred persistence failure leaves task and claim for retry", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("persist-fail", ["src/util.ts"], { sessionId: "fail-session" });
  const original = store.appendJsonl.bind(store);
  let fail = true;
  store.appendJsonl = async (...args) => { if (fail && args[0] === "tasks/completed.jsonl") throw new Error("append failed"); return original(...args); };
  await assert.rejects(() => engine.sweep("deleted", { force: true, terminalSessionId: "fail-session", liveSessionIds: new Set() }));
  assert.equal((await engine.activeTasks()).length, 1);
  assert.equal((await engine.claimFiles("other", ["src/util.ts"])).granted.length, 0);
  fail = false;
  await engine.sweep("deleted", { force: true, terminalSessionId: "fail-session", liveSessionIds: new Set() });
  assert.equal((await store.readJsonl<TaskOutcome>("tasks/completed.jsonl")).entries.length, 1);
  assert.equal((await engine.activeTasks()).some((task) => task.taskId === "persist-fail"), false);
});

test("inferred outcomes have the strict persisted shape and do not persist memory", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("shape", ["src/util.ts"], { sessionId: "shape-session" });
  await engine.sweep("deleted", { force: true, terminalSessionId: "shape-session", liveSessionIds: new Set() });
  const outcome = (await store.readJsonl<TaskOutcome>("tasks/completed.jsonl")).entries[0]!;
  assert.equal(outcome.source, "inferred"); assert.equal(outcome.status, "partial");
  assert.deepEqual(outcome.learnings, []); assert.ok(outcome.incarnationId);
  assert.equal((await engine.searchMemory("Task ended without an explicit outcome")).length, 0);
});

test("disabled automatic outcome recording keeps stale task and ownership", async () => {
  const { engine } = await projectEngine({ integration: { automaticOutcomeRecording: false } });
  await engine.claimFiles("no-consent", ["src/util.ts"], { sessionId: "no-consent-session" });
  await engine.sweep("deleted", { force: true, terminalSessionId: "no-consent-session", liveSessionIds: new Set() });
  assert.equal((await engine.activeTasks()).length, 1);
  assert.equal((await engine.claimFiles("other", ["src/util.ts"])).granted.length, 0);
});

test("trim and append preserve outcomes written during retention maintenance", async () => {
  const { engine, store } = await projectEngine();
  await store.appendJsonl("tasks/completed.jsonl", [{ taskId: "old", status: "success", summary: "old", touchedFiles: [], learnings: [], recordedAt: "2020-01-01T00:00:00.000Z" }]);
  await engine.recordOutcome({ taskId: "new", status: "success", summary: "new", touchedFiles: [], learnings: [], recordedAt: new Date().toISOString() });
  await engine.sweep("trim", { force: true });
  const entries = (await store.readJsonl<TaskOutcome>("tasks/completed.jsonl")).entries;
  assert.ok(entries.some((e) => e.taskId === "new"));
});

test("recordOutcome handles missing learnings without crashing", async () => {
  const { engine } = await projectEngine();
  const result = await engine.recordOutcome({
    taskId: "no-learnings-task",
    status: "success",
    summary: "did work without reporting learnings",
    touchedFiles: ["src/util.ts"],
    recordedAt: new Date().toISOString(),
  });
  assert.equal(result?.recorded, true);
  const memories = await engine.searchMemory("did work without reporting learnings");
  assert.equal(memories.length, 0, "no learnings should be persisted when learnings is omitted");
});

test("recordOutcome handles non-array learnings without crashing", async () => {
  const { engine } = await projectEngine();
  const result = await engine.recordOutcome({
    taskId: "bad-learnings-task",
    status: "success",
    summary: "sent a bare string instead of an array",
    touchedFiles: ["src/util.ts"],
    // Simulates a model sending a bare string for an optional array field.
    learnings: "did X" as unknown as string[],
    recordedAt: new Date().toISOString(),
  });
  assert.equal(result?.recorded, true, "engine must not throw on non-array learnings");
});

test("recordOutcome drops non-string learnings elements without crashing", async () => {
  const { engine } = await projectEngine();
  const result = await engine.recordOutcome({
    taskId: "mixed-learnings-task",
    status: "success",
    summary: "sent an array with mixed element types",
    touchedFiles: ["src/util.ts"],
    // Simulates a model sending a number and a whitespace-only string alongside a real learning.
    learnings: [5, "real learning", "   "] as unknown as string[],
    recordedAt: new Date().toISOString(),
  });
  assert.equal(result?.recorded, true, "engine must not throw on mixed-type learnings elements");
  const memories = await engine.searchMemory("real learning");
  assert.equal(
    memories.filter((selection) => selection.entry.content === "real learning").length,
    1,
    "only the valid string learning should be persisted",
  );
  const junk = await engine.searchMemory("5");
  assert.equal(
    junk.filter((selection) => selection.entry.content === "5" || selection.entry.content === "   ").length,
    0,
    "non-string and whitespace-only elements must not be persisted",
  );
});

test("recordOutcome handles number learnings without crashing", async () => {
  const { engine } = await projectEngine();
  const result = await engine.recordOutcome({
    taskId: "number-learnings-task",
    status: "success",
    summary: "sent a bare number instead of an array",
    touchedFiles: ["src/util.ts"],
    // Simulates a model sending a scalar number for an optional array field.
    learnings: 5 as unknown as string[],
    recordedAt: new Date().toISOString(),
  });
  assert.equal(result?.recorded, true, "engine must not throw on number learnings");
  const memories = await engine.searchMemory("sent a bare number instead of an array");
  const persistedLearnings = memories.filter((selection) => selection.entry.tags?.includes("outcome"));
  assert.equal(persistedLearnings.length, 0, "no learnings should be persisted when learnings is a scalar");
});

test("reaping serializes revival attempts across persistence and cleanup", async () => {
  const { engine, store } = await projectEngine();
  await engine.claimFiles("revival-window", ["src/util.ts"], { sessionId: "revival-session" });
  const append = store.appendJsonl.bind(store);
  let heartbeat: Promise<{ renewed: string[]; lost: string[] }> | undefined;
  store.appendJsonl = async (...args) => {
    if (args[0] === "tasks/completed.jsonl") heartbeat = engine.heartbeat("revival-window", { sessionId: "revival-session" });
    return append(...args);
  };
  await engine.sweep("deleted", { force: true, terminalSessionId: "revival-session", liveSessionIds: new Set() });
  const result = await heartbeat;
  assert.deepEqual(result?.renewed, []);
  assert.equal((await store.readJsonl<TaskOutcome>("tasks/completed.jsonl")).entries.some((e) => e.taskId === "revival-window"), true);
  assert.equal((await engine.activeTasks()).some((t) => t.taskId === "revival-window"), false);
  assert.equal((await engine.claimFiles("other", ["src/util.ts"])).granted.length, 1);
});


test("recordOutcome redacts secrets in learnings after filtering non-string elements", async () => {
  const { engine } = await projectEngine();
  await engine.recordOutcome({
    taskId: "secret-learnings-task",
    status: "success",
    summary: "captured a learning containing a secret-shaped value",
    touchedFiles: ["src/util.ts"],
    learnings: [42, "AWS key AKIAABCDEFGHIJKLMNOP was hardcoded", "  "] as unknown as string[],
    recordedAt: new Date().toISOString(),
  });
  const memories = await engine.searchMemory("hardcoded");
  const stored = memories.find((selection) => selection.entry.content.includes("hardcoded"));
  assert.ok(stored, "the valid learning should be persisted");
  assert.ok(!stored!.entry.content.includes("AKIAABCDEFGHIJKLMNOP"), "the raw secret must not be stored");
  assert.ok(stored!.entry.content.includes("[REDACTED]"), "the secret must be redacted");
});

test("claim and recordOutcome round-trip carries the returned incarnationId through to release", async () => {
  const { engine, store } = await projectEngine();
  // Positive half: pass the claimed incarnationId back into recordOutcome.
  const claim = await engine.claimFiles("t18-roundtrip", ["src/auth.ts"]);
  assert.ok(claim.incarnationId, "claimFiles must return an incarnationId");
  assert.ok(claim.leaseId, "claimFiles must still return a leaseId");
  assert.ok(claim.fencingToken, "claimFiles must still return a fencingToken");

  const result = await engine.recordOutcome({
    operationId: "t18-matching",
    taskId: "t18-roundtrip",
    incarnationId: claim.incarnationId,
    status: "success",
    summary: "returned incarnation released claims",
    touchedFiles: ["src/auth.ts"],
    learnings: [],
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(result?.recorded, true, "matching incarnation outcome must be recorded");

  // The claims ARE released and active state IS cleared.
  const active = (await engine.activeTasks()).find((task) => task.taskId === "t18-roundtrip");
  assert.equal(active, undefined, "matching incarnation outcome clears the active record");
  const ownership = await store.readJson<{ claims: Record<string, { taskId: string }> }>("tasks/ownership.json");
  assert.equal(ownership?.claims["src/auth.ts"], undefined, "matching incarnation outcome releases the claim");
  const completed = await store.readJsonl<TaskOutcome>("tasks/completed.jsonl");
  assert.ok(
    completed.entries.some((entry) => entry.taskId === "t18-roundtrip" && entry.incarnationId === claim.incarnationId),
    "completed.jsonl carries the returned incarnationId",
  );

  // Negative half: a fresh task recorded with a DIFFERENT (wrong) incarnationId.
  const fresh = await engine.claimFiles("t18-wrong", ["src/util.ts"]);
  assert.ok(fresh.incarnationId, "fresh claim must return an incarnationId");
  await engine.recordOutcome({
    operationId: "t18-wrong-incarnation",
    taskId: "t18-wrong",
    incarnationId: "different-incarnation",
    status: "success",
    summary: "stale outcome with a wrong incarnation",
    touchedFiles: ["src/util.ts"],
    learnings: [],
    recordedAt: "2026-01-01T00:00:01.000Z",
  });

  // The claims SURVIVE and the active record remains.
  const afterWrong = (await engine.activeTasks()).find((task) => task.taskId === "t18-wrong");
  assert.ok(afterWrong, "wrong incarnation outcome leaves the active record in place");
  const ownershipAfterWrong = await store.readJson<{ claims: Record<string, { taskId: string; incarnationId?: string }> }>("tasks/ownership.json");
  assert.equal(ownershipAfterWrong?.claims["src/util.ts"]?.taskId, "t18-wrong", "wrong incarnation outcome does not release the claim");
  assert.equal(ownershipAfterWrong?.claims["src/util.ts"]?.incarnationId, fresh.incarnationId, "the claim keeps the fresh incarnationId");
  const completedAfterWrong = await store.readJsonl<TaskOutcome>("tasks/completed.jsonl");
  assert.ok(
    completedAfterWrong.entries.some((entry) => entry.taskId === "t18-wrong" && entry.incarnationId === "different-incarnation"),
    "wrong-incarnation outcome is recorded but not destructive",
  );
  assert.equal((await engine.activeTasks()).length, 1, "only the wrong-incarnation task remains active");
});
