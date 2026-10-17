/**
 * OpenCode V2 adapter tests: message parsing matches the real 2.0.16
 * `Message` shape ({ role, content: [{ type: "text", text }] }).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { userTask } from "../../packages/opencode/src/index.ts";

test("userTask reads real V2 user messages (content parts array)", () => {
  const task = userTask([
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "fix the login bug" }, { type: "media", media: {} }] },
  ]);
  assert.equal(task, "fix the login bug");
});

test("userTask takes the latest user message and skips tool chatter", () => {
  const task = userTask([
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "tool", content: [{ type: "text", text: "result" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "now do the second thing" }] },
  ]);
  assert.equal(task, "now do the second thing");
});

test("userTask returns undefined without user text", () => {
  assert.equal(userTask([]), undefined);
  assert.equal(userTask([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]), undefined);
  assert.equal(userTask([{ role: "user", content: [] }]), undefined);
});
