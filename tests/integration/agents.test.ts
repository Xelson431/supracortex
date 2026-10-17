import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { init, install, setCodeGraphEnabled, uninstallAgents } from "../../packages/opencode/src/cli-core.ts";
import { wireCodexGlobal, unwireCodexGlobal, agentGuidance } from "../../packages/opencode/src/agent-wiring.ts";
import { resolveConfig } from "../../packages/core/src/index.ts";
import { MCP_TOOL_NAMES } from "../../src/protocol.ts";

test("agent init is a no-write plan, then an idempotent reversible transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-agents-"));
  await writeFile(join(root, "CLAUDE.md"), "user instructions\n");
  const plan = await init(root, false);
  assert.ok(plan.changes.some((change) => change.agent === "claude"));
  await assert.rejects(stat(join(root, ".mcp.json")));

  const applied = await init(root, true);
  assert.ok(applied.changes.some((change) => change.agent === "claude"));
  const first = await readFile(join(root, ".mcp.json"), "utf8");
  await init(root, true);
  assert.equal(await readFile(join(root, ".mcp.json"), "utf8"), first);

  await uninstallAgents(root);
  await assert.rejects(stat(join(root, ".mcp.json")));
});

test("pi adapter wires standard mcpServers stdio JSON at .pi/mcp.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-pi-"));
  await mkdir(join(root, ".pi"), { recursive: true });

  const plan = await init(root, false);
  assert.ok(plan.changes.some((c) => c.agent === "pi"), "pi detected via .pi dir");

  await init(root, true, ["pi"]);
  const cfg = JSON.parse(await readFile(join(root, ".pi", "mcp.json"), "utf8"));
  assert.equal(cfg.mcpServers.supracortex.type, "stdio");
  assert.ok(Array.isArray(cfg.mcpServers.supracortex.args));
  assert.equal(cfg.mcpServers.supracortex.env.SUPRACORTEX_ROOT, root);

  await uninstallAgents(root);
  await assert.rejects(stat(join(root, ".pi", "mcp.json")));
});

test("code graph toggle edits the central config and preserves the user's other keys and comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-graph-toggle-"));
  const central = await mkdtemp(join(tmpdir(), "supracortex-graph-central-"));
  const prev = process.env.SUPRACODE_REAL_XDG_CONFIG_HOME;
  process.env.SUPRACODE_REAL_XDG_CONFIG_HOME = central;
  try {
    const cfgPath = join(central, "supracortex", "config.jsonc");
    await mkdir(join(central, "supracortex"), { recursive: true });
    await writeFile(cfgPath, `// user config\n${JSON.stringify({ enabled: true, graph: { maxNodes: 77 } }, null, 2)}\n`);
    const strip = (t: string) => JSON.parse(t.replace(/^\s*\/\/.*$/gm, ""));
    const disabled = await setCodeGraphEnabled(root, false);
    assert.equal(disabled.configPath, cfgPath, "writes the central file");
    assert.deepEqual(strip(await readFile(cfgPath, "utf8")).graph, { maxNodes: 77, enabled: false, automaticContext: false });
    await setCodeGraphEnabled(root, true);
    const text = await readFile(cfgPath, "utf8");
    assert.match(text, /\/\/ user config/, "comment preserved");
    assert.deepEqual(strip(text).graph, { maxNodes: 77, enabled: true, automaticContext: true }, "explicit enable overrides");
    await assert.rejects(stat(join(root, ".supracortex", "config.jsonc")), "project untouched");
  } finally {
    if (prev === undefined) delete process.env.SUPRACODE_REAL_XDG_CONFIG_HOME;
    else process.env.SUPRACODE_REAL_XDG_CONFIG_HOME = prev;
  }
});

test("generic custom target wires any mcpServers CLI, preserves keys, reverses cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-custom-"));
  const rel = join(".mytool", "mcp.json");
  await mkdir(join(root, ".mytool"), { recursive: true });
  await writeFile(join(root, rel), JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2) + "\n");

  await init(root, true, [], [{ name: "mytool", file: rel }]);
  const cfg = JSON.parse(await readFile(join(root, rel), "utf8"));
  assert.equal(cfg.mcpServers.supracortex.type, "stdio");
  assert.equal(cfg.mcpServers.other.command, "x", "preserves pre-existing server");

  await uninstallAgents(root);
  const after = JSON.parse(await readFile(join(root, rel), "utf8"));
  assert.equal(after.mcpServers.supracortex, undefined, "our key removed");
  assert.equal(after.mcpServers.other.command, "x", "user key survives uninstall");
});

