import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlStore, MemoryManager } from "../../packages/core/src/index.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ci-store-"));
}

test("jsonl store append/read roundtrip", async () => {
  const dir = await tmp();
  const store = new JsonlStore(dir);
  await store.appendJsonl("memory/durable.jsonl", [{ a: 1 }, { a: 2 }]);
  const res = await store.readJsonl<{ a: number }>("memory/durable.jsonl");
  assert.equal(res.entries.length, 2);
  assert.equal(res.corruptLines, 0);
});

test("jsonl store tolerates corrupt lines", async () => {
  const dir = await tmp();
  const store = new JsonlStore(dir);
  await mkdir(join(dir, "memory"), { recursive: true });
  await writeFile(join(dir, "memory/durable.jsonl"), '{"a":1}\nNOT JSON\n{"a":2}\n', "utf8");
  const res = await store.readJsonl<{ a: number }>("memory/durable.jsonl");
  assert.equal(res.entries.length, 2);
  assert.equal(res.corruptLines, 1);
});

test("json write is atomic and readable", async () => {
  const dir = await tmp();
  const store = new JsonlStore(dir);
  await store.writeJson("state/version.json", { schemaVersion: 1 });
  const v = await store.readJson<{ schemaVersion: number }>("state/version.json");
  assert.equal(v?.schemaVersion, 1);
});

test("path traversal is rejected by store", async () => {
  const dir = await tmp();
  const store = new JsonlStore(dir);
  await assert.rejects(() => store.writeJson("../escape.json", {}));
  await assert.rejects(() => store.writeJson("/tmp/absolute-escape.json", {}));
});

test("resolveConfinedPath rejects .., absolute, and Windows escapes", async () => {
  const { resolveConfinedPath } = await import(
    "../../packages/core/src/storage/safe-path.ts"
  );
  const dir = await tmp();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "root"), { recursive: true });
  const root = join(dir, "root");
  await assert.rejects(() => resolveConfinedPath(root, "../escape"), /outside/);
  await assert.rejects(() => resolveConfinedPath(root, "/etc/passwd"), /outside|absolute/);
  await assert.rejects(() => resolveConfinedPath(root, "C:\\Windows\\x"), /outside|absolute/);
  await assert.rejects(() => resolveConfinedPath(root, "C:/Windows/x"), /outside|absolute/);
  await assert.rejects(() => resolveConfinedPath(root, "\\\\host\\share"), /outside|absolute/);
  await assert.rejects(() => resolveConfinedPath(root, "a/../../b"), /outside/);
  // Legitimate child resolves inside root (canonical path: macOS aliases
  // /var -> /private/var, so compare against the realpath root).
  const ok = await resolveConfinedPath(root, join(root, "state/health.json"), {
    allowMissingRoot: true,
  });
  const { realpath } = await import("node:fs/promises");
  assert.ok(ok.startsWith(await realpath(root)));
  assert.ok(ok.endsWith(join("state", "health.json")));
});

test("advisory lock serializes and releases", async () => {
  const dir = await tmp();
  const store = new JsonlStore(dir);
  const release = await store.acquireLock("t");
  await release();
  // Re-acquire should succeed after release.
  const release2 = await store.acquireLock("t");
  await release2();
  assert.ok(true);
});

test("storage close is idempotent for the filesystem adapter", async () => {
  const store = new JsonlStore(await tmp());
  await store.close();
  await store.close();
});

test("memory manager records and retrieves", async () => {
  const dir = await tmp();
  const store = new JsonlStore(dir);
  const mgr = new MemoryManager(store);
  const rec = await mgr.record(
    {
      kind: "decision",
      content: "use pnpm workspaces for the monorepo",
      confidence: 0.9,
      sourceReferences: [{ kind: "file", value: "pnpm-workspace.yaml" }],
      tags: ["build", "monorepo"],
    },
    { requireEvidenceForDurableFacts: true, redactLikelySecrets: true, minimumConfidence: 0.65 },
  );
  assert.equal(rec.status, "recorded");

  const search = await mgr.search("monorepo build tooling", ["build"], [], [], {
    maxEntries: 5,
    maxTokens: 1000,
  });
  assert.ok(search.selections.length >= 1);
  assert.ok(search.selections[0]!.reason.length > 0);
});

test("contradiction heuristic holds only the new assertion for review", async () => {
  const dir = await tmp();
  const store = new JsonlStore(dir);
  const mgr = new MemoryManager(store);
  const opts = { requireEvidenceForDurableFacts: false, redactLikelySecrets: true, minimumConfidence: 0 };
  await mgr.record({ kind: "convention", content: "we always use tabs for indentation in every committed source file daily", confidence: 0.8 }, opts);
  const second = await mgr.record(
    { kind: "convention", content: "we never use tabs for indentation in every committed source file daily", confidence: 0.8 },
    opts,
  );
  assert.equal(second.disputed, true);
  assert.equal(second.entry?.status, "candidate");
  assert.ok(second.entry?.tags.includes("possible-contradiction"));
  const entries = await mgr.loadAll();
  assert.equal(entries.find((entry) => entry.content.includes("always use tabs"))?.status, "active");
});
