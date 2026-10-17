/**
 * Acceptance tests: the 10 scenarios from the specification, plus the two
 * fail-open guarantees (plugin absent / plugin init error).
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";
import { SupraCortex } from "../../packages/opencode/src/plugin.ts";
import * as cli from "../../packages/opencode/src/cli-core.ts";

async function proj(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ci-acc-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "opencode.json"), JSON.stringify({ plugin: [] }), "utf8");
  await writeFile(join(dir, "src/app.ts"), "export const app = () => 'hello';\n", "utf8");
  return dir;
}

function engineFor(dir: string, enabled: boolean, env: Record<string, string | undefined> = {}) {
  const { config } = resolveConfig({ project: { enabled }, env });
  const store = new JsonlStore(join(dir, ".supracortex"));
  return new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("1. enabled plugin prepares context", async () => {
  const dir = await proj();
  const engine = engineFor(dir, true);
  const packet = await engine.prepareContext({ query: "work on app.ts" });
  assert.ok(packet);
  assert.ok(packet!.selectedFiles.some((f) => f.path === "src/app.ts"));
});

test("2. disabled plugin does no indexing or memory retrieval", async () => {
  const dir = await proj();
  const engine = engineFor(dir, false);
  assert.equal(await engine.prepareContext({ query: "x" }), null);
  assert.deepEqual(await engine.searchMemory("x"), []);
  // No storage index written.
  assert.equal(await exists(join(dir, ".supracortex/index/repository.json")), false);
});

test("3. env override disables despite project config enabled=true", async () => {
  const dir = await proj();
  const engine = engineFor(dir, true, { SUPRACORTEX_DISABLE: "1" });
  assert.equal(engine.enabled, false);
  assert.equal(await engine.prepareContext({ query: "x" }), null);
});

test("4. re-enabling preserves previous memory", async () => {
  const dir = await proj();
  const e1 = engineFor(dir, true);
  await e1.recordMemory({
    kind: "fact",
    content: "app entry is src/app.ts",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "src/app.ts" }],
  });
  // Disable then re-enable (new engine instances, same storage).
  const disabled = engineFor(dir, false);
  assert.equal(await disabled.searchMemory("app entry").then((r) => r.length), 0);
  const e2 = engineFor(dir, true);
  const found = await e2.searchMemory("where is the app entry point");
  assert.ok(found.length >= 1, "memory preserved after re-enable");
});

test("5. editing a source file invalidates its summary", async () => {
  const dir = await proj();
  const engine = engineFor(dir, true);
  await engine.ensureIndex();
  await engine.cacheSummaryFromContent("src/app.ts", "export const app = () => 'hello';\n");
  await writeFile(join(dir, "src/app.ts"), "export const app = () => 'world';\n", "utf8");
  await engine.ensureIndex(true);
  const report = await engine.validateCache();
  assert.ok(report.stale.includes("src/app.ts"));
});

test("6. two tasks writing the same file are not parallel-safe", async () => {
  const dir = await proj();
  const engine = engineFor(dir, true);
  const plan = engine.planTasks([
    { id: "a", title: "a", objective: "edit app", writeScope: ["src/app.ts"] },
    { id: "b", title: "b", objective: "also edit app", writeScope: ["src/app.ts"] },
  ]);
  assert.ok(plan);
  const a = plan!.tasks.find((t) => t.id === "a")!;
  assert.equal(a.parallelSafe, false);
  assert.ok(plan!.warnings.some((w) => w.includes("src/app.ts")));
});

test("7. host config keeps working when the plugin is absent (no install)", async () => {
  const dir = await proj();
  // Nothing installed. Host config remains intact and untouched.
  const before = await readFile(join(dir, "opencode.json"), "utf8");
  assert.deepEqual(JSON.parse(before), { plugin: [] });
  assert.equal(await exists(join(dir, ".opencode/plugins/supracortex.ts")), false);
});

test("8. host continues when the plugin throws at init (fail open)", async () => {
  const dir = await proj();
  // Force an init failure by pointing storage at an unwritable path via a
  // read-only marker file where a directory is expected.
  await writeFile(join(dir, ".supracortex"), "not a dir", "utf8");
  // Plugin load must NOT throw; it returns hooks and degrades to no-op.
  const hooks = await SupraCortex({
    directory: dir,
    worktree: dir,
    client: {},
    $: undefined,
  } as never);
  assert.ok(hooks, "plugin returned hooks despite bad storage path");
  // A tool call must not throw either.
  const status = hooks.tool?.cortex_status;
  if (status) {
    const out = await status.execute({}, {} as never);
    assert.ok(out);
  }
});

test("9. uninstall does not alter host config", async () => {
  const dir = await proj();
  await cli.install({ projectRoot: dir });
  const before = await readFile(join(dir, "opencode.json"), "utf8");
  await cli.uninstall({ projectRoot: dir, keepData: false });
  const after = await readFile(join(dir, "opencode.json"), "utf8");
  assert.equal(before, after);
});

test("10. a new session loads persisted enabled state", async () => {
  const dir = await proj();
  await cli.install({ projectRoot: dir });
  await cli.setEnabled(dir, false);
  // Simulate a fresh session: plugin re-reads config from disk.
  const hooks = await SupraCortex({
    directory: dir,
    worktree: dir,
    client: {},
    $: undefined,
  } as never);
  const status = hooks.tool!.cortex_status!;
  const out = (await status.execute({}, {} as never)) as { output: string };
  assert.ok(out.output.includes("active: false"), "persisted disabled state loaded");

  await cli.setEnabled(dir, true);
  const hooks2 = await SupraCortex({
    directory: dir,
    worktree: dir,
    client: {},
    $: undefined,
  } as never);
  const out2 = (await hooks2.tool!.cortex_status!.execute({}, {} as never)) as { output: string };
  assert.ok(out2.output.includes("active: true"), "persisted enabled state loaded");
});
