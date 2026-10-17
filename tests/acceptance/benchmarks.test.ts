import test from "node:test";
import assert from "node:assert";
import { runBenchmarks } from "../../benchmarks/run.ts";

test("deterministic quality harness passes all fixture benchmarks", async () => {
  const results = await runBenchmarks();
  assert.ok(results.length >= 5, "expected at least five benchmarks");
  const failed = results.filter((r) => !r.pass);
  assert.equal(
    failed.length,
    0,
    `failing benchmarks: ${failed.map((f) => `${f.name} (${f.detail})`).join("; ")}`,
  );
});
