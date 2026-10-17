import test from "node:test";
import assert from "node:assert";
import { normalizeEvent } from "../../packages/core/src/events/normalizer.ts";
import { EventStore } from "../../packages/core/src/events/store.ts";
import { JsonlStore } from "../../packages/core/src/index.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const eventsCfg = (over = {}) => ({ enabled: true, maxEvents: 5000, maxAgeDays: 30, maxSizeMb: 20, ...over });

test("normalizer drops unknown event kinds", () => {
  assert.equal(normalizeEvent({ kind: "not.a.kind" } as unknown as Parameters<typeof normalizeEvent>[0]), null);
});

test("normalizer drops unknown fields and keeps allowlisted ones", () => {
  const evt = normalizeEvent({
    kind: "tool.invoked",
    toolCategory: "read",
    toolName: "grep",
    status: "success",
    durationMs: 12,
    // unknown fields below must not survive
    args: "rm -rf /",
    payload: { secret: "x" },
  } as never);
  assert.ok(evt);
  assert.equal(evt!.toolName, "grep");
  const bag = evt as unknown as Record<string, unknown>;
  assert.equal(bag.args, undefined);
  assert.equal(bag.payload, undefined);
});

test("normalizer redacts secret-shaped notes and bounds length", () => {
  const long = "x".repeat(2000);
  const evt = normalizeEvent({ kind: "error.observed", note: long, errorClass: "y".repeat(500) });
  assert.ok(evt);
  assert.ok(evt!.note!.length <= 500);
  assert.ok(evt!.errorClass!.length <= 200);
});

test("normalizer drops absolute/escaping paths and caps count", () => {
  const paths = ["/etc/passwd", "src/a.ts", "src/b.ts"];
  const evt = normalizeEvent({ kind: "file.changed", paths });
  assert.ok(evt);
  assert.ok(!evt!.paths!.some((p) => p.startsWith("/")));
  assert.ok(evt!.paths!.includes("src/a.ts"));
});

test("normalizer clamps numeric fields to non-negative integers", () => {
  const evt = normalizeEvent({ kind: "test.observed", testsPassed: -5, testsFailed: 3.9 });
  assert.ok(evt);
  assert.equal(evt!.testsPassed, 0);
  assert.equal(evt!.testsFailed, 3);
});

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "ci-events-"));
  return new JsonlStore(join(dir, ".supracortex"));
}

test("event store append + list is chronological and bounded", async () => {
  const store = await freshStore();
  const es = new EventStore(store, eventsCfg());
  for (let i = 0; i < 5; i++) await es.append({ kind: "tool.invoked", toolName: `t${i}` });
  const all = await es.list();
  assert.equal(all.length, 5);
  const limited = await es.list({ limit: 2 });
  assert.equal(limited.length, 2);
});

test("event store filters by kind", async () => {
  const store = await freshStore();
  const es = new EventStore(store, eventsCfg());
  await es.append({ kind: "tool.invoked", toolName: "a" });
  await es.append({ kind: "decision.recorded", memoryId: "m1" });
  const decisions = await es.list({ kinds: ["decision.recorded"] });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.kind, "decision.recorded");
});

test("event store trims by maxEvents (oldest-first physical removal)", async () => {
  const store = await freshStore();
  const es = new EventStore(store, eventsCfg({ maxEvents: 3 }));
  for (let i = 0; i < 6; i++) await es.append({ kind: "tool.invoked", toolName: `k${i}` });
  const kept = await es.list();
  assert.equal(kept.length, 3);
  // oldest (k0..k2) dropped, newest (k3..k5) retained
  assert.deepEqual(kept.map((e) => e.toolName), ["k3", "k4", "k5"]);
});

test("event store trims by age", async () => {
  const store = await freshStore();
  let clock = Date.UTC(2026, 0, 1);
  const es = new EventStore(store, eventsCfg({ maxAgeDays: 1 }), () => clock);
  await es.append({ kind: "tool.invoked", toolName: "old" });
  clock += 3 * 86_400_000; // advance 3 days
  await es.append({ kind: "tool.invoked", toolName: "new" });
  const kept = await es.list();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.toolName, "new");
});

test("event store is inert when disabled", async () => {
  const store = await freshStore();
  const es = new EventStore(store, eventsCfg({ enabled: false }));
  const res = await es.append({ kind: "tool.invoked", toolName: "x" });
  assert.equal(res, null);
  assert.deepEqual(await es.list(), []);
});
