/**
 * Provider switching must be a one-place change.
 *
 * Regression: `setEnabled` on a fresh project used to spread DEFAULT_CONFIG
 * into the new project file, freezing `jev.provider: "jev"` there and silently
 * overriding whatever provider the global config selected.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readEnvAssignment,
  resolveConfig,
  resolveCredential,
  resolveDecisionProvider,
  type PartialConfig,
} from "../../packages/core/src/index.ts";
import { setCodeGraphEnabled, setEnabled } from "../../packages/opencode/src/cli-core.ts";
import { stripJsonc } from "../../packages/opencode/src/config-loader.ts";

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sc-provider-"));
}

async function projectFile(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(stripJsonc(await readFile(join(root, ".supracortex", "config.jsonc"), "utf8")));
}

const GLOBAL_LAYA: PartialConfig = { enabled: true, mode: "balanced", jev: { provider: "laya-local" } };

test("setEnabled writes nothing for an enabled project (settings are central)", async () => {
  const root = await fresh();
  try {
    await setEnabled(root, true);
    await assert.rejects(readFile(join(root, ".supracortex", "config.jsonc"), "utf8"), "no project config written");
    const effective = resolveConfig({ global: GLOBAL_LAYA, env: {} }).config;
    assert.equal(resolveDecisionProvider(effective.jev).id, "laya-local");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setEnabled(false) writes only the project kill switch", async () => {
  const root = await fresh();
  try {
    await setEnabled(root, false);
    assert.deepEqual(await projectFile(root), { enabled: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setCodeGraphEnabled edits the central config, never the project", async () => {
  const root = await fresh();
  try {
    await setCodeGraphEnabled(root, false);
    await assert.rejects(readFile(join(root, ".supracortex", "config.jsonc"), "utf8"));
    const { globalConfigPath } = await import("../../packages/opencode/src/config-loader.ts");
    const central = JSON.parse(stripJsonc(await readFile(globalConfigPath(), "utf8"))) as { graph?: { enabled?: boolean } };
    assert.equal(central.graph?.enabled, false);
    await setCodeGraphEnabled(root, true);
    const after = JSON.parse(stripJsonc(await readFile(globalConfigPath(), "utf8"))) as { graph?: { enabled?: boolean; automaticContext?: boolean } };
    assert.equal(after.graph?.enabled, true, "re-enabling writes an explicit true");
    assert.equal(after.graph?.automaticContext, true, "automatic context follows the flag");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("switching the global provider switches every inheriting project", () => {
  const project = {} as PartialConfig;
  for (const provider of ["jev", "laya-local"] as const) {
    const cfg = resolveConfig({ global: { jev: { provider } }, project, env: {} }).config;
    const resolved = resolveDecisionProvider(cfg.jev);
    assert.equal(resolved.id, provider);
    assert.equal(resolved.model, provider === "jev" ? "typesafe/jev-1.13" : "convaiinnovations/laya");
  }
});

test("stale feature keys in a project file are ignored; re-enable keeps only project-scoped keys", async () => {
  const root = await fresh();
  try {
    await mkdir(join(root, ".supracortex"), { recursive: true });
    await writeFile(
      join(root, ".supracortex", "config.jsonc"),
      JSON.stringify({ enabled: false, storage: { driver: "sqlite" }, graph: { enabled: false }, jev: { provider: "custom", endpoint: "https://x/v1" } }),
    );
    const { projectScopedConfig } = await import("../../packages/core/src/config.ts");
    const scoped = projectScopedConfig(await projectFile(root));
    assert.deepEqual(scoped.config, { enabled: false, storage: { driver: "sqlite" } });
    assert.deepEqual(scoped.ignored.sort(), ["graph.enabled", "jev.endpoint", "jev.provider"]);
    const r = await setEnabled(root, true);
    const written = await projectFile(root);
    assert.equal("enabled" in written, false, "kill switch cleared");
    assert.deepEqual((written as { storage?: unknown }).storage, { driver: "sqlite" }, "store identity preserved");
    assert.ok(r.notes.some((n) => n.includes("config migrate")), "user told how to clean the stale keys");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readEnvAssignment parses without executing", () => {
  const text = [
    "# comment",
    "OTHER=1",
    "export OPENROUTER_API_KEY=\"sk-quoted\"",
    "LAYA_API_KEY='single' ",
    "PLAIN=value # trailing comment",
    "EVIL=$(rm -rf /)",
  ].join("\n");
  assert.equal(readEnvAssignment(text, "OPENROUTER_API_KEY"), "sk-quoted");
  assert.equal(readEnvAssignment(text, "LAYA_API_KEY"), "single");
  assert.equal(readEnvAssignment(text, "PLAIN"), "value");
  assert.equal(readEnvAssignment(text, "EVIL"), "$(rm -rf /)");
  assert.equal(readEnvAssignment(text, "MISSING"), undefined);
  assert.equal(readEnvAssignment(text, "bad name"), undefined);
});

test("resolveCredential: env, then configured file, then user dir, then system files", async () => {
  const dir = await fresh();
  try {
    const userDir = join(dir, "user");
    await mkdir(userDir);
    await writeFile(join(userDir, "openrouter.env"), "export TEST_KEY=from-user-dir\n");
    const configured = join(dir, "configured.env");
    await writeFile(configured, "TEST_KEY=from-configured\n");
    const system = join(dir, "system.env");
    await writeFile(system, "TEST_KEY=from-system\nSYS_ONLY=sys\n");
    const base = { userDir, systemFiles: [system], opencodeAuth: "" };

    assert.deepEqual(resolveCredential("TEST_KEY", { ...base, env: { TEST_KEY: "from-env" } }), { value: "from-env", source: "env" });
    assert.equal(resolveCredential("TEST_KEY", { ...base, env: {}, credentialsFile: configured })?.value, "from-configured");
    assert.equal(resolveCredential("TEST_KEY", { ...base, env: {} })?.value, "from-user-dir");
    assert.equal(resolveCredential("SYS_ONLY", { ...base, env: {} })?.value, "sys");
    assert.equal(resolveCredential("NOPE", { ...base, env: {} }), null);
    assert.equal(resolveCredential("", { ...base, env: {} }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
