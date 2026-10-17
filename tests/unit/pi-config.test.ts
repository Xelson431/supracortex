/**
 * P02: CLI config precedence/validation, model resolution, agent frontmatter.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgents, loadAgentDir, parseAgentDefinition } from "../../packages/pi/src/agents.ts";
import {
  mergeCliConfig,
  parseCliConfig,
  resolveContextCaps,
  resolveJobLimits,
  resolveMainModel,
} from "../../packages/pi/src/config.ts";
import { parseModelToken, resolveRoleModel } from "../../packages/pi/src/models.ts";

test("config rejects unknown keys and out-of-range values", () => {
  assert.throws(() => parseCliConfig('{"schemaVersion":1,"bogus":true}', "cli.jsonc"), /bogus/);
  assert.throws(() => parseCliConfig('{"schemaVersion":1,"jobs":{"maxRunning":99}}', "p"), /maxRunning/);
  assert.throws(() => parseCliConfig('{"schemaVersion":2}', "p"), /schemaVersion/);
  // jsonc-parser is error-tolerant (never throws): malformed input surfaces as a schema error.
  assert.throws(() => parseCliConfig("{oops", "p"), /invalid key/);
  const ok = parseCliConfig('{"schemaVersion":1, // comment\n"jobs":{"maxRunning":3}}', "p");
  assert.equal(ok.jobs?.maxRunning, 3);
});

test("main model precedence: invocation > project > user > undefined", () => {
  const user = { schemaVersion: 1 as const, mainModel: { provider: "u", id: "um" } };
  const project = { schemaVersion: 1 as const, mainModel: { provider: "p", id: "pm" } };
  assert.deepEqual(resolveMainModel({ invocation: { provider: "i", id: "im" }, project, user }), { provider: "i", id: "im" });
  assert.deepEqual(resolveMainModel({ project, user }), { provider: "p", id: "pm" });
  assert.deepEqual(resolveMainModel({ user }), { provider: "u", id: "um" });
  assert.equal(resolveMainModel({}), undefined);
});

test("merge keeps defined nested values; limits fall back to defaults", () => {
  const merged = mergeCliConfig(
    { schemaVersion: 1, jobs: { maxRunning: 3 } },
    { schemaVersion: 1, roleModels: { explorer: { provider: "a", id: "b" } } },
  );
  assert.equal(merged.jobs?.maxRunning, 3);
  assert.deepEqual(merged.roleModels?.["explorer"], { provider: "a", id: "b" });
  const limits = resolveJobLimits(null);
  assert.deepEqual(limits, { maxRunning: 2, maxQueued: 8, timeoutMs: 300000 });
  assert.deepEqual(resolveContextCaps(null), { mainMaxTokens: 4000, childMaxTokens: 2000 });
});

test("role model precedence: request > role > agent > main; throws when empty", () => {
  const main = { provider: "m", id: "mm" };
  const agent = { provider: "a", id: "am" };
  const roleModels = { explorer: { provider: "r", id: "rm" } };
  const request = { provider: "q", id: "qm" };
  assert.equal(resolveRoleModel({ role: "explorer", requestModel: request, roleModels, agentModel: agent, mainModel: main }).provenance, "request");
  assert.equal(resolveRoleModel({ role: "explorer", roleModels, agentModel: agent, mainModel: main }).provenance, "role");
  assert.equal(resolveRoleModel({ role: "other", roleModels, agentModel: agent, mainModel: main }).provenance, "agent");
  assert.equal(resolveRoleModel({ role: "other", mainModel: main }).provenance, "main");
  assert.throws(() => resolveRoleModel({ role: "other" }), /No model configured/);
  assert.deepEqual(parseModelToken("anthropic/claude-opus-4-6"), { provider: "anthropic", id: "claude-opus-4-6" });
  assert.throws(() => parseModelToken("noprovider"), /provider\/id/);
});

const GOOD = `---\nname: explorer\ndescription: Looks around.\ntools: [read, grep]\n---\nBody text.\n`;

test("agent frontmatter: valid, forbidden tools, atomic model pair, layering", () => {
  const def = parseAgentDefinition(GOOD, "explorer.md", "bundled");
  assert.equal(def.name, "explorer");
  assert.deepEqual(def.tools, ["read", "grep"]);
  assert.equal(def.body, "Body text.");
  assert.throws(() => parseAgentDefinition("no fences", "x.md", "bundled"), /frontmatter/);
  assert.throws(
    () => parseAgentDefinition("---\nname: bad NAME\ndescription: d\n---\n", "x.md", "bundled"),
    /frontmatter/,
  );
  assert.throws(
    () => parseAgentDefinition("---\nname: e\ndescription: d\ntools: [bash]\n---\n", "x.md", "bundled"),
    /forbidden/,
  );
  assert.throws(
    () => parseAgentDefinition("---\nname: e\ndescription: d\nmodel: m1\n---\n", "x.md", "bundled"),
    /atomic pair/,
  );
  const withModel = parseAgentDefinition(
    "---\nname: e\ndescription: d\nmodelProvider: p\nmodel: m\n---\n",
    "x.md",
    "bundled",
  );
  assert.deepEqual(withModel.model, { provider: "p", id: "m" });
});

test("agent discovery layers: project replaces bundled same-name", async () => {
  const bundled = mkdtempSync(join(tmpdir(), "agents-bundled-"));
  const project = mkdtempSync(join(tmpdir(), "agents-project-"));
  writeFileSync(join(bundled, "explorer.md"), GOOD);
  writeFileSync(join(project, "explorer.md"), GOOD.replace("Looks around.", "Project explorer."));
  const merged = await discoverAgents([
    { dir: bundled, layer: "bundled" },
    { dir: project, layer: "project" },
  ]);
  assert.equal(merged.size, 1);
  assert.equal(merged.get("explorer")?.layer, "project");
  assert.equal((await loadAgentDir(join(tmpdir(), "agents-missing-xyz"), "user")).length, 0);
});