test("bare-style custom target omits the type field", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-bare-"));
  await init(root, true, [], [{ name: "gem", file: "gem.json", style: "bare" }]);
  const cfg = JSON.parse(await readFile(join(root, "gem.json"), "utf8"));
  assert.equal(cfg.mcpServers.supracortex.type, undefined);
  assert.ok(cfg.mcpServers.supracortex.command, "still has command");
});

test("custom agent targets cannot escape the selected project root", async () => {
  const base = await mkdtemp(join(tmpdir(), "supracortex-custom-boundary-"));
  const root = join(base, "project");
  await mkdir(root);
  const outside = join(base, "outside.json");

  await assert.rejects(
    init(root, true, [], [{ name: "traversal", file: "../outside.json" }]),
    /escapes the selected project root/,
  );
  await assert.rejects(
    init(root, true, [], [{ name: "mixed-slash", file: "..\\outside.json" }]),
    /escapes the selected project root/,
  );
  await assert.rejects(
    init(root, true, [], [{ name: "absolute", file: outside }]),
    /must be relative to the selected project root/,
  );
  await assert.rejects(stat(outside), "no escaped target was written");
});

test("custom agent targets reject a symlinked path component", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "supracortex-custom-symlink-"));
  const root = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  try {
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "EPERM" || code === "EACCES") {
      t.skip("this platform does not permit fixture symlinks");
      return;
    }
    throw error;
  }

  await assert.rejects(
    init(root, true, [], [{ name: "linked", file: "linked/mcp.json" }]),
    /contains a symbolic link/,
  );
  await assert.rejects(stat(join(outside, "mcp.json")), "symlink target was not written");
});

test("custom agent targets reject hard-linked files", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "supracortex-custom-hardlink-"));
  const root = join(base, "project");
  const outside = join(base, "outside.json");
  const target = join(root, "mcp.json");
  await mkdir(root);
  await writeFile(outside, "{}\n");
  try {
    await link(outside, target);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "EPERM" || code === "EACCES" || code === "EXDEV") {
      t.skip("this platform does not permit fixture hard links");
      return;
    }
    throw error;
  }

  await assert.rejects(
    init(root, true, [], [{ name: "linked", file: "mcp.json" }]),
    /contains a hard-linked file/,
  );
  assert.equal(await readFile(outside, "utf8"), "{}\n", "hard-link peer was not modified");
});

test("uninstall fails closed when its manifest target escapes the project", async () => {
  const base = await mkdtemp(join(tmpdir(), "supracortex-manifest-boundary-"));
  const root = join(base, "project");
  await mkdir(root);
  await init(root, true, ["claude"]);
  const manifestPath = join(root, ".supracortex", "state", "install-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const outside = join(base, "outside.json");
  const outsideContent = JSON.stringify({ mcpServers: { supracortex: { userOwned: true } } }) + "\n";
  await writeFile(outside, outsideContent);
  manifest.entries[0].file = outside;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  await assert.rejects(uninstallAgents(root), /escapes the allowed root/);
  assert.equal(await readFile(outside, "utf8"), outsideContent, "outside file is untouched");
  await assert.doesNotReject(
    stat(join(root, ".mcp.json")),
    "valid project target is untouched after failed preflight",
  );
});

test("uninstall preserves an installed config after any user edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-manifest-user-edit-"));
  await init(root, true, ["claude"]);
  const target = join(root, ".mcp.json");
  const config = JSON.parse(await readFile(target, "utf8"));
  config.userSetting = { keep: true };
  const edited = JSON.stringify(config, null, 2) + "\n";
  await writeFile(target, edited);

  const report = await uninstallAgents(root);
  assert.equal(await readFile(target, "utf8"), edited, "user-edited host config is byte-for-byte preserved");
  assert.ok(report.notes.some((note) => note.includes("installed hash no longer matches")));
  await assert.doesNotReject(
    stat(report.manifest),
    "manifest remains so the unresolved owned entry is not forgotten",
  );
});

