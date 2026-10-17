import test from "node:test";
import assert from "node:assert/strict";
import {
  allMemoryTransitionPairs,
  decideMemoryTransition,
} from "../../packages/core/src/index.ts";

test("memory transition table covers every status pair deterministically", () => {
  const pairs = allMemoryTransitionPairs();
  assert.equal(pairs.length, 36);
  for (const pair of pairs) {
    assert.equal(typeof pair.decision.allowed, "boolean");
    assert.equal(typeof pair.decision.idempotent, "boolean");
    assert.ok(pair.decision.reason.length > 0);
  }
});

test("same-state retries are idempotent", () => {
  const decision = decideMemoryTransition("active", "active");
  assert.deepEqual(decision, {
    allowed: true,
    idempotent: true,
    reason: "already-in-target-state",
  });
});

test("forgotten and superseded history cannot be silently revived", () => {
  assert.equal(decideMemoryTransition("forgotten", "active").allowed, false);
  assert.equal(decideMemoryTransition("superseded", "active").allowed, false);
  assert.equal(decideMemoryTransition("superseded", "forgotten").allowed, true);
});

test("review and invalidation paths have explicit allowed transitions", () => {
  assert.equal(decideMemoryTransition("candidate", "active").allowed, true);
  assert.equal(decideMemoryTransition("active", "disputed").allowed, true);
  assert.equal(decideMemoryTransition("active", "stale").allowed, true);
  assert.equal(decideMemoryTransition("stale", "active").allowed, true);
});
