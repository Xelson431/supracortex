import test from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextCache,
  JsonlStore,
  type FileSummary,
  type IndexedFile,
} from "../../packages/core/src/index.ts";

const BASE_TIME = Date.parse("2026-04-01T12:00:00.000Z");

function summary(path: string, sourceHash: string, text = sourceHash): FileSummary {
  return {
    path,
    sourceHash,
    summary: text,
    estimatedTokens: 4,
    createdAt: new Date(BASE_TIME).toISOString(),
  };
}

function indexed(path: string, hash: string): IndexedFile {
  return {
    path,
    hash,
    sizeBytes: 10,
    estimatedTokens: 4,
    symbols: [],
    imports: [],
    indexedAt: new Date(BASE_TIME).toISOString(),
    mtimeMs: BASE_TIME,
  };
}

class ObservedJsonlStore extends JsonlStore {
  lockCount = 0;
  rewriteCount = 0;

  override async acquireLock(
    name: string,
    opts?: { staleMs?: number; retryMs?: number; timeoutMs?: number },
  ): Promise<() => Promise<void>> {
    this.lockCount++;
    return super.acquireLock(name, opts);
  }

  override async rewriteJsonl(relPath: string, entries: unknown[]): Promise<void> {
    this.rewriteCount++;
    return super.rewriteJsonl(relPath, entries);
  }
}

async function observedStore(): Promise<ObservedJsonlStore> {
  const root = await mkdtemp(join(tmpdir(), "cortex-cache-"));
  return new ObservedJsonlStore(join(root, ".supracortex"));
}

test("setMany uses one lock and one atomic rewrite with duplicate paths last-write-wins", async () => {
  const store = await observedStore();
  const cache = new ContextCache(store, () => BASE_TIME);

  await cache.setMany([
    summary("src/a.ts", "hash-a-old", "old"),
    summary("src/b.ts", "hash-b"),
    summary("src/a.ts", "hash-a-new", "new"),
  ]);

  assert.equal(store.lockCount, 1, "one batch takes one cache mutation lock");
  assert.equal(store.rewriteCount, 1, "one batch produces one committed rewrite");
  assert.equal(await cache.size(), 2);
  assert.equal((await cache.get("src/a.ts"))?.sourceHash, "hash-a-new");
  assert.equal((await cache.get("src/a.ts"))?.summary, "new");

  await cache.setMany([]);
  assert.equal(store.lockCount, 1, "an empty batch does not lock");
  assert.equal(store.rewriteCount, 1, "an empty batch does not rewrite");
});

test("duplicate persisted rows recover deterministically with the final valid row", async () => {
  const store = await observedStore();
  const cachedAt = new Date(BASE_TIME).toISOString();
  await store.rewriteJsonl("cache/summaries.jsonl", [
    { ...summary("src/a.ts", "first"), cachedAt },
    { ...summary("src/a.ts", "second"), cachedAt },
  ]);

  const cache = new ContextCache(store);
  assert.equal((await cache.get("src/a.ts"))?.sourceHash, "second");
  assert.equal(await cache.size(), 1);
});

test("path keys cannot mutate the result object's prototype", async () => {
  const store = await observedStore();
  const cache = new ContextCache(store, () => BASE_TIME);
  await cache.setMany([
    summary("__proto__", "prototype-file"),
    summary("constructor", "constructor-file"),
  ]);

  const all = await cache.all();
  assert.equal(Object.getPrototypeOf(all), null);
  assert.equal(all["__proto__"]?.sourceHash, "prototype-file");
  assert.equal(all["constructor"]?.sourceHash, "constructor-file");
  assert.deepEqual(Object.keys(all).sort(), ["__proto__", "constructor"]);
});

test("a truncated JSONL tail is ignored and removed by the next atomic batch", async () => {
  const store = await observedStore();
  const cacheDir = join(store.root, "cache");
  const cachePath = join(cacheDir, "summaries.jsonl");
  const cachedAt = new Date(BASE_TIME).toISOString();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    cachePath,
    `${JSON.stringify({ ...summary("src/good.ts", "good"), cachedAt })}\n{"path":"truncated`,
    "utf8",
  );

  const cache = new ContextCache(store, () => BASE_TIME);
  assert.ok(await cache.get("src/good.ts"));
  assert.equal(await cache.size(), 1);

  await cache.setMany([summary("src/new.ts", "new")]);
  const rewritten = await readFile(cachePath, "utf8");
  assert.doesNotThrow(() => {
    for (const line of rewritten.trim().split("\n")) JSON.parse(line);
  });
  assert.equal(await cache.size(), 2);
});

