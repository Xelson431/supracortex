/**
 * Shared layer: SupraCode shares stock MCP servers, providers and skills LIVE
 * and never stock plugins, agents or commands. The profile wins
 * on name conflicts.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { profilePaths, supracodeEnv } from "../../packages/opencode/src/profile.ts";
import { buildSharedLayer, sharedPaths } from "../../packages/opencode/src/shared.ts";

async function home(): Promise<{ home: string; paths: ReturnType<typeof profilePaths> }> {
  const h = await mkdtemp(join(tmpdir(), "sc-shared-"));
  const paths = profilePaths({ HOME: h });
  await mkdir(paths.stockConfig, { recursive: true });
  await mkdir(paths.opencodeConfig, { recursive: true });
  return { home: h, paths };
}

async function skill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
}

test("shares stock mcp/provider/skills; never plugin/agent/command/excluded skills", async () => {
  const { home: h, paths } = await home();
  try {
    await writeFile(join(paths.stockConfig, "opencode.json"), JSON.stringify({
      plugin: ["some-plugin"],
      agent: { orchestrator: { model: "x" } },
      command: { hi: { template: "hi" } },
      permission: { "*": "allow" },
      mcp: { context7: { type: "local", command: ["npx", "c7"] }, supracortex: { type: "local", command: ["x"] } },
      provider: { omniroute: { npm: "@ai-sdk/openai-compatible" } },
    }));
    await skill(join(paths.stockConfig, "skills"), "deepwork");
    await skill(join(paths.stockConfig, "skills"), "supracortex");
    const r = buildSharedLayer(paths);
    const cfg = JSON.parse(readFileSync(r.configFile, "utf8"));
    assert.deepEqual(Object.keys(cfg.mcp), ["context7"], "supracortex MCP excluded (native in SupraCode)");
    assert.deepEqual(Object.keys(cfg.provider), ["omniroute"]);
    for (const k of ["plugin", "agent", "command", "permission"]) assert.equal(k in cfg, false, `${k} never shared`);
    assert.deepEqual(r.skills, ["deepwork"]);
    assert.ok(r.excluded.includes("skill:supracortex"));
    const sp = sharedPaths(paths);
    assert.deepEqual(cfg.skills.paths, [sp.skillsDir]);
    assert.equal(readlinkSync(join(sp.skillsDir, "deepwork")), join(paths.stockConfig, "skills", "deepwork"));
    assert.equal(existsSync(join(sp.skillsDir, "supracortex")), false);
    assert.equal((statSync(r.configFile).mode & 0o777).toString(8), "600", "may contain provider keys");
  } finally {
    await rm(h, { recursive: true, force: true });
  }
});

test("profile wins: names the profile defines are left out of the shared layer", async () => {
  const { home: h, paths } = await home();
  try {
    await writeFile(join(paths.stockConfig, "opencode.json"), JSON.stringify({ mcp: { a: { type: "local", command: ["a"] }, b: { type: "local", command: ["b"] } } }));
    await writeFile(join(paths.opencodeConfig, "opencode.json"), JSON.stringify({ mcp: { b: { type: "local", command: ["mine"] } } }));
    const r = buildSharedLayer(paths);
    assert.deepEqual(r.mcp, ["a"]);
    assert.deepEqual(r.shadowedByProfile, ["mcp:b"]);
  } finally {
    await rm(h, { recursive: true, force: true });
  }
});

test("live: removing a stock skill/MCP removes it on the next launch", async () => {
  const { home: h, paths } = await home();
  try {
    await writeFile(join(paths.stockConfig, "opencode.json"), JSON.stringify({ mcp: { a: { type: "local", command: ["a"] } } }));
    await skill(join(paths.stockConfig, "skills"), "s1");
    buildSharedLayer(paths);
    await writeFile(join(paths.stockConfig, "opencode.json"), JSON.stringify({}));
    await rm(join(paths.stockConfig, "skills", "s1"), { recursive: true });
    const r = buildSharedLayer(paths);
    assert.deepEqual(r.mcp, []);
    assert.deepEqual(r.skills, []);
    assert.equal(existsSync(join(sharedPaths(paths).skillsDir, "s1")), false, "stale link removed");
  } finally {
    await rm(h, { recursive: true, force: true });
  }
});

test("broken stock config degrades to nothing shared, never blocks launch", async () => {
  const { home: h, paths } = await home();
  try {
    await writeFile(join(paths.stockConfig, "opencode.json"), "{ not json");
    const r = buildSharedLayer(paths);
    assert.equal(r.mcp.length, 0);
    assert.ok(r.warnings.some((w) => /not shared/.test(w)));
    assert.ok(existsSync(r.configFile));
  } finally {
    await rm(h, { recursive: true, force: true });
  }
});

test("env: user OPENCODE_CONFIG is stripped; only the generated shared layer is injected", () => {
  const paths = profilePaths({ HOME: "/h" });
  const env = supracodeEnv({ HOME: "/h", OPENCODE_CONFIG: "/user/opencode.json" }, paths, "/state/shared.opencode.json");
  assert.equal(env.OPENCODE_CONFIG, "/state/shared.opencode.json");
  assert.equal(supracodeEnv({ HOME: "/h", OPENCODE_CONFIG: "/user/opencode.json" }, paths).OPENCODE_CONFIG, undefined);
});
