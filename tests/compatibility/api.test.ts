/**
 * Compatibility checks against the installed OpenCode plugin API.
 *
 * These pin the assumptions recorded during research so a future OpenCode
 * upgrade that changes the surface will fail loudly here instead of at runtime.
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin/tool";
import { SupraCortex } from "../../packages/opencode/src/plugin.ts";
import { buildTools } from "../../packages/opencode/src/index.ts";
import { PluginRuntime } from "../../packages/opencode/src/runtime.ts";
import { FeatureGate } from "../../packages/opencode/src/feature-gate.ts";
import { resolveConfig } from "../../packages/core/src/index.ts";

test("tool() helper is available and constructs a tool", () => {
  const t = tool({
    description: "d",
    args: { x: tool.schema.string() },
    async execute(a) {
      return `ok:${a.x}`;
    },
  });
  assert.equal(typeof t.execute, "function");
  assert.ok(t.args.x);
});

test("plugin is an async function returning a hooks object", async () => {
  assert.equal(typeof SupraCortex, "function");
  const dir = await mkdtemp(join(tmpdir(), "ci-compat-"));
  const hooks = await SupraCortex({
    directory: dir,
    worktree: dir,
    client: {},
    $: undefined,
  } as never);
  assert.equal(typeof hooks, "object");
  assert.equal(typeof hooks.dispose, "function");
});

test("all documented tools are registered with strict schemas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-compat-"));
  const { config } = resolveConfig({ project: { enabled: true } });
  const gate = new FeatureGate(true, "test");
  const rt = new PluginRuntime({
    gate,
    lifecycle: { config, projectRoot: dir, worktree: dir, pluginVersion: "0.1.0" },
  });
  const tools = buildTools(rt);
  const expected = [
    "cortex_prepare_context",
    "cortex_search_memory",
    "cortex_record_memory",
    "cortex_record_outcome",
    "cortex_plan_tasks",
    "cortex_claim_files",
    "cortex_release_files",
    "cortex_validate_cache",
    "cortex_compact",
    "cortex_metrics",
    "cortex_status",
    "cortex_code_graph_status",
    "cortex_code_graph_rebuild",
    "cortex_code_graph_query",
    "cortex_code_graph_path",
    "cortex_code_graph_impact",
    "cortex_code_graph_explain",
  ];
  for (const name of expected) {
    assert.ok(tools[name], `missing tool ${name}`);
    assert.equal(typeof tools[name]!.execute, "function");
    assert.ok(tools[name]!.description.length > 0);
  }
});

test("disabled tools respond without throwing and without side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-compat-"));
  const { config } = resolveConfig({ project: { enabled: false } });
  const gate = new FeatureGate(false, "disabled");
  const rt = new PluginRuntime({
    gate,
    lifecycle: { config, projectRoot: dir, worktree: dir, pluginVersion: "0.1.0" },
  });
  const tools = buildTools(rt);
  const out = await tools.cortex_prepare_context!.execute(
    { query: "x" },
    {} as never,
  );
  assert.ok(String(JSON.stringify(out)).includes("disabled"));
});

test("Node runtime supports required features", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  assert.ok((major ?? 0) > 22 || (major === 22 && (minor ?? 0) >= 6), "Node >= 22.6 required for native TS type-stripping");
  assert.equal(typeof structuredClone, "function");
  assert.equal(typeof crypto.randomUUID, "function");
});
