/**
 * Regression tests for issues found in independent review.
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";

async function engineIn(): Promise<{ dir: string; engine: Engine; store: JsonlStore }> {
  const dir = await mkdtemp(join(tmpdir(), "ci-reg-"));
  const { config } = resolveConfig({ project: { enabled: true } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  return { dir, engine, store };
}

test("recordOutcome redacts secrets in summary/failureReason/learnings", async () => {
  const { engine, store } = await engineIn();
  await engine.recordOutcome({
    taskId: "t1",
    status: "failure",
    summary: 'deploy failed, API_KEY = "sk-abcdef0123456789abcdef" was wrong',
    touchedFiles: ["src/app.ts"],
    learnings: ['the token ghp_0123456789abcdefghijABCDEFGHIJ0123 leaked'],
    failureReason: 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrst rejected',
    recordedAt: new Date().toISOString(),
  });
  const res = await store.readJsonl<{ summary: string; failureReason: string; learnings: string[] }>(
    "tasks/completed.jsonl",
  );
  const raw = JSON.stringify(res.entries);
  assert.ok(!raw.includes("sk-abcdef0123456789"), "no api key");
  assert.ok(!raw.includes("ghp_0123456789"), "no gh token");
  assert.ok(!raw.includes("eyJhbGciOiJIUzI1NiJ9"), "no jwt");
  assert.ok(raw.includes("[REDACTED]"));
});

test("recordMemory redacts secrets in source-reference notes", async () => {
  const { engine } = await engineIn();
  const res = await engine.recordMemory({
    kind: "decision",
    content: "use env var for the key",
    confidence: 0.9,
    sourceReferences: [
      { kind: "external", value: "https://example.com", note: 'set token=ghp_0123456789abcdefghijABCDEFGHIJ0123' },
    ],
  });
  assert.equal(res.status, "recorded");
  const note = res.entry?.sourceReferences[0]?.note ?? "";
  assert.ok(!note.includes("ghp_0123456789"), "note redacted");
});

test("recordMemory drops out-of-project file references", async () => {
  const { engine } = await engineIn();
  const res = await engine.recordMemory({
    kind: "fact",
    content: "config lives outside",
    confidence: 0.9,
    sourceReferences: [
      { kind: "file", value: "/etc/passwd" },
      { kind: "file", value: "src/real.ts" },
    ],
    relatedFiles: ["/etc/shadow", "src/real.ts"],
  });
  assert.equal(res.status, "recorded");
  const refPaths = res.entry!.sourceReferences.map((r) => r.value);
  assert.ok(!refPaths.includes("/etc/passwd"), "traversal ref dropped");
  assert.ok(refPaths.includes("src/real.ts"), "in-project ref kept");
  assert.ok(!res.entry!.relatedFiles.some((f) => f.startsWith("/")), "no absolute related files");
});

test("indexer does not follow symlinks outside the project by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-reg-"));
  const outside = await mkdtemp(join(tmpdir(), "ci-outside-"));
  await writeFile(join(outside, "secret-outside.ts"), "export const leaked = 1;\n", "utf8");
  const { symlink } = await import("node:fs/promises");
  try {
    await symlink(outside, join(dir, "linked"));
  } catch {
    return; // symlinks may be unavailable; skip
  }
  const { config } = resolveConfig({ project: { enabled: true } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  const index = await engine.ensureIndex();
  const paths = Object.keys(index.files);
  assert.ok(!paths.some((p) => p.includes("secret-outside")), "symlinked-outside file not indexed");
});
