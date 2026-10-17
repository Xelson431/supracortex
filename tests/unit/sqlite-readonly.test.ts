/**
 * Read-only SQLite is the diagnostics path: opening it must never create the
 * storage root, database, WAL sidecars, or schema. It must still read the data
 * a normal store wrote.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteStore, resolveConfig } from "../../packages/core/src/index.ts";
import { createReadOnlyStore } from "../../packages/opencode/src/lifecycle.ts";

function sqliteUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sqlite/i.test(message) && /(runtime|node:sqlite|bun:sqlite)/i.test(message);
}

async function listing(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = join(prefix, entry.name);
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) out.push(...(await listing(root, rel)));
  }
  return out.sort();
}

test("read-only SQLite reads data without adding files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sc-sqlite-ro-"));
  let store: Awaited<ReturnType<typeof createSqliteStore>>;
  try {
    store = await createSqliteStore(root);
  } catch (error) {
    if (sqliteUnavailable(error)) {
      t.skip(`SQLite runtime unavailable: ${(error as Error).message}`);
      return;
    }
    throw error;
  }

  try {
    await store.writeJson("state/doc.json", { hello: "world" });
    await store.appendJsonl("events/events.jsonl", [{ kind: "a" }, { kind: "b" }]);
  } finally {
    await store.close();
  }

  const before = await listing(root);

  const readonly = await createSqliteStore(root, { readOnly: true });
  try {
    assert.deepEqual(await readonly.readJson("state/doc.json"), { hello: "world" });
    const events = await readonly.readJsonl<{ kind: string }>("events/events.jsonl");
    assert.deepEqual(events.entries.map((entry) => entry.kind), ["a", "b"]);
  } finally {
    await readonly.close();
  }

  assert.deepEqual(await listing(root), before, "read-only open added no files");
});

test("read-only SQLite open of a missing database throws ENOENT", async () => {
  const root = mkdtempSync(join(tmpdir(), "sc-sqlite-ro-missing-"));
  await assert.rejects(
    createSqliteStore(root, { readOnly: true }),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("createReadOnlyStore returns null and creates nothing for an absent JSONL root", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-readonly-store-"));
  const { config } = resolveConfig({
    project: { enabled: true, graph: { enabled: false }, supraspace: { enabled: false } },
  });

  const store = await createReadOnlyStore(config, projectRoot);
  assert.equal(store, null);
  await assert.rejects(
    lstat(join(projectRoot, ".supracortex")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "diagnostics must not create the storage root",
  );
  assert.equal((await stat(projectRoot)).isDirectory(), true);
});
