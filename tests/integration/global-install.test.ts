/**
 * Global install enables SupraCortex everywhere with every feature on, from
 * one central config; a project can only opt OUT.
 * These tests write into a temp HOME to avoid touching the real ~/.config.
 *
 * Contract (isolated SupraCode profile):
 *   - SupraCortex machine config:      ~/.config/supracortex/config.jsonc
 *   - SupraCode's OpenCode assets:     ~/.config/supracode/opencode/{plugins,commands,skills,tui.json}
 *   - the user's stock ~/.config/opencode is never written.
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import * as cli from "../../packages/opencode/src/cli-core.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("global install writes an enabled central config + loader, no project dir", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ci-home-"));
  const projectCwd = await mkdtemp(join(tmpdir(), "ci-proj-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const r = await cli.install({ projectRoot: projectCwd, global: true });
    const globCfg = join(fakeHome, ".config", "supracortex", "config.jsonc");
    const loader = join(fakeHome, ".config", "supracode", "opencode", "plugins", "supracortex.ts");
    const skill = join(fakeHome, ".config", "supracode", "opencode", "skills", "supracortex", "SKILL.md");
    assert.ok(await exists(globCfg), "global config created");
    assert.ok(await exists(loader), "global loader created");
    assert.ok(await exists(skill), "global OpenCode skill created");
    assert.match(await readFile(skill, "utf8"), /cortex_context/);

    const cfg = await readFile(globCfg, "utf8");
    assert.ok(/"enabled":\s*true/.test(cfg), "central config enabled by default");
    assert.ok(/"mode":\s*"balanced"/.test(cfg), "central mode balanced (all features on)");
    assert.doesNotMatch(cfg, /:\s*false/, "central config switches nothing off");

    // No project runtime dir created by a global install.
    assert.equal(await exists(join(projectCwd, ".supracortex")), false);
    assert.ok(r.notes.some((n) => n.includes("ENABLED in every project")));
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("every project is active after global install; opt-out is per project and reversible", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ci-home-"));
  const project = await mkdtemp(join(tmpdir(), "ci-proj-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await cli.install({ projectRoot: project, global: true });
    let s = await cli.status(project);
    assert.equal(s.active, true, "active with no project file at all");
    await cli.setEnabled(project, false);
    assert.equal(JSON.parse(await readFile(join(project, ".supracortex", "config.jsonc"), "utf8").then((t) => t.replace(/^\s*\/\/.*$/gm, ""))).enabled, false);
    s = await cli.status(project);
    assert.equal(s.active, false, "project kill switch wins");
    await cli.setEnabled(project, true);
    assert.equal(await exists(join(project, ".supracortex", "config.jsonc")), false, "re-enable removes the override file");
    s = await cli.status(project);
    assert.equal(s.active, true);
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("global reinstall turns a legacy disabled central config back on, keeping user keys", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ci-home-"));
  const project = await mkdtemp(join(tmpdir(), "ci-proj-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const cfg = join(fakeHome, ".config", "supracortex", "config.jsonc");
    await mkdir(join(fakeHome, ".config", "supracortex"), { recursive: true });
    await writeFile(cfg, '// mine\n{ "enabled": false, "mode": "off", "jev": { "provider": "laya-local" } }\n', "utf8");
    const r = await cli.install({ projectRoot: project, global: true });
    const text = await readFile(cfg, "utf8");
    assert.match(text, /\/\/ mine/, "comments preserved");
    assert.match(text, /"enabled": true/);
    assert.match(text, /"mode": "balanced"/);
    assert.match(text, /"provider": "laya-local"/, "user provider choice kept");
    assert.ok(r.backups.length >= 1, "backup written before editing");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("global uninstall reverts the Claude Code user-scope MCP registration", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ci-home-"));
  const projectCwd = await mkdtemp(join(tmpdir(), "ci-proj-"));
  const realHome = process.env.HOME;
  const realBin = process.env.SUPRACODE_CLAUDE_BIN;
  process.env.HOME = fakeHome;
  // Force the JSON fallback so the test never touches a real `claude` CLI.
  process.env.SUPRACODE_CLAUDE_BIN = join(fakeHome, "missing-claude");
  try {
    const { connect } = await import("../../packages/opencode/src/connect.ts");
    // Establish the global profile that uninstall expects to unwind.
    await cli.install({ projectRoot: projectCwd, global: true });
    // Seed an unrelated key to prove uninstall preserves it.
    const claudeJson = join(fakeHome, ".claude.json");
    await writeFile(claudeJson, JSON.stringify({ theme: "dark" }), "utf8");
    const on = await connect("claude");
    assert.equal(on.action, "connected");
    let data = JSON.parse(await readFile(claudeJson, "utf8"));
    assert.ok(data.mcpServers.supracortex, "registered by connect");

    const r = await cli.uninstall({ projectRoot: projectCwd, keepData: true, global: true });
    data = JSON.parse(await readFile(claudeJson, "utf8"));
    assert.equal("supracortex" in data.mcpServers, false, "Claude user-scope entry removed by uninstall");
    assert.equal(data.theme, "dark", "other keys preserved");
    assert.ok(r.edited.includes(claudeJson), "uninstall reports the edited Claude config");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realBin === undefined) delete process.env.SUPRACODE_CLAUDE_BIN;
    else process.env.SUPRACODE_CLAUDE_BIN = realBin;
  }
});

test("global reinstall refreshes owned loader and preserves the enabled setting", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ci-home-"));
  const project = await mkdtemp(join(tmpdir(), "ci-proj-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await cli.install({ projectRoot: project, global: true, enableByDefault: true });
    const loader = join(fakeHome, ".config", "supracode", "opencode", "plugins", "supracortex.ts");
    await (await import("node:fs/promises")).writeFile(loader, "// supracortex:owned\nold loader\n", "utf8");
    const result = await cli.reinstall({ projectRoot: project, global: true, enableByDefault: true });
    assert.ok(result.edited.includes(loader), "owned global loader refreshed");
    const loaderText = await readFile(loader, "utf8");
    // The SupraCode profile is a V1 (OpenCode 1.x) config root; V2 has its
    // own dedicated root, so the loader no longer switches on generation.
    assert.match(loaderText, /export const SupraCortex = async/);
    assert.match(loaderText, /dist\/opencode\.js/);
    const cfg = await readFile(join(fakeHome, ".config", "supracortex", "config.jsonc"), "utf8");
    assert.match(cfg, /"enabled": true/);
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});