test("hash validation and index invalidation never return a stale summary", async () => {
  const store = await observedStore();
  const cache = new ContextCache(store, () => BASE_TIME);
  await cache.setMany([
    summary("src/keep.ts", "keep-hash"),
    summary("src/changed.ts", "old-hash"),
    summary("src/deleted.ts", "deleted-hash"),
  ]);

  assert.ok(await cache.getValid(indexed("src/keep.ts", "keep-hash")));
  assert.equal(await cache.getValid(indexed("src/changed.ts", "new-hash")), null);

  const removed = await cache.invalidateAgainstIndex({
    "src/keep.ts": indexed("src/keep.ts", "keep-hash"),
    "src/changed.ts": indexed("src/changed.ts", "new-hash"),
  });
  assert.equal(removed, 2, "hash-mismatched and deleted sources are removed");
  assert.deepEqual(Object.keys(await cache.all()), ["src/keep.ts"]);
});

test("separate live cache instances observe set and clear commits", async () => {
  const store = await observedStore();
  const first = new ContextCache(store, () => BASE_TIME);
  const second = new ContextCache(store, () => BASE_TIME + 1);

  await first.set(summary("src/first.ts", "one"));
  assert.ok(await first.get("src/first.ts"));

  await second.set(summary("src/second.ts", "two"));
  assert.ok(await first.get("src/second.ts"), "an existing instance sees another instance's commit");

  await second.clear();
  assert.equal(await first.size(), 0, "an existing instance sees another instance's clear");
});

test("concurrent batches serialize without losing acknowledged distinct entries", async () => {
  const store = await observedStore();
  const cache = new ContextCache(store, () => BASE_TIME);
  const batches = Array.from({ length: 12 }, (_, batch) =>
    Array.from({ length: 25 }, (_, item) => {
      const id = batch * 25 + item;
      return summary(`src/generated-${id}.ts`, `hash-${id}`);
    }),
  );

  await Promise.all(batches.map((batch) => cache.setMany(batch)));

  const all = await cache.all();
  assert.equal(Object.keys(all).length, 300);
  for (let id = 0; id < 300; id++) {
    assert.equal(all[`src/generated-${id}.ts`]?.sourceHash, `hash-${id}`);
  }
  assert.equal(store.rewriteCount, batches.length, "each batch commits once, not once per entry");
});

test("age pruning is locked and keeps entries exactly on the age boundary", async () => {
  const store = await observedStore();
  const oneDay = 86_400_000;
  const oldCache = new ContextCache(store, () => BASE_TIME - oneDay - 1);
  await oldCache.set(summary("src/old.ts", "old"));
  const boundaryCache = new ContextCache(store, () => BASE_TIME - oneDay);
  await boundaryCache.set(summary("src/boundary.ts", "boundary"));

  const locksBefore = store.lockCount;
  const removed = await boundaryCache.pruneByAge(1, BASE_TIME);
  assert.equal(removed, 1);
  assert.equal(store.lockCount, locksBefore + 1, "pruning uses the cache mutation lock");
  assert.equal(await boundaryCache.get("src/old.ts"), null);
  assert.ok(await boundaryCache.get("src/boundary.ts"));
});

test("a failed batch rewrite leaves the previously committed generation readable", async () => {
  const store = await observedStore();
  const cache = new ContextCache(store, () => BASE_TIME);
  await cache.set(summary("src/stable.ts", "stable"));

  const originalRewrite = store.rewriteJsonl.bind(store);
  store.rewriteJsonl = async () => {
    throw new Error("simulated interrupted batch");
  };
  await assert.rejects(
    cache.setMany([
      summary("src/new-a.ts", "a"),
      summary("src/new-b.ts", "b"),
    ]),
    /simulated interrupted batch/,
  );
  store.rewriteJsonl = originalRewrite;

  const reloaded = new ContextCache(store);
  assert.ok(await reloaded.get("src/stable.ts"));
  assert.equal(await reloaded.get("src/new-a.ts"), null);
  assert.equal(await reloaded.get("src/new-b.ts"), null);
});

test("one invalid item rejects the whole batch without changing the cache", async () => {
  const store = await observedStore();
  const cache = new ContextCache(store, () => BASE_TIME);
  await cache.set(summary("src/stable.ts", "stable"));
  const rewritesBefore = store.rewriteCount;

  await assert.rejects(
    cache.setMany([
      summary("src/would-have-been-valid.ts", "valid"),
      { ...summary("src/invalid.ts", "invalid"), estimatedTokens: Number.NaN },
    ]),
    /Invalid cache summary/,
  );

  assert.equal(store.rewriteCount, rewritesBefore, "validation failure cannot partially commit");
  assert.ok(await cache.get("src/stable.ts"));
  assert.equal(await cache.get("src/would-have-been-valid.ts"), null);
});
