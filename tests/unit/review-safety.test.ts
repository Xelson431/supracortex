/**
 * Review workflow safety: evidence-hash invalidation makes an entry `stale`,
 * and `refresh-evidence` is the explicit, audited recovery action that accepts
 * the current file hashes without activating the entry. Activation stays a
 * separate `approve`. No network.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  Engine,
  JsonlStore,
  resolveConfig,
  type MemoryEntry,
} from "../../packages/core/src/index.ts";

const STORAGE = ".supracortex";

interface ReviewError {
  error?: string;
  missing?: string[];
}

interface RefreshResult {
  refreshed?: boolean;
  verified?: boolean;
  entryId?: string;
  status?: string;
  refs?: Array<{ file: string; oldHash: string; newHash: string }>;
  reason?: string;
  error?: string;
  missing?: string[];
}

async function setup(file = "src/a.ts", content = "export const answer = 1;\n") {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-review-safety-"));
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, file), content, "utf8");
  const { config } = resolveConfig({
    defaults: DEFAULT_CONFIG,
    project: {
      enabled: true,
      graph: { enabled: false },
      supraspace: { enabled: false },
    },
    env: {},
  });
  const store = new JsonlStore(join(projectRoot, STORAGE));
  const engine = new Engine({
    config,
    store,
    pluginVersion: "test",
    projectRoot,
    indexCacheTtlMs: 0,
  });
  return { engine, projectRoot, store };
}

async function recordFileFact(engine: Engine, file: string): Promise<MemoryEntry> {
  const rec = await engine.recordMemory({
    kind: "fact",
    content: `The constant in ${file} is the authoritative default.`,
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: file }],
  });
  assert.equal(rec.status, "recorded");
  assert.ok(rec.entry);
  return rec.entry;
}

function hashedRef(entry: MemoryEntry, file: string): string {
  const ref = entry.sourceReferences.find((r) => r.kind === "file" && r.value === file);
  assert.ok(ref?.hash, `expected hashed file reference for ${file}`);
  return ref.hash;
}

async function reload(engine: Engine, id: string): Promise<MemoryEntry> {
  const all = await engine.review({ type: "list", statuses: ["active", "stale"], limit: 100 }) as MemoryEntry[];
  const entry = all.find((e) => e.id === id);
  assert.ok(entry, `expected entry ${id}`);
  return entry;
}

test("refresh-evidence accepts new hashes, then approve activates", async () => {
  const { engine, projectRoot } = await setup();
  try {
    const entry = await recordFileFact(engine, "src/a.ts");
    const oldHash = hashedRef(entry, "src/a.ts");

    await writeFile(join(projectRoot, "src/a.ts"), "export const answer = 2;\n", "utf8");
    await engine.ensureIndex(true);

    const stale = await reload(engine, entry.id);
    assert.equal(stale.status, "stale");
    assert.ok(stale.tags.includes("evidence-stale"));
    assert.equal(hashedRef(stale, "src/a.ts"), oldHash);

    const denied = await engine.review({ type: "approve", id: entry.id }) as ReviewError;
    assert.match(denied.error ?? "", /evidence mismatch/);

    const res = await engine.review({ type: "refresh-evidence", id: entry.id }) as RefreshResult;
    assert.equal(res.refreshed, true);
    assert.equal(res.entryId, entry.id);
    assert.equal(res.status, "stale");
    assert.equal(res.refs?.length, 1);
    assert.equal(res.refs?.[0]?.file, "src/a.ts");
    assert.equal(res.refs?.[0]?.oldHash, oldHash);

    const index = await engine.ensureIndex();
    const newHash = index.files["src/a.ts"]?.hash;
    assert.ok(newHash);
    assert.notEqual(newHash, oldHash);
    assert.equal(res.refs?.[0]?.newHash, newHash);

    const refreshed = await reload(engine, entry.id);
    assert.equal(refreshed.status, "stale", "refresh must not activate");
    assert.equal(hashedRef(refreshed, "src/a.ts"), newHash);
    assert.ok(refreshed.lastVerifiedAt, "lastVerifiedAt is set by verification");
    assert.ok(!refreshed.tags.includes("evidence-stale"));

    const auditRaw = await readFile(join(projectRoot, STORAGE, "memory", "review-audit.jsonl"), "utf8");
    const rows = auditRaw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.entryId, entry.id);
    assert.equal(row.action, "refresh-evidence");
    assert.equal(row.resultingStatus, "stale");
    assert.equal(row.storageBackend, "jsonl");
    assert.equal(row.pluginVersion, "test");
    assert.ok(typeof row.runId === "string" && row.runId.length > 0);
    assert.ok(typeof row.at === "string");
    assert.deepEqual(row.refs, [{ file: "src/a.ts", oldHash, newHash }]);

    const approved = await engine.review({ type: "approve", id: entry.id }) as MemoryEntry;
    assert.equal(approved.status, "active");
    assert.equal((await reload(engine, entry.id)).status, "active");
  } finally {
    await engine.close();
  }
});

test("refresh-evidence re-confirms an aged entry with no file references", async () => {
  const { engine, store } = await setup();
  try {
    const createdAt = new Date(Date.now() - 10_000).toISOString();
    await store.appendJsonl("memory/decisions.jsonl", [{
      id: "aged-no-files",
      kind: "decision",
      content: "Aged decision without file evidence.",
      createdAt,
      updatedAt: createdAt,
      confidence: 0.9,
      status: "active",
      sourceReferences: [],
      relatedFiles: [],
      relatedSymbols: [],
      tags: ["aged"],
      invalidationRules: [{ kind: "time-elapsed", expiresAt: new Date(Date.now() - 1).toISOString() }],
    }]);

    await engine.searchMemory("aged decision", { tags: ["aged"] });
    const aged = await reload(engine, "aged-no-files");
    assert.equal(aged.status, "active");
    assert.ok(aged.needsReverifyAt, "age marker is pending re-verification");

    const res = await engine.review({ type: "refresh-evidence", id: "aged-no-files" }) as RefreshResult;
    assert.equal(res.refreshed, false);
    assert.equal(res.verified, true);
    assert.equal(res.entryId, "aged-no-files");
    assert.equal(res.status, "active");

    const verified = await reload(engine, "aged-no-files");
    assert.equal(verified.status, "active", "re-confirmation must not change status");
    assert.equal(verified.needsReverifyAt, undefined, "marker cleared");
    assert.ok(verified.lastVerifiedAt, "verification timestamp set");
    assert.equal(verified.updatedAt, createdAt, "updatedAt preserved");

    const approved = await engine.review({ type: "approve", id: "aged-no-files" }) as MemoryEntry;
    assert.equal(approved.status, "active");
    const after = await reload(engine, "aged-no-files");
    assert.equal(after.status, "active");
    assert.equal(after.needsReverifyAt, undefined, "approval keeps the marker cleared");
  } finally {
    await engine.close();
  }
});

test("refresh-evidence clears the age marker for unchanged hashed evidence", async () => {
  const { engine } = await setup();
  try {
    const rec = await engine.recordMemory({
      kind: "fact",
      content: "The constant in src/a.ts is the authoritative default.",
      confidence: 0.9,
      sourceReferences: [{ kind: "file", value: "src/a.ts" }],
      invalidationRules: [{ kind: "time-elapsed", expiresAt: new Date(Date.now() - 1).toISOString() }],
    });
    assert.equal(rec.status, "recorded");
    const id = rec.entry!.id;

    await engine.searchMemory("authoritative default");
    const aged = await reload(engine, id);
    assert.equal(aged.status, "active");
    assert.ok(aged.needsReverifyAt, "age marker is pending re-verification");

    const res = await engine.review({ type: "refresh-evidence", id }) as RefreshResult;
    assert.equal(res.refreshed, false);
    assert.equal(res.verified, true);
    assert.equal(res.entryId, id);
    assert.equal(res.status, "active");

    const verified = await reload(engine, id);
    assert.equal(verified.status, "active");
    assert.equal(verified.needsReverifyAt, undefined, "marker cleared");
    assert.ok(verified.lastVerifiedAt, "verification timestamp set");
  } finally {
    await engine.close();
  }
});

test("refresh-evidence refuses missing files without changing the entry", async () => {
  const { engine, projectRoot } = await setup("src/missing.ts", "export const gone = true;\n");
  try {
    const entry = await recordFileFact(engine, "src/missing.ts");
    const oldHash = hashedRef(entry, "src/missing.ts");

    await unlink(join(projectRoot, "src/missing.ts"));
    await engine.ensureIndex(true);

    const stale = await reload(engine, entry.id);
    assert.equal(stale.status, "stale");
    assert.ok(stale.tags.includes("evidence-stale"));

    const res = await engine.review({ type: "refresh-evidence", id: entry.id }) as RefreshResult;
    assert.match(res.error ?? "", /evidence file missing/);
    assert.deepEqual(res.missing, ["src/missing.ts"]);

    const unchanged = await reload(engine, entry.id);
    assert.equal(unchanged.status, "stale");
    assert.ok(unchanged.tags.includes("evidence-stale"));
    assert.equal(hashedRef(unchanged, "src/missing.ts"), oldHash);
    assert.equal(unchanged.lastVerifiedAt, undefined);

    await assert.rejects(readFile(join(projectRoot, STORAGE, "memory", "review-audit.jsonl"), "utf8"));
  } finally {
    await engine.close();
  }
});
