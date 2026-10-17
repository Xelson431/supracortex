/**
 * Robustness tests for the "malformed LLM input crashes a cortex tool" bug
 * class. The tool() wrapper from @opencode-ai/plugin does not validate/coerce
 * args at runtime, so raw model-supplied JSON reaches execute() as-is:
 * optional array/string fields can arrive undefined, as a bare string, a
 * number, or an object. These tests assert that no malformed shape ever
 * throws, and that the guard() structural safety net converts a thrown
 * handler into a safe, structured result instead of propagating to the host.
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";
import { PluginRuntime } from "../../packages/opencode/src/runtime.ts";
import { FeatureGate } from "../../packages/opencode/src/feature-gate.ts";
import { guard } from "../../packages/opencode/src/tools/index.ts";
import {
  buildTools,
  resolveCanonicalToolName,
  canonicalToolLog,
  TOOL_ALIASES,
  CANONICAL_CORE_TOOLS,
} from "../../packages/opencode/src/tools/index.ts";

async function projectEngine(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ci-robust-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/util.ts"), "export const clamp = (n: number) => n;\n", "utf8");
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  return { dir, engine, store };
}

function makeRuntime(dir: string) {
  const { config } = resolveConfig({ project: { enabled: true } });
  const gate = new FeatureGate(true, "test");
  return new PluginRuntime({
    gate,
    lifecycle: { config, projectRoot: dir, worktree: dir, pluginVersion: "0.1.0" },
  });
}

// ---------------------------------------------------------------------------
// guard()-level coverage: the structural safety net itself.
// ---------------------------------------------------------------------------

test("guard() returns { disabled: true } when the gate is inactive, without calling fn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-robust-gate-"));
  const { config } = resolveConfig({ project: { enabled: false } });
  const gate = new FeatureGate(false, "disabled");
  const rt = new PluginRuntime({
    gate,
    lifecycle: { config, projectRoot: dir, worktree: dir, pluginVersion: "0.1.0" },
  });
  let called = false;
  const res = await guard(rt, async () => {
    called = true;
    return "unreachable";
  });
  assert.deepEqual(res, { disabled: true });
  assert.equal(called, false, "fn must not run when the gate is inactive");
});

test("guard() catches a thrown handler and returns a structured error instead of rejecting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-robust-throw-"));
  const rt = makeRuntime(dir);
  const res = await guard(rt, async () => {
    throw new Error("boom: simulated handler failure");
  });
  assert.ok(typeof res === "object" && res !== null, "result must be a structured object, not a rejection");
  assert.ok("error" in res, "thrown handler must surface as { error }");
  assert.ok((res as { error: string }).error.includes("boom"), "error message is preserved");
});

test("guard() catches a thrown non-Error value (e.g. a rejected string/object)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-robust-throw-nonerr-"));
  const rt = makeRuntime(dir);
  const res = await guard(rt, async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw "not an Error instance";
  });
  assert.ok("error" in (res as object));
  assert.ok((res as { error: string }).error.includes("not an Error instance"));
});

test("guard() truncates a very long thrown error message to a bounded length", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-robust-throw-long-"));
  const rt = makeRuntime(dir);
  const longMessage = "x".repeat(5000);
  const res = await guard(rt, async () => {
    throw new Error(longMessage);
  });
  assert.ok("error" in (res as object));
  assert.ok((res as { error: string }).error.length <= 500, "error message must be bounded");
});

test("guard() passes through a successful handler result unchanged (happy path)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-robust-happy-"));
  const rt = makeRuntime(dir);
  const res = await guard(rt, async () => ({ ok: true, value: 42 }));
  assert.deepEqual(res, { ok: true, value: 42 });
});

// ---------------------------------------------------------------------------
// Engine-level coverage: malformed input to the two crash-class handlers and
// the consistency set, called directly against the engine (as the tool layer
// would after normalization, and also to prove engine-level defense-in-depth).
// ---------------------------------------------------------------------------

test("releaseFiles tolerates undefined files (release-all semantics, no crash)", async () => {
  const { engine } = await projectEngine();
  const claim = await engine.claimFiles("task-a", ["src/util.ts"]);
  assert.deepEqual(claim.granted, ["src/util.ts"]);
  const result = await engine.releaseFiles("task-a", claim.leaseId!, claim.fencingToken!, undefined);
  assert.deepEqual(result.released, ["src/util.ts"]);
});

test("releaseFiles tolerates an empty array as a safe no-op", async () => {
  const { engine } = await projectEngine();
  const claim = await engine.claimFiles("task-b", ["src/util.ts"]);
  const result = await engine.releaseFiles("task-b", claim.leaseId!, claim.fencingToken!, []);
  assert.deepEqual(result.released, [], "an empty files array releases nothing (safe no-op)");
});

test("releaseFiles tolerates a bare string instead of an array without crashing", async () => {
  const { engine } = await projectEngine();
  const claim = await engine.claimFiles("task-c", ["src/util.ts"]);
  const result = await engine.releaseFiles(
    "task-c",
    claim.leaseId!,
    claim.fencingToken!,
    "src/util.ts" as unknown as string[],
  );
  assert.deepEqual(result.released, ["src/util.ts"], "a bare string is treated as a single-element array");
});

test("releaseFiles tolerates a number instead of an array without crashing", async () => {
  const { engine } = await projectEngine();
  const claim = await engine.claimFiles("task-d", ["src/util.ts"]);
  await assert.doesNotReject(async () => {
    const result = await engine.releaseFiles(
      "task-d",
      claim.leaseId!,
      claim.fencingToken!,
      5 as unknown as string[],
    );
    assert.deepEqual(result.released, [], "a scalar number normalizes to an empty release set");
  });
});

test("releaseFiles tolerates an object instead of an array without crashing", async () => {
  const { engine } = await projectEngine();
  const claim = await engine.claimFiles("task-e", ["src/util.ts"]);
  await assert.doesNotReject(async () =>
    engine.releaseFiles("task-e", claim.leaseId!, claim.fencingToken!, { foo: "bar" } as unknown as string[]),
  );
});

test("createHandoff tolerates undefined optional arrays without crashing", async () => {
  const { engine } = await projectEngine();
  const capsule = await engine.createHandoff({ goal: "ship the fix" });
  assert.ok(capsule);
  assert.deepEqual(capsule!.completedWork, []);
  assert.deepEqual(capsule!.nextActions, []);
  assert.deepEqual(capsule!.evidenceIds, []);
});

test("createHandoff tolerates a bare string for completedWork/nextActions/evidenceIds", async () => {
  const { engine } = await projectEngine();
  const capsule = await engine.createHandoff({
    goal: "ship the fix",
    completedWork: "did the thing" as unknown as string[],
    nextActions: "do the next thing" as unknown as string[],
    evidenceIds: "not-a-real-id" as unknown as string[],
  });
  assert.ok(capsule);
  assert.deepEqual(capsule!.completedWork, ["did the thing"]);
  assert.deepEqual(capsule!.nextActions, ["do the next thing"]);
  // evidenceIds is filtered against approved memory ids; an unknown id is dropped.
  assert.deepEqual(capsule!.evidenceIds, []);
});

test("createHandoff tolerates a number for completedWork/nextActions/evidenceIds", async () => {
  const { engine } = await projectEngine();
  const capsule = await engine.createHandoff({
    goal: "ship the fix",
    completedWork: 5 as unknown as string[],
    nextActions: 5 as unknown as string[],
    evidenceIds: 5 as unknown as string[],
  });
  assert.ok(capsule);
  assert.deepEqual(capsule!.completedWork, []);
  assert.deepEqual(capsule!.nextActions, []);
  assert.deepEqual(capsule!.evidenceIds, []);
});

test("createHandoff tolerates an object for completedWork/nextActions/evidenceIds", async () => {
  const { engine } = await projectEngine();
  await assert.doesNotReject(async () => {
    const capsule = await engine.createHandoff({
      goal: "ship the fix",
      completedWork: { foo: "bar" } as unknown as string[],
      nextActions: { foo: "bar" } as unknown as string[],
      evidenceIds: { foo: "bar" } as unknown as string[],
    });
    assert.ok(capsule);
    assert.deepEqual(capsule!.completedWork, []);
  });
});

test("createHandoff tolerates a mixed-type array (numbers, objects, strings)", async () => {
  const { engine } = await projectEngine();
  const capsule = await engine.createHandoff({
    goal: "ship the fix",
    completedWork: [1, "real item", { nested: true }, "another real item"] as unknown as string[],
  });
  assert.ok(capsule);
  assert.deepEqual(capsule!.completedWork, ["real item", "another real item"]);
});

test("createHandoff happy path with well-formed arrays is unaffected", async () => {
  const { engine } = await projectEngine();
  const recorded = await engine.recordMemory({
    kind: "decision",
    content: "Use transactional handoffs",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/util.ts" }],
  });
  assert.equal(recorded.status, "recorded");
  const capsule = await engine.createHandoff({
    goal: "ship the fix",
    completedWork: ["wrote the code", "ran the tests"],
    nextActions: ["deploy"],
    evidenceIds: [recorded.entry!.id],
  });
  assert.ok(capsule);
  assert.deepEqual(capsule!.completedWork, ["wrote the code", "ran the tests"]);
  assert.deepEqual(capsule!.nextActions, ["deploy"]);
  assert.deepEqual(capsule!.evidenceIds, [recorded.entry!.id]);
});

test("claimFiles happy path is unaffected by the tool-boundary normalization work", async () => {
  const { engine } = await projectEngine();
  const result = await engine.claimFiles("task-happy", ["src/util.ts"]);
  assert.deepEqual(result.granted, ["src/util.ts"]);
  assert.deepEqual(result.denied, []);
});

// ---------------------------------------------------------------------------
// 6a. Single vocabulary: thin aliases share the canonical handler reference.
// ---------------------------------------------------------------------------

test("6a: opencode thin aliases are the identical handler (no logic fork)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-robust-alias-"));
  const rt = makeRuntime(dir);
  const tools = buildTools(rt);
  assert.equal(tools.cortex_context, tools.cortex_prepare_context, "cortex_context alias must be the same handler");
  assert.equal(tools.cortex_search, tools.cortex_search_memory, "cortex_search alias must be the same handler");
  assert.equal(tools.cortex_record, tools.cortex_record_memory, "cortex_record alias must be the same handler");
});

test("6a: alias map resolves 100% with canonical telemetry logging", async () => {
  assert.deepEqual(TOOL_ALIASES, {
    cortex_prepare_context: "cortex_context",
    cortex_search_memory: "cortex_search",
    cortex_record_memory: "cortex_record",
    cortex_record_outcome: "cortex_record",
  });
  assert.equal(CANONICAL_CORE_TOOLS.length, 5);
  assert.equal(resolveCanonicalToolName("cortex_prepare_context"), "cortex_context");
  assert.equal(resolveCanonicalToolName("cortex_search_memory"), "cortex_search");
  assert.equal(resolveCanonicalToolName("cortex_record_memory"), "cortex_record");
  assert.equal(resolveCanonicalToolName("cortex_record_outcome"), "cortex_record");
  assert.equal(canonicalToolLog("cortex_prepare_context"), "cortex_context", "telemetry must log the canonical");
  assert.equal(canonicalToolLog("cortex_search_memory"), "cortex_search");
});

test("6a: unknown alias fails closed (null, never silent)", async () => {
  assert.equal(resolveCanonicalToolName("cortex_nope"), null);
  assert.equal(resolveCanonicalToolName("not_a_tool"), null);
});

test("6a: opencode resolver agrees with protocol on the full set (incl. non-core)", async () => {
  const protocol = await import("../../src/protocol.ts");
  // Full canonical set resolves identically on both sides.
  for (const name of protocol.MCP_TOOL_NAMES) {
    assert.equal(resolveCanonicalToolName(name), name, `${name} must resolve on the opencode side`);
    assert.equal(resolveCanonicalToolName(name), protocol.resolveCanonicalToolName(name));
  }
  // Full alias set resolves identically on both sides (100% alias agreement).
  for (const alias of Object.keys(protocol.TOOL_ALIASES)) {
    assert.equal(resolveCanonicalToolName(alias), protocol.resolveCanonicalToolName(alias));
  }
  // Spot-check non-core names that previously returned null here.
  assert.equal(resolveCanonicalToolName("cortex_timeline"), "cortex_timeline");
  assert.equal(resolveCanonicalToolName("cortex_detail"), "cortex_detail");
});
