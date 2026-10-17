import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";

test("compiled OpenCode adapter imports without a runtime bundle hole", async (t) => {
  const artifact = join(process.cwd(), "dist", "opencode.js");
  try {
    await access(artifact);
  } catch {
    t.skip("dist/opencode.js is missing; the release artifact job runs this after `pnpm run build`");
    return;
  }
  const module = await import(artifact);
  assert.equal(typeof module.SupraCortex, "function");
});

test("compiled OpenCode V2 adapter imports without evaluating the V1 adapter", async (t) => {
  const artifact = join(process.cwd(), "dist", "opencode-v2.js");
  try {
    await access(artifact);
  } catch {
    t.skip("dist/opencode-v2.js is missing; the release artifact job runs this after `pnpm run build`");
    return;
  }
  const module = await import(artifact);
  assert.equal(typeof module.SupraCortexV2, "object");
  assert.equal(module.SupraCortexV2.id, "supracortex");
});
