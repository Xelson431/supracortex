import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteStore, migrateJsonlToSqlite } from "../../packages/core/src/index.ts";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sc-migrate-"));
  mkdirSync(join(dir, "events"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "cli", "logs"), { recursive: true });
  mkdirSync(join(dir, "active-tasks.lock"), { recursive: true });
  writeFileSync(join(dir, "state", "version.json"), JSON.stringify({ version: 3 }));
  writeFileSync(
    join(dir, "events", "events.jsonl"),
    ['{"kind":"a"}', '{"kind":"b"}', "not-json", '{"kind":"c"}'].join("\n") + "\n",
  );
  // Non-JSON files and lock metadata must be ignored.
  writeFileSync(join(dir, "cli", "logs", "run.log"), "plain text\n");
  writeFileSync(join(dir, "active-tasks.lock", "owner.json"), JSON.stringify({ pid: 1 }));
  writeFileSync(join(dir, "config.jsonc"), "// owned config\n{}");
  return dir;
}

test("migrate copies json + jsonl, counts corrupt lines, ignores locks/logs", async () => {
  const dir = fixture();
  const dry = await migrateJsonlToSqlite(dir, { dryRun: true });
  assert.deepEqual(dry.filesCopied.sort(), ["events/events.jsonl", "state/version.json"]);
  assert.equal(dry.corruptLines, 1);
  assert.equal(dry.jsonCopied, 0);

  const first = await migrateJsonlToSqlite(dir);
  assert.equal(first.jsonCopied, 1);
  assert.equal(first.jsonlEntriesCopied, 3);
  assert.equal(first.corruptLines, 1);
  assert.deepEqual(first.skipped, []);

  const store = await createSqliteStore(dir);
  try {
    assert.deepEqual(await store.readJson("state/version.json"), { version: 3 });
    const events = await store.readJsonl<{ kind: string }>("events/events.jsonl");
    assert.deepEqual(events.entries.map((e) => e.kind), ["a", "b", "c"]);
    assert.equal(await store.readJson("cli/logs/run.log"), null);
    assert.equal(await store.readJson("active-tasks.lock/owner.json"), null);
  } finally {
    await store.close();
  }

  // Second run is idempotent: everything already present is skipped.
  const second = await migrateJsonlToSqlite(dir);
  assert.equal(second.jsonCopied, 0);
  assert.equal(second.jsonlEntriesCopied, 0);
  assert.deepEqual(second.skipped.sort(), ["events/events.jsonl", "state/version.json"]);

  // Post-flip SQLite writes merge with (not clobbered by) older file rows.
  const later = await createSqliteStore(dir);
  try {
    await later.appendJsonl("events/events.jsonl", [{ kind: "d" }]);
  } finally {
    await later.close();
  }
  const third = await migrateJsonlToSqlite(dir);
  assert.equal(third.jsonlEntriesCopied, 0);
  assert.deepEqual(third.skipped.sort(), ["events/events.jsonl", "state/version.json"]);

  const verify = await createSqliteStore(dir);
  try {
    const events = await verify.readJsonl<{ kind: string }>("events/events.jsonl");
    assert.deepEqual(events.entries.map((e) => e.kind), ["a", "b", "c", "d"]);
  } finally {
    await verify.close();
  }
});

test("migrate merges older file rows ahead of post-flip sqlite writes", async () => {
  const dir = fixture();
  const pre = await createSqliteStore(dir);
  try {
    await pre.appendJsonl("events/events.jsonl", [{ kind: "new" }]);
  } finally {
    await pre.close();
  }
  const result = await migrateJsonlToSqlite(dir);
  assert.equal(result.jsonlEntriesCopied, 3);
  const store = await createSqliteStore(dir);
  try {
    const events = await store.readJsonl<{ kind: string }>("events/events.jsonl");
    assert.deepEqual(events.entries.map((e) => e.kind), ["a", "b", "c", "new"]);
  } finally {
    await store.close();
  }
});
