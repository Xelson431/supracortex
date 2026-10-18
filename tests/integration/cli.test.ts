import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cli from "../../packages/opencode/src/cli-core.ts";

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ci-cli-"));
  await writeFile(join(dir, "opencode.json"), JSON.stringify({ plugin: [] }), "utf8");
  await writeFile(join(dir, "sample.ts"), "export const x = 1;\n", "utf8");
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("install creates expected files and is idempotent", async () => {
  const dir = await project();
  const r1 = await cli.install({ projectRoot: dir });
  // Settings are central: a project install must NOT write a project config.
  assert.ok(!r1.created.some((p) => p.endsWith(join(".supracortex", "config.jsonc"))));
  assert.equal(await exists(join(dir, ".supracortex", "config.jsonc")), false);
  // Normalize separators: Windows reports created paths with `\`.
  assert.ok(r1.created.some((p) => p.replaceAll("\\", "/").includes(".opencode/plugins")));
  const skill = join(dir, ".opencode", "skills", "supracortex", "SKILL.md");
  assert.ok(await exists(skill));
  assert.match(await readFile(skill, "utf8"), /cortex_context/);
  assert.ok(await exists(join(dir, ".opencode/commands/cortex-status.md")));

  const r2 = await cli.install({ projectRoot: dir });
  assert.equal(r2.created.length, 0, "second install creates nothing");
  assert.ok(r2.skipped.length > 0);
});

test("install preserves a user-owned SupraCortex skill", async () => {
  const dir = await project();
  const skill = join(dir, ".opencode", "skills", "supracortex", "SKILL.md");
  await (await import("node:fs/promises")).mkdir(join(dir, ".opencode", "skills", "supracortex"), { recursive: true });
  await writeFile(skill, "# My custom workflow\n", "utf8");

  const report = await cli.install({ projectRoot: dir });
  assert.equal(await readFile(skill, "utf8"), "# My custom workflow\n");
  assert.ok(report.notes.some((note) => note.includes("preserved user-owned") && note.includes("SKILL.md")));
});

test("uninstall removes only the owned skill", async () => {
  const dir = await project();
  await cli.install({ projectRoot: dir });
  const skill = join(dir, ".opencode", "skills", "supracortex", "SKILL.md");
  const report = await cli.uninstall({ projectRoot: dir, keepData: true });
  assert.equal(await exists(skill), false);
  assert.ok(report.removed.includes(skill));
});

test("enable/disable persists to config", async () => {
  const dir = await project();
  await cli.install({ projectRoot: dir });
  await cli.setEnabled(dir, false);
  let s = await cli.status(dir);
  assert.equal(s.active, false);
  await cli.setEnabled(dir, true);
  s = await cli.status(dir);
  assert.equal(s.active, true);
});

test("uninstall --keep-data preserves runtime dir", async () => {
  const dir = await project();
  await cli.install({ projectRoot: dir });

  const r = await cli.uninstall({ projectRoot: dir, keepData: true });
  assert.ok(r.kept.some((p) => p.includes(".supracortex")));
  assert.ok(await exists(join(dir, ".supracortex")), "data kept");
  assert.ok(!(await exists(join(dir, ".opencode/plugins/supracortex.ts"))), "plugin removed");
});

test("uninstall does not touch host config or source files", async () => {
  const dir = await project();
  await cli.install({ projectRoot: dir });
  const before = await readFile(join(dir, "opencode.json"), "utf8");
  const sampleBefore = await readFile(join(dir, "sample.ts"), "utf8");
  await cli.uninstall({ projectRoot: dir, keepData: false });
  const after = await readFile(join(dir, "opencode.json"), "utf8");
  const sampleAfter = await readFile(join(dir, "sample.ts"), "utf8");
  assert.equal(before, after, "opencode.json unchanged");
  assert.equal(sampleBefore, sampleAfter, "source unchanged");
  assert.ok(!(await exists(join(dir, ".supracortex"))), "data removed");
});

test("uninstall preflights symlinked integration files before removing anything", async (t) => {
  const dir = await project();
  await cli.install({ projectRoot: dir });
  const pluginPath = join(dir, ".opencode", "plugins", "supracortex.ts");
  const outside = join(dir, "..", `outside-plugin-${Date.now()}.ts`);
  const outsideContent = "// user-owned outside data\n";
  await writeFile(outside, outsideContent);
  await rm(pluginPath);
  try {
    await symlink(outside, pluginPath, "file");
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
    cli.uninstall({ projectRoot: dir, keepData: true }),
    /contains a symbolic link/,
  );
  assert.equal(await readFile(outside, "utf8"), outsideContent, "outside symlink target is untouched");
  assert.equal(
    await exists(pluginPath),
    true,
    "uninstall made no earlier partial changes",
  );
});

test("doctor passes on a fresh install", async () => {
  const dir = await project();
  await cli.install({ projectRoot: dir });
  const checks = await cli.doctor(dir);
  // The suite runs under a throwaway HOME, where no SupraCode profile exists
  // (a machine-level concern that `profile init` owns, not project install).
  const failing = checks.filter((c) => !c.ok && c.name !== "supracode profile");
  assert.equal(failing.length, 0, failing.map((f) => `${f.name}: ${f.detail}`).join("; "));
});

test("doctor exposes unknown raw configuration keys as a failed check", async () => {
  const dir = await project();
  await cli.install({ projectRoot: dir });
  // install no longer writes a project config (settings are central); the
  // typo check must still cover a hand-written project file.
  const configPath = join(dir, ".supracortex", "config.jsonc");
  await writeFile(configPath, '{\n  "typoedOption": true\n}\n', "utf8");

  const checks = await cli.doctor(dir);
  const configKeys = checks.find((check) => check.name === "config keys");
  assert.ok(configKeys, "doctor reports raw config-key problems");
  assert.equal(configKeys.ok, false);
  assert.match(configKeys.detail, /project config: unknown key typoedOption/);
});

test("status and doctor never follow an unsafe configured storage path", async () => {
  const dir = await project();
  await cli.install({ projectRoot: dir });
  // storage.directory is project-scoped, so it is still honoured from the
  // project file — and must still be confined to the project root.
  const configPath = join(dir, ".supracortex", "config.jsonc");
  await writeFile(configPath, JSON.stringify({ storage: { directory: "../outside" } }), "utf8");

  await assert.rejects(cli.status(dir), /storage\.directory escapes the project root/);
  const checks = await cli.doctor(dir);
  const storage = checks.find((check) => check.name === "storage writable");
  assert.ok(storage);
  assert.equal(storage.ok, false);
  assert.equal(await exists(join(dir, "..", "outside")), false, "doctor did not write outside the project");
});

test("reset all-generated keeps durable memory", async () => {
  const dir = await project();
  await cli.install({ projectRoot: dir });
  const { JsonlStore } = await import("../../packages/core/src/index.ts");
  const store = new JsonlStore(join(dir, ".supracortex"));
  await store.appendJsonl("memory/durable.jsonl", [{ id: "1", kind: "fact", content: "x", confidence: 1, status: "active", sourceReferences: [], createdAt: "", updatedAt: "", relatedFiles: [], relatedSymbols: [], tags: [], invalidationRules: [] }]);
  await store.writeJson("index/repository.json", { version: 1, files: {} });
  await cli.reset(dir, "all-generated");
  const durable = await store.readJsonl("memory/durable.jsonl");
  assert.equal(durable.entries.length, 1, "durable memory kept");
  assert.equal(await store.exists("index/repository.json"), false, "index removed");
});
