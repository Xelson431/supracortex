import test from "node:test";
import assert from "node:assert";
import {
  planTasks,
  parallelSafety,
  detectOverlaps,
  detectDuplicateTasks,
  detectDuplicateReads,
  buildTaskGraph,
} from "../../packages/core/src/index.ts";
import type { PlannedTask } from "../../packages/core/src/index.ts";
import { JsonlStore, OwnershipManager } from "../../packages/core/src/index.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function pt(id: string, write: string[], read: string[] = [], deps: string[] = []): PlannedTask {
  return {
    id,
    title: id,
    objective: id,
    dependencies: deps,
    readScope: read,
    writeScope: write,
    contextBudgetTokens: 1000,
    parallelSafe: true,
    parallelSafetyReason: "",
    completionCriteria: [],
  };
}

test("two tasks writing the same file are not parallel-safe", () => {
  const a = pt("a", ["src/x.ts"]);
  const b = pt("b", ["src/x.ts"]);
  const safety = parallelSafety(a, [a, b]);
  assert.equal(safety.safe, false);
  assert.ok(safety.reason.includes("src/x.ts"));

  const overlaps = detectOverlaps([a, b]);
  assert.equal(overlaps.length, 1);
});

test("disjoint write scopes are parallel-safe", () => {
  const a = pt("a", ["src/a.ts"]);
  const b = pt("b", ["src/b.ts"]);
  assert.equal(parallelSafety(a, [a, b]).safe, true);
});

test("read of another task's write creates ordering dependency", () => {
  const a = pt("a", ["src/shared.ts"]);
  const b = pt("b", ["src/b.ts"], ["src/shared.ts"]);
  const safety = parallelSafety(b, [a, b]);
  assert.equal(safety.safe, false);
});

test("planTasks infers dependency from read/write and builds waves", () => {
  const plan = planTasks(
    [
      { id: "writer", title: "w", objective: "generate types", writeScope: ["types.ts"] },
      { id: "reader", title: "r", objective: "use types", readScope: ["types.ts"], writeScope: ["app.ts"] },
    ],
    { maxConcurrentTasks: 4, defaultBudgetTokens: 1000 },
  );
  const reader = plan.tasks.find((t) => t.id === "reader")!;
  assert.ok(reader.dependencies.includes("writer"));
  // Writer runs in an earlier wave than reader.
  const wIdx = plan.waves.findIndex((w) => w.includes("writer"));
  const rIdx = plan.waves.findIndex((w) => w.includes("reader"));
  assert.ok(wIdx < rIdx);
});

test("duplicate task objectives are grouped", () => {
  const tasks = [
    pt("a", [], []),
    pt("b", [], []),
  ];
  tasks[0]!.objective = "research the authentication flow in the codebase";
  tasks[1]!.objective = "research the authentication flow in the codebase";
  const groups = detectDuplicateTasks(tasks);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.taskIds.sort(), ["a", "b"]);
});

test("duplicate reads across tasks are detected", () => {
  const tasks = [pt("a", ["a.ts"], ["shared.ts"]), pt("b", ["b.ts"], ["shared.ts"])];
  const reports = detectDuplicateReads(tasks);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.path, "shared.ts");
});

test("dependency cycle is rejected without an executable wave", () => {
  const graph = buildTaskGraph(
    [
      { id: "a", title: "a", objective: "a", dependencies: ["b"] },
      { id: "b", title: "b", objective: "b", dependencies: ["a"] },
    ],
    1000,
  );
  assert.ok(graph.errors.some((w) => w.toLowerCase().includes("cycle")));
  assert.deepEqual(graph.waves, []);
});

test("duplicate IDs and unknown dependencies are rejected", () => {
  const graph = buildTaskGraph([
    { id: "a", title: "a", objective: "a", dependencies: ["missing"] },
    { id: "a", title: "duplicate", objective: "b" },
  ], 1000);
  assert.ok(graph.errors.some((error) => error.includes("duplicate task id")));
  assert.ok(graph.errors.some((error) => error.includes("unknown task")));
  assert.deepEqual(graph.waves, []);
});

test("overlapping write scopes are serialized, not returned in a safe wave", () => {
  const plan = planTasks([
    { id: "a", title: "a", objective: "a", writeScope: ["src"] },
    { id: "b", title: "b", objective: "b", writeScope: ["src/auth.ts"] },
  ], { maxConcurrentTasks: 4, defaultBudgetTokens: 1000 });
  assert.deepEqual(plan.waves, [["a"], ["b"]]);
});

test("path aliases and traversal cannot bypass task scope safety", () => {
  const graph = buildTaskGraph([{ id: "a", title: "a", objective: "a", writeScope: ["src/../src/a.ts"] }], 1000);
  assert.ok(graph.errors.some((error) => error.includes("invalid write scope")));
});

test("multi-file ownership is all-or-none", async () => {
  const store = new JsonlStore(await mkdtemp(join(tmpdir(), "cortex-owner-")));
  const ownership = new OwnershipManager(store);
  await ownership.claim("first", ["a.ts"]);
  const result = await ownership.claim("second", ["a.ts", "b.ts"]);
  assert.deepEqual(result.granted, []);
  assert.deepEqual(result.denied, [{ path: "a.ts", heldBy: "first" }]);
  assert.equal((await ownership.load()).claims["b.ts"], undefined);
});

test("waves are capped by max concurrency", () => {
  const plan = planTasks(
    [
      { id: "t1", title: "1", objective: "one", writeScope: ["1"] },
      { id: "t2", title: "2", objective: "two", writeScope: ["2"] },
      { id: "t3", title: "3", objective: "three", writeScope: ["3"] },
    ],
    { maxConcurrentTasks: 2, defaultBudgetTokens: 1000 },
  );
  for (const wave of plan.waves) assert.ok(wave.length <= 2);
});
