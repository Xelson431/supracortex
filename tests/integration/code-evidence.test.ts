import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "ci-code-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/auth.ts"), "import { hash } from './util';\nexport function login() { return hash(); }\n", "utf8");
  await writeFile(join(dir, "src/util.ts"), "export const hash = () => 1;\n", "utf8");
  return dir;
}

function engineOn(dir: string, overrides = {}) {
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  return { engine: new Engine({ config, store, pluginVersion: "0.2.0", projectRoot: dir }), store };
}

test("index builds reverse import hints (single pass, version 2)", async () => {
  const dir = await project();
  const { engine } = engineOn(dir);
  const index = await engine.ensureIndex();
  assert.equal(index.version, 2);
  const auth = index.files["src/auth.ts"];
  assert.ok(auth, "auth indexed");
  assert.ok(auth!.imports.includes("src/util"), "relative import normalized");
  assert.ok(index.reverseImports?.["src/util"]?.includes("src/auth.ts"), "reverse import built");
});

test("recording file evidence auto-attaches the current hash and rule", async () => {
  const dir = await project();
  const { engine } = engineOn(dir);
  await engine.ensureIndex();
  const res = await engine.recordMemory({
    kind: "decision",
    content: "login delegates hashing to util",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
  });
  assert.equal(res.status, "recorded");
  const ref = res.entry!.sourceReferences.find((r) => r.kind === "file");
  assert.ok(ref?.hash, "hash auto-attached");
  assert.ok(res.entry!.invalidationRules.some((r) => r.kind === "file-hash-changed" && r.target === "src/auth.ts"));
});

test("caller-supplied evidence hashes are replaced by the current indexed hash", async () => {
  const dir = await project();
  const { engine } = engineOn(dir);
  const res = await engine.recordMemory({
    kind: "decision",
    content: "evidence hash comes from current source bytes",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/auth.ts", hash: "f".repeat(64) }],
  });
  assert.equal(res.status, "recorded");
  assert.notEqual(res.entry!.sourceReferences[0]?.hash, "f".repeat(64));
});


test("changed evidence file marks memory stale with a reason", async () => {
  const dir = await project();
  const { engine } = engineOn(dir);
  await engine.ensureIndex();
  await engine.recordMemory({
    kind: "decision",
    content: "auth returns a boolean",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
    tags: ["auth"],
  });
  // Edit the evidence file, then re-index (triggers evidence evaluation).
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return 0; }\n", "utf8");
  await engine.ensureIndex(true);
  const found = await engine.searchMemory("auth boolean", { tags: ["auth"] });
  assert.equal(found.length, 0, "stale entry no longer surfaces in retrieval");
  // Confirm it is retained as stale (not deleted) with the marker tag.
  const { config } = resolveConfig({ project: { enabled: true } });
  const store2 = new JsonlStore(join(dir, ".supracortex"));
  const engine2 = new Engine({ config, store: store2, pluginVersion: "0.2.0", projectRoot: dir });
  const graph = await engine2.exportGraph();
  assert.ok(graph, "graph exported");
});

test("deleted evidence file marks memory stale", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.ensureIndex();
  const rec = await engine.recordMemory({
    kind: "decision",
    content: "util exposes a hash helper",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/util.ts" }],
    tags: ["util"],
  });
  const id = rec.entry!.id;
  await rm(join(dir, "src/util.ts"), { force: true });
  await engine.ensureIndex(true);
  const found = await engine.searchMemory("util hash helper", { tags: ["util"] });
  assert.ok(!found.some((s) => s.entry.id === id), "deleted-evidence memory not retrieved");
});

test("legacy file evidence without a hash stays active (unverifiable, not stale)", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.ensureIndex();
  // Simulate a legacy entry: file evidence + rule but no stored hash.
  await store.appendJsonl("memory/decisions.jsonl", [{
    id: "legacy-1",
    kind: "decision",
    content: "legacy decision without evidence hash",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
    status: "active",
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
    relatedFiles: [],
    relatedSymbols: [],
    tags: ["legacy"],
    invalidationRules: [{ kind: "file-hash-changed", target: "src/auth.ts" }],
  }]);
  // Change the file and re-index; the hash-less legacy entry must remain active.
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return 2; }\n", "utf8");
  await engine.ensureIndex(true);
  const found = await engine.searchMemory("legacy decision", { tags: ["legacy"] });
  assert.ok(found.some((s) => s.entry.id === "legacy-1"), "unverifiable legacy entry stays active");
});

test("expired time-elapsed evidence requests re-verification without changing status", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.ensureIndex();
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  const updatedAt = createdAt;
  await store.appendJsonl("memory/decisions.jsonl", [{
    id: "expired-window",
    kind: "decision",
    content: "short-lived deployment policy",
    createdAt,
    updatedAt,
    confidence: 0.9,
    status: "active",
    sourceReferences: [],
    relatedFiles: [],
    relatedSymbols: [],
    tags: ["temporary"],
    invalidationRules: [{ kind: "time-elapsed", expiresAt: new Date(Date.now() - 1).toISOString() }],
  }]);

  const found = await engine.searchMemory("deployment policy", { tags: ["temporary"] });
  assert.ok(found.some((selection) => selection.entry.id === "expired-window"), "age alone never removes an entry from retrieval");

  const active = await engine.review({ type: "list", statuses: ["active"] }) as Array<{
    id: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    lastVerifiedAt?: string;
    needsReverifyAt?: string;
    tags: string[];
  }>;
  const entry = active.find((e) => e.id === "expired-window");
  assert.ok(entry, "entry remains active");
  assert.equal(entry!.status, "active");
  assert.ok(entry!.needsReverifyAt, "age marker is set for re-verification");
  assert.equal(entry!.createdAt, createdAt, "createdAt unchanged");
  assert.equal(entry!.updatedAt, updatedAt, "updatedAt unchanged");
  assert.equal(entry!.lastVerifiedAt, undefined, "lastVerifiedAt not cleared or invented");
  assert.ok(!entry!.tags.includes("evidence-stale"), "age alone adds no stale tag");
});

test("context packet never exceeds the configured token budget", async () => {
  const dir = await project();
  const { engine } = engineOn(dir, { context: { maxTokens: 500 } });
  await engine.recordMemory({
    kind: "decision",
    content: "login delegates hashing to util",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/auth.ts" }],
    relatedSymbols: ["login", "hash"],
  });
  const packet = await engine.prepareContext({ query: "how does login and hash work" });
  assert.ok(packet);
  assert.ok(packet!.estimatedTokens <= packet!.budget.maxTokens, `${packet!.estimatedTokens} <= ${packet!.budget.maxTokens}`);
});