test("global Codex wiring is rootless and reverses cleanly", async () => {
  const home = await mkdtemp(join(tmpdir(), "supracortex-codexhome-"));
  const res = await wireCodexGlobal(home);
  assert.equal(res.created, true);
  const toml = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.ok(toml.includes("[mcp_servers.supracortex]"), "has server table");
  assert.ok(toml.includes('"mcp"'), "invokes mcp subcommand");
  assert.ok(!toml.includes("SUPRACORTEX_ROOT"), "no baked root for global install");

  // Idempotent: second wire is a no-op.
  const again = await wireCodexGlobal(home);
  assert.equal(again.created, false);

  const removed = await unwireCodexGlobal(home);
  assert.equal(removed, join(home, ".codex", "config.toml"));
  await assert.rejects(stat(join(home, ".codex", "config.toml")), "file gone when only our block");
});

test("global Codex wiring preserves a user's own config", async () => {
  const home = await mkdtemp(join(tmpdir(), "supracortex-codexuser-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  const userToml = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
  await writeFile(join(home, ".codex", "config.toml"), userToml);
  await wireCodexGlobal(home);
  await unwireCodexGlobal(home);
  const after = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.ok(after.includes('model = "gpt-5"'), "user model line survives");
  assert.ok(after.includes("[mcp_servers.other]"), "user server survives");
  assert.ok(!after.includes("supracortex"), "our block removed");
});

test("enable-by-default global config propagates to a project with no local config", () => {
  // Mirrors installGlobal's enableByDefault body.
  const global = { enabled: true, mode: "balanced" as const };
  const r = resolveConfig({ global, project: null });
  assert.equal(r.config.enabled, true);
  assert.equal(r.source, "global");

  // A project that opts out still wins.
  const optOut = resolveConfig({ global, project: { enabled: false } });
  assert.equal(optOut.config.enabled, false);
  assert.equal(optOut.source, "project");

  // Env kill switch overrides everything.
  const killed = resolveConfig({ global, project: null, env: { SUPRACORTEX_DISABLE: "1" } });
  assert.equal(killed.config.enabled, false);
});

const GUIDANCE_BEGIN = "<!-- supracortex:owned:begin -->";
const GUIDANCE_END = "<!-- supracortex:owned:end -->";

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("W1: wiring claude creates CLAUDE.md with the fenced guidance block", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w1-"));
  await init(root, true, ["claude"]);
  const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
  assert.ok(claude.includes(GUIDANCE_BEGIN), "has begin fence");
  assert.ok(claude.includes(GUIDANCE_END), "has end fence");
  assert.ok(claude.includes("cortex_context"), "has MCP guidance content");
  assert.equal(countOccurrences(claude, GUIDANCE_BEGIN), 1, "exactly one fenced block");
});

test("W2: wiring codex creates AGENTS.md with the fenced block", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w2-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  await init(root, true, ["codex"]);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.includes(GUIDANCE_BEGIN), "has begin fence");
  assert.ok(agents.includes(GUIDANCE_END), "has end fence");
  assert.equal(countOccurrences(agents, GUIDANCE_BEGIN), 1, "exactly one fenced block");
});

test("W3: wiring twice yields exactly ONE fenced block (no duplication)", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w3-"));
  await init(root, true, ["claude"]);
  await init(root, true, ["claude"]);
  const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
  assert.equal(countOccurrences(claude, GUIDANCE_BEGIN), 1, "still exactly one fenced block");
  assert.equal(countOccurrences(claude, "cortex_context"), 1, "guidance not duplicated");
});

test("W4: existing AGENTS.md keeps prior content byte-for-byte, block appended", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w4-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  const prior = "# Project Guide\n\nBuild with cargo.\n";
  await writeFile(join(root, "AGENTS.md"), prior, "utf8");
  await init(root, true, ["codex"]);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith(prior), "prior content preserved byte-for-byte at the start");
  assert.ok(agents.includes(GUIDANCE_BEGIN), "fenced block appended");
});

test("W5: a stale fenced block is REPLACED in place, surrounding content untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w5-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  const stale = `${GUIDANCE_BEGIN}\n# stale\nold guidance\n${GUIDANCE_END}\n`;
  const before = "# header\n\nsplit\n\n" + stale + "# footer\n";
  await writeFile(join(root, "AGENTS.md"), before, "utf8");
  await init(root, true, ["codex"]);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("# header"), "content before fence preserved");
  assert.ok(agents.includes("# footer"), "content after fence preserved");
  assert.ok(!agents.includes("old guidance"), "stale fenced content replaced");
  assert.ok(agents.includes("cortex_context"), "new guidance present");
  assert.equal(countOccurrences(agents, GUIDANCE_BEGIN), 1, "exactly one fenced block after replacement");
});

