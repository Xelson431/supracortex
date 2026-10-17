import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlStore,
  runMigrations,
  readVersion,
  STORAGE_SCHEMA_VERSION,
} from "../../packages/core/src/index.ts";

async function store(): Promise<JsonlStore> {
  return new JsonlStore(await mkdtemp(join(tmpdir(), "cortex-migrate-")));
}

test("fresh storage starts at the independent current storage schema", async () => {
  const s = await store();
  const result = await runMigrations(s, "test");
  assert.equal(result.from, STORAGE_SCHEMA_VERSION);
  assert.equal(result.to, STORAGE_SCHEMA_VERSION);
  assert.deepEqual(result.applied, []);
});

test("legacy storage migration is restartable, backed up, and records completion", async () => {
  const s = await store();
  const original = {
    schemaVersion: 1,
    pluginVersion: "old",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
  await s.writeJson("state/version.json", original);
  const first = await runMigrations(s, "new");
  assert.deepEqual(first.applied, [2, 3, 4, 5]);
  assert.equal((await readVersion(s))?.schemaVersion, STORAGE_SCHEMA_VERSION);
  assert.deepEqual(await s.readJson("state/version.pre-migration.json"), original);
  assert.equal((await s.readJson<{ status: string }>("state/migration.json"))?.status, "completed");

  const second = await runMigrations(s, "new");
  assert.deepEqual(second.applied, []);
});

test("future storage versions fail closed instead of being downgraded", async () => {
  const s = await store();
  await s.writeJson("state/version.json", {
    schemaVersion: STORAGE_SCHEMA_VERSION + 1,
    pluginVersion: "future",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(runMigrations(s, "current"), /newer than supported/);
  assert.equal((await readVersion(s))?.schemaVersion, STORAGE_SCHEMA_VERSION + 1);
});
