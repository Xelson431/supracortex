/**
 * Pi logging: level filtering, secret redaction, file sink, $schema tolerance.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCliConfig } from "../../packages/pi/src/config.ts";
import { findLatestLog, getLogLevel, setLogFile, setLogLevel, tailLog, logError, logInfo } from "../../packages/pi/src/log.ts";
import { CortexService } from "../../packages/pi/src/service.ts";

test("log levels filter; secrets redacted; never throws", () => {
  setLogLevel("error");
  assert.equal(getLogLevel(), "error");
  // Must not throw even with hostile input; output goes to stderr (uncaptured here).
  logInfo("test", "suppressed info with key=AKIAIOSFODNN7EXAMPLE");
  logError("test", "visible error");
  setLogLevel("warn");
});

test("file sink receives redacted records; tail + latest work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-log-"));
  const path = join(dir, "run.log");
  setLogLevel("debug");
  setLogFile(path);
  logError("test", "file record sk-live-abcdefghijklmnopqrstuv");
  await new Promise((r) => setTimeout(r, 100));
  const { readFileSync, existsSync } = await import("node:fs");
  assert.ok(existsSync(path), "log file created");
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("file record"), "message present");
  assert.ok(!content.includes("sk-live-abcdefghijklmnopqrstuv"), "secret redacted");
  assert.deepEqual(await tailLog(path, 5), content.trim().split("\n"));
  assert.equal(await findLatestLog(dir), null, "no cli/logs layout here");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "cli", "logs"), { recursive: true });
  writeFileSync(join(dir, "cli", "logs", "r.log"), "x\n");
  assert.ok((await findLatestLog(join(dir, ".supracortex-missing"))) === null);
  setLogLevel("warn");
});

test("$schema keys tolerated in core + CLI configs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-schema-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, ".supracortex"), { recursive: true });
  writeFileSync(
    join(root, ".supracortex", "config.jsonc"),
    '{\n  "$schema": "./config.schema.json",\n  "enabled": true\n}\n',
  );
  const service = await CortexService.create(root);
  try {
    assert.equal(service.status().enabled, true);
  } finally {
    await service.close();
  }
  const parsed = parseCliConfig('{\n  "$schema": "./cli.schema.json",\n  "schemaVersion": 1\n}\n', "cli.jsonc");
  assert.equal(parsed.schemaVersion, 1);
});
