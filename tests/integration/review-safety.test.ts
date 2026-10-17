import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "ci-review-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return true; }\n", "utf8");
  return dir;
}

function engineOn(dir: string, overrides = {}) {
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  return { engine: new Engine({ config, store, pluginVersion: "0.2.0", projectRoot: dir }), store };
}

async function seedCandidate(store: JsonlStore, over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const entry = {
    id: over.id ?? "cand-1",
    kind: over.kind ?? "fact",
    content: over.content ?? "candidate fact awaiting review",
    createdAt: now,
    updatedAt: now,
    confidence: 0.6,
    status: "candidate",
    sourceReferences: [],
    relatedFiles: [],
    relatedSymbols: [],
    tags: over.tags ?? ["imported"],
    invalidationRules: [],
    ...over,
  };
  await store.appendJsonl("memory/durable.jsonl", [entry]);
  return entry.id as string;
}

test("candidate is excluded from retrieval until approved, then surfaces", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.init();
  const id = await seedCandidate(store, { content: "auth uses cookies", tags: ["auth"] });
  const before = await engine.searchMemory("auth cookies", { tags: ["auth"] });
  assert.equal(before.length, 0, "candidate not retrieved");
  await engine.review({ type: "approve", id });
  const after = await engine.searchMemory("auth cookies", { tags: ["auth"] });
  assert.ok(after.some((s) => s.entry.id === id), "approved entry retrieved");
});

test("review list filters by status", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.init();
  await seedCandidate(store, { id: "c1", content: "first candidate entry" });
  await seedCandidate(store, { id: "c2", content: "second candidate entry" });
  const list = (await engine.review({ type: "list", statuses: ["candidate"] })) as Array<{ id: string }>;
  assert.equal(list.length, 2);
});

test("edit preserves id and kind while changing content", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.init();
  const id = await seedCandidate(store, { id: "e1", kind: "decision", content: "old text here" });
  const res = (await engine.review({ type: "edit", id, content: "revised decision text" })) as { status: string; entry?: { id: string; kind: string; content: string } };
  assert.equal(res.status, "edited");
  assert.equal(res.entry!.id, "e1");
  assert.equal(res.entry!.kind, "decision");
  assert.match(res.entry!.content, /revised decision text/);
});

test("dispute and suppress change status; suppressed is hidden", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.init();
  const id = await seedCandidate(store, { id: "s1", content: "questionable claim", tags: ["q"] });
  await engine.review({ type: "approve", id });
  await engine.review({ type: "suppress", id });
  const found = await engine.searchMemory("questionable claim", { tags: ["q"] });
  assert.ok(!found.some((s) => s.entry.id === id), "suppressed entry hidden");
});

test("purge physically removes an entry", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.init();
  const id = await seedCandidate(store, { id: "p1", content: "to be purged" });
  const res = (await engine.review({ type: "purge", id })) as { purged: boolean };
  assert.equal(res.purged, true);
  const list = (await engine.review({ type: "list", statuses: ["candidate", "active"] })) as Array<{ id: string }>;
  assert.ok(!list.some((e) => e.id === id), "purged entry gone");
});

test("manual invalidation moves an entry to stale and excludes it from active review", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.init();
  const id = await seedCandidate(store, { id: "manual-stale", status: "active", content: "manually invalidated decision" });
  const result = await engine.review({ type: "invalidate", id }) as { id?: string; status?: string };
  assert.equal(result.id, id);
  assert.equal(result.status, "stale");
  const active = await engine.review({ type: "list", statuses: ["active"] }) as Array<{ id: string }>;
  assert.ok(!active.some((entry) => entry.id === id));
});

test("pinned entries are protected from compaction expiry", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.init();
  const expired = new Date(Date.now() - 86_400_000).toISOString();
  const id = await seedCandidate(store, {
    id: "pin1",
    kind: "fact",
    status: "active",
    content: "time-limited fact",
    invalidationRules: [{ kind: "time-elapsed", target: undefined, expiresAt: expired }],
  });
  await engine.review({ type: "pin", id });
  await engine.compactMemory();
  const list = (await engine.review({ type: "list", statuses: ["active"] })) as Array<{ id: string; tags: string[] }>;
  const pinned = list.find((e) => e.id === id);
  assert.ok(pinned, "pinned entry survived compaction");
  assert.ok(pinned!.tags.includes("pinned"));
});

test("safety brief reports observed evidence from git + memory", async () => {
  const dir = await project();
  const { engine, store } = engineOn(dir);
  await engine.init();
  await seedCandidate(store, { id: "f1", kind: "failure", status: "active", content: "retry loop caused duplicate charges" });
  const git = { changedFiles: ["package.json", "src/auth.ts", ".env"], staged: [], untracked: [] };
  const brief = await engine.generateSafetyBrief(git);
  assert.ok(brief);
  assert.ok(brief!.dependencyManifestChanges.includes("package.json"), "manifest change flagged");
  assert.ok(brief!.secretRiskFiles.includes(".env"), "secret-risk file flagged");
  assert.ok(brief!.unresolvedFailures.some((f) => /duplicate charges/.test(f.content)), "unresolved failure reported");
  assert.equal(typeof brief!.testsObserved, "boolean");
});

test("importPreview does not record; importCommit stages candidates only", async () => {
  const dir = await project();
  const { engine } = engineOn(dir);
  await engine.init();
  await writeFile(join(dir, "NOTES.md"), "# Conventions\n- Always validate inbound payloads before processing them.\n", "utf8");
  const preview = await engine.importPreview("agents-md", "NOTES.md");
  assert.ok(preview.candidates.length >= 1);
  // Nothing recorded yet.
  const activeBefore = (await engine.review({ type: "list", statuses: ["active", "candidate"] })) as unknown[];
  assert.equal(activeBefore.length, 0, "preview recorded nothing");
  const commit = await engine.importCommit("agents-md", "NOTES.md");
  assert.ok(commit.staged >= 1);
  const candidates = (await engine.review({ type: "list", statuses: ["candidate"] })) as unknown[];
  assert.ok(candidates.length >= 1, "committed as candidate");
  const active = (await engine.review({ type: "list", statuses: ["active"] })) as unknown[];
  assert.equal(active.length, 0, "import never auto-activates");
});

test("disabled engine returns no-op for review and null for safety", async () => {
  const dir = await project();
  const { engine } = engineOn(dir, { enabled: false });
  await engine.init();
  const r = (await engine.review({ type: "list" })) as { disabled?: boolean };
  assert.equal(r.disabled, true);
  assert.equal(await engine.generateSafetyBrief({ changedFiles: [], staged: [], untracked: [] }), null);
});
