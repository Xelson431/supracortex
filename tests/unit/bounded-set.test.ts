import test from "node:test";
import assert from "node:assert";
import { boundedAdd, MAX_TRACKED_SESSIONS } from "../../packages/opencode/src/bounded-set.ts";

// Regression: the plugin process is long-lived and tracks session ids in Sets
// that only shrink on lifecycle events. boundedAdd guarantees O(max) memory
// even if millions of sessions are seen and no delete events ever arrive.

test("boundedAdd never exceeds the cap even under unbounded inserts", () => {
  const s = new Set<string>();
  for (let i = 0; i < 100_000; i++) boundedAdd(s, `session-${i}`, 2000);
  assert.equal(s.size, 2000, "size stays capped");
  // The most recent inserts are retained (oldest evicted).
  assert.ok(s.has("session-99999"), "newest kept");
  assert.ok(!s.has("session-0"), "oldest evicted");
});

test("boundedAdd is idempotent for existing values (no eviction churn)", () => {
  const s = new Set<string>();
  boundedAdd(s, "a", 3);
  boundedAdd(s, "b", 3);
  boundedAdd(s, "c", 3);
  // Re-adding an existing value must not evict or grow.
  boundedAdd(s, "a", 3);
  assert.equal(s.size, 3);
  assert.ok(s.has("a") && s.has("b") && s.has("c"));
});

test("boundedAdd evicts oldest-first (insertion order)", () => {
  const s = new Set<string>();
  boundedAdd(s, "1", 2);
  boundedAdd(s, "2", 2);
  boundedAdd(s, "3", 2); // evicts "1"
  assert.deepEqual([...s], ["2", "3"]);
});

test("boundedAdd with max<=0 is a no-op (defensive)", () => {
  const s = new Set<string>();
  boundedAdd(s, "x", 0);
  boundedAdd(s, "y", -5);
  assert.equal(s.size, 0);
});

test("MAX_TRACKED_SESSIONS is a sane bound", () => {
  assert.ok(MAX_TRACKED_SESSIONS > 0 && MAX_TRACKED_SESSIONS <= 100_000);
});

test("shrinking then re-growing stays bounded (simulated churn)", () => {
  const s = new Set<string>();
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 500; i++) boundedAdd(s, `r${round}-s${i}`, 1000);
  }
  assert.ok(s.size <= 1000, `stayed bounded (${s.size})`);
});