test("W6: --no-guidance writes no guidance file", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w6-"));
  await init(root, true, ["claude"], [], false);
  await assert.rejects(stat(join(root, "CLAUDE.md")));
  await mkdir(join(root, ".codex"), { recursive: true });
  await init(root, true, ["codex"], [], false);
  await assert.rejects(stat(join(root, "AGENTS.md")));
});

test("W7: wiring opencode does NOT write CLAUDE.md or AGENTS.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w7-"));
  await init(root, true, ["opencode"]);
  await assert.rejects(stat(join(root, "CLAUDE.md")));
  await assert.rejects(stat(join(root, "AGENTS.md")));
});

test("agentGuidance() stays within the brevity budget", () => {
  const lines = agentGuidance().split("\n").filter((l) => l.trim().length > 0);
  assert.ok(lines.length <= 15, `guidance has ${lines.length} non-empty lines, expected <= 15`);
});

test("agentGuidance() names only MCP tools that the protocol advertises", () => {
  const mentioned = agentGuidance().match(/cortex_[a-z_]+/g) ?? [];
  assert.ok(mentioned.length > 0);
  for (const name of mentioned) assert.ok(MCP_TOOL_NAMES.includes(name as typeof MCP_TOOL_NAMES[number]), `${name} is not an MCP tool`);
});

test("W8: install then init --agent opencode leaves exactly ONE file in .opencode/plugins/", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w8-"));
  await install({ projectRoot: root });
  await init(root, true, ["opencode"]);
  const files = await readdir(join(root, ".opencode", "plugins"));
  assert.equal(files.length, 1, `expected exactly one plugin file, got: ${files.join(", ")}`);
  assert.equal(files[0], "supracortex.ts", "canonical plugin file is supracortex.ts");
  // The stale .js loader must have been removed by init; no .js may remain.
  const js = files.find((f) => f.endsWith(".js"));
  assert.equal(js, undefined, "no stale .js plugin loader may remain");
});

test("W9: orphan BEGIN (no END) is repaired by appending, user content preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w9-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  const prior = "# header\n\norphan " + GUIDANCE_BEGIN + "\ntruncated text\n# footer\n";
  await writeFile(join(root, "AGENTS.md"), prior, "utf8");
  await init(root, true, ["codex"]);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith(prior), "user content outside the fence survives byte-for-byte");
  assert.ok(agents.includes("truncated text"), "orphan text left intact");
  assert.equal(countOccurrences(agents, GUIDANCE_BEGIN), 2, "orphan marker plus one fresh appended block");
  assert.ok(agents.includes("cortex_context"), "fresh guidance block appended");
});

test("W10: orphan END (no BEGIN) is repaired by appending, user content preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w10-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  const prior = "# header\n\nstray " + GUIDANCE_END + "\nfoot\n";
  await writeFile(join(root, "AGENTS.md"), prior, "utf8");
  await init(root, true, ["codex"]);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith(prior), "user content outside the fence survives byte-for-byte");
  assert.equal(countOccurrences(agents, GUIDANCE_BEGIN), 1, "exactly one fresh appended block");
  assert.ok(agents.includes("cortex_context"), "fresh guidance block present");
});

test("W11: END-before-BEGIN is repaired by appending, user content preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w11-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  const prior = "# header\n\n" + GUIDANCE_END + "\n\n" + GUIDANCE_BEGIN + "\n# footer\n";
  await writeFile(join(root, "AGENTS.md"), prior, "utf8");
  await init(root, true, ["codex"]);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith(prior), "user content outside the fence survives byte-for-byte");
  assert.ok(agents.includes("cortex_context"), "fresh guidance block appended");
});

test("W12: duplicate complete blocks collapse to exactly one", async () => {
  const root = await mkdtemp(join(tmpdir(), "supracortex-w12-"));
  await mkdir(join(root, ".codex"), { recursive: true });
  const dup =
    `${GUIDANCE_BEGIN}\n# first\nold\n${GUIDANCE_END}\n` +
    `${GUIDANCE_BEGIN}\n# second\nolder\n${GUIDANCE_END}\n`;
  const prior = "# header\n\n" + dup + "# footer\n";
  await writeFile(join(root, "AGENTS.md"), prior, "utf8");
  await init(root, true, ["codex"]);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("# header"), "content before fence preserved");
  assert.ok(agents.includes("# footer"), "content after fence preserved");
  assert.equal(countOccurrences(agents, GUIDANCE_BEGIN), 1, "duplicate blocks collapsed to exactly one");
  assert.ok(agents.includes("cortex_context"), "fresh guidance block present");
});
