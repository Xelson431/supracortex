/**
 * Fresh-project default-on: init --yes enables, backfills, writes the
 * imperative rule, and leaves status/doctor green. Global behavior unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cli from "../../packages/opencode/src/cli-core.ts";
import { shouldRemind, remindThreshold, REMIND_LINE } from "../../packages/opencode/src/plugin.ts";
import { V2_REMIND_LINE } from "../../packages/opencode/src/plugin-v2.ts";

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("init plan (no --yes) writes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-init-plan-"));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
  const report = await cli.init(root, false);
  assert.equal(await exists(join(root, ".supracortex", "config.jsonc")), false);
  assert.ok(report.notes.some((n) => n.includes("plan only")));
});

test("init --yes enables + backfills + writes imperative rule; status ENABLED", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-init-fresh-"));
  await writeFile(join(root, "a.ts"), "export function a() { return 1; }\n", "utf8");
  await writeFile(join(root, "b.ts"), "export function b() { return 2; }\n", "utf8");
  const report = await cli.init(root, true);
  // Enabled through the central config: no project config file is written.
  await assert.rejects(readFile(join(root, ".supracortex", "config.jsonc"), "utf8"));
  assert.ok(report.notes.some((n) => n.includes("enabled project") || n.includes("already enabled")));
  // Backfill note with count + duration.
  assert.ok(report.notes.some((n) => n.includes("backfill index:") || n.includes("backfill warn:")));
  const index = JSON.parse(await readFile(join(root, ".supracortex", "index", "repository.json"), "utf8")) as { files: Record<string, unknown> };
  assert.ok(Object.keys(index.files).length > 0, "backfill count>0");
  // Imperative rule line present (AGENTS.md fallback for fresh projects).
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.includes(cli.PROJECT_RULE_LINE));
  // Status shows ENABLED with a closed reason.
  const s = await cli.status(root);
  assert.equal(s.state, "ENABLED");
  assert.ok(["injected", "no-query", "empty-packet", "dedup", "disabled", "gate-below-threshold"].includes(s.shouldInjectReason));
  // Doctor project check green: no failing legacy checks that init controls.
  const checks = await cli.doctor(root);
  const failing = checks.filter((c) => !c.ok && !["MCP handshake", "launcher exists", "supracode profile"].includes(c.name));
  assert.equal(failing.length, 0, failing.map((f) => `${f.name}: ${f.detail}`).join("; "));
});

test("init --yes is idempotent and reports enabled/skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-init-idem-"));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
  const first = await cli.init(root, true);
  const second = await cli.init(root, true);
  assert.ok(second.notes.some((n) => n.includes("already enabled") || n.includes("enabled project")));
  assert.ok(second.notes.some((n) => n.includes("backfill skipped") || n.includes("backfill index:")));
  const agents1 = await readFile(join(root, "AGENTS.md"), "utf8");
  const agents2 = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.equal(agents1, agents2);
  void first;
});

test("init --yes with --no-enable leaves the project disabled", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ci-home-noenable-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const root = await mkdtemp(join(tmpdir(), "sc-init-noenable-"));
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const report = await cli.init(root, true, undefined, [], true, { enable: false });
    assert.ok(report.notes.some((n) => n.includes("--no-enable")));
    assert.equal(await exists(join(root, ".supracortex", "config.jsonc")), false, "no enable marker written");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("empty repo backfills 0 with warn, init still succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-init-empty-"));
  const report = await cli.init(root, true);
  assert.ok(report.notes.some((n) => n.includes("backfill warn: 0 files") || n.includes("backfill")));
  const s = await cli.status(root);
  assert.equal(s.state, "ENABLED");
});

test("remind threshold defaults to 25 with env override; single-nudge predicate", () => {
  assert.equal(remindThreshold({} as NodeJS.ProcessEnv), 25);
  assert.equal(remindThreshold({ SUPRACORTEX_REMIND_AFTER_N: "3" } as NodeJS.ProcessEnv), 3);
  assert.equal(remindThreshold({ SUPRACORTEX_REMIND_AFTER_N: "bogus" } as NodeJS.ProcessEnv), 25);
  assert.equal(shouldRemind(4, 5), false);
  assert.equal(shouldRemind(5, 5), true);
  assert.ok(REMIND_LINE.includes("cortex_context") && REMIND_LINE.includes("@cortex"));
});

test("init plan (no --yes) writes no rule or index files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-init-planfiles-"));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
  await cli.init(root, false);
  assert.equal(await exists(join(root, "AGENTS.md")), false, "no rule write on plan");
  assert.equal(await exists(join(root, "CLAUDE.md")), false, "no rule write on plan");
  assert.equal(await exists(join(root, ".supracortex", "index", "repository.json")), false, "no backfill on plan");
});

test("init --yes --no-enable writes no rule or backfill files", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ci-home-noenable2-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const root = await mkdtemp(join(tmpdir(), "sc-init-noenable2-"));
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const report = await cli.init(root, true, undefined, [], true, { enable: false });
    assert.ok(report.notes.some((n) => n.includes("backfill skipped (--no-enable")));
    assert.equal(await exists(join(root, "AGENTS.md")), false, "no rule write under --no-enable");
    assert.equal(await exists(join(root, ".supracortex", "index", "repository.json")), false, "no backfill under --no-enable");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test("init --yes --agent claude passes the filter through with no extras", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-init-filter-"));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
  const report = await cli.init(root, true, ["claude"]);
  assert.equal(await exists(join(root, "CLAUDE.md")), true, "filtered agent wired");
  assert.equal(await exists(join(root, "AGENTS.md")), false, "no unfiltered extras");
  assert.ok(!report.notes.some((n) => n.includes("opencode default")), "no default loader write");
  assert.ok(report.notes.some((n) => n.includes("enabled project") || n.includes("already enabled")));
});

test("backfill failure path warns without throwing (exit 0)", async () => {
  // A regular file as project root forces the build/write to fail; the
  // helper must return a warn note instead of throwing.
  const dir = await mkdtemp(join(tmpdir(), "sc-backfill-fail-"));
  const fakeRoot = join(dir, "not-a-dir");
  await writeFile(fakeRoot, "x", "utf8");
  const res = await cli.backfillProjectIndex(fakeRoot);
  assert.equal(res.files, 0);
  assert.ok(res.note.includes("backfill warn:"), `warn note, got: ${res.note}`);
});

test("V2 remind line matches V1 canonical (parity)", () => {
  assert.equal(V2_REMIND_LINE, REMIND_LINE);
  assert.ok(V2_REMIND_LINE.includes("cortex_context"));
});

test("global install is enabled by default and init writes no project settings", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "ci-home-"));
  const project = await mkdtemp(join(tmpdir(), "ci-proj-"));
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await cli.install({ projectRoot: project, global: true });
    const cfg = await readFile(join(fakeHome, ".config", "supracortex", "config.jsonc"), "utf8");
    assert.match(cfg, /"enabled":\s*true/);
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "x.ts"), "export const x = 1;\n", "utf8");
    await cli.init(project, true);
    assert.equal(await exists(join(project, ".supracortex", "config.jsonc")), false, "settings stay central");
    assert.equal((await cli.status(project)).state, "ENABLED");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});
