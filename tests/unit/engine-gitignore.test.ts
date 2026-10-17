/**
 * Engine init must guarantee `<storage>/.gitignore` exists for every host,
 * including MCP-only hosts that never run the installer. The block is
 * byte-identical to the installer's ensureGitignore (cli-core.ts).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Engine, JsonlStore, ensureRuntimeGitignore, resolveConfig } from "../../packages/core/src/index.ts";
import { createEngine, createStore } from "../../packages/opencode/src/lifecycle.ts";

const ENTRIES = [
  "# supracortex generated runtime state: do not un-ignore",
  "*",
  "!.gitignore",
  "!config.jsonc",
  "!config.schema.json",
  "!.supracortexignore",
];
const MARKER = "supracortex generated runtime state";

function makeEngine(projectRoot: string): Engine {
  const { config } = resolveConfig({
    project: { enabled: true, graph: { enabled: false }, supraspace: { enabled: false } },
  });
  return new Engine({
    config,
    store: new JsonlStore(join(projectRoot, ".supracortex")),
    pluginVersion: "test",
    projectRoot,
  });
}

function count(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

test("init on a fresh dir creates .gitignore with the marker and all entries", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-fresh-"));
  const engine = makeEngine(projectRoot);
  try {
    await engine.init();
    const content = await readFile(join(projectRoot, ".supracortex", ".gitignore"), "utf8");
    assert.equal(count(content, MARKER), 1);
    for (const entry of ENTRIES) {
      assert.ok(content.split("\n").includes(entry), `missing entry: ${entry}`);
    }
  } finally {
    await engine.close();
  }
});

test("a second init does not duplicate the marker", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-twice-"));
  const first = makeEngine(projectRoot);
  try {
    await first.init();
  } finally {
    await first.close();
  }
  const second = makeEngine(projectRoot);
  try {
    await second.init();
    await second.init();
    const content = await readFile(join(projectRoot, ".supracortex", ".gitignore"), "utf8");
    assert.equal(count(content, MARKER), 1);
  } finally {
    await second.close();
  }
});

test("a pre-existing user .gitignore is preserved and appended once", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-user-"));
  const storageRoot = join(projectRoot, ".supracortex");
  const userContent = "# user rules\nnode_modules/\n";
  await mkdir(storageRoot, { recursive: true });
  await writeFile(join(storageRoot, ".gitignore"), userContent, "utf8");

  const engine = makeEngine(projectRoot);
  try {
    await engine.init();
    await engine.init();
    const content = await readFile(join(storageRoot, ".gitignore"), "utf8");
    assert.ok(content.startsWith(userContent + "\n"), "user content preserved");
    assert.equal(count(content, MARKER), 1);
    for (const entry of ENTRIES) {
      assert.ok(content.split("\n").includes(entry), `missing entry: ${entry}`);
    }
  } finally {
    await engine.close();
  }
});

test("an unwritable .gitignore path does not reject init", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-fail-"));
  const storageRoot = join(projectRoot, ".supracortex");
  // A directory at the target path makes readFile/writeFile fail (EISDIR).
  await mkdir(join(storageRoot, ".gitignore"), { recursive: true });

  const engine = makeEngine(projectRoot);
  try {
    await assert.doesNotReject(engine.init());
    assert.equal((await stat(join(storageRoot, ".gitignore"))).isDirectory(), true);
  } finally {
    await engine.close();
  }
});

test("a symlinked .gitignore is never followed", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-link-"));
  const storageRoot = join(projectRoot, ".supracortex");
  const externalTarget = join(projectRoot, "external-target.txt");
  const externalContent = "# external rules\nimportant/\n";
  await mkdir(storageRoot, { recursive: true });
  await writeFile(externalTarget, externalContent, "utf8");
  const gitignorePath = join(storageRoot, ".gitignore");
  await symlink(externalTarget, gitignorePath);

  await assert.doesNotReject(ensureRuntimeGitignore(storageRoot));

  assert.equal(await readFile(externalTarget, "utf8"), externalContent, "external target untouched");
  assert.equal((await lstat(gitignorePath)).isSymbolicLink(), true, "symlink untouched");
});

test("a non-regular .gitignore is left untouched", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-dir-"));
  const storageRoot = join(projectRoot, ".supracortex");
  const gitignorePath = join(storageRoot, ".gitignore");
  await mkdir(gitignorePath, { recursive: true });

  await assert.doesNotReject(ensureRuntimeGitignore(storageRoot));
  assert.equal((await stat(gitignorePath)).isDirectory(), true, "directory preserved");
});

test("a symlinked storage root is never written through", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-root-link-"));
  const outside = mkdtempSync(join(tmpdir(), "sc-gitignore-outside-"));
  const storageRoot = join(projectRoot, ".supracortex");
  await symlink(outside, storageRoot, "dir");

  await assert.doesNotReject(ensureRuntimeGitignore(storageRoot));

  assert.deepEqual(await readdir(outside), [], "outside directory gains no files");
  await assert.rejects(lstat(join(outside, ".gitignore")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("createStore does not write the runtime .gitignore", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-create-store-"));
  const { config } = resolveConfig({
    project: {
      enabled: true,
      storage: { driver: "sqlite" },
      graph: { enabled: false },
      supraspace: { enabled: false },
    },
  });

  let store: Awaited<ReturnType<typeof createStore>>;
  try {
    store = await createStore(config, projectRoot);
  } catch (error) {
    // node:sqlite/bun:sqlite may be unavailable in this runtime.
    const message = error instanceof Error ? error.message : String(error);
    if (/sqlite/i.test(message) && /(runtime|node:sqlite|bun:sqlite)/i.test(message)) return;
    throw error;
  }

  try {
    await assert.rejects(
      lstat(join(projectRoot, ".supracortex", ".gitignore")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      "opening the store is not a diagnostics write",
    );
    // The adapter really did run.
    assert.equal((await stat(join(projectRoot, ".supracortex", "state", "store.sqlite"))).isFile(), true);
  } finally {
    await store.close();
  }
});

test("createEngine writes the runtime .gitignore before creating the store", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "sc-gitignore-create-engine-"));
  const { config } = resolveConfig({
    project: { enabled: true, graph: { enabled: false }, supraspace: { enabled: false } },
  });

  const engine = await createEngine({
    config,
    projectRoot,
    worktree: projectRoot,
    pluginVersion: "test",
  });
  try {
    const content = await readFile(join(projectRoot, ".supracortex", ".gitignore"), "utf8");
    assert.equal(count(content, MARKER), 1);
    for (const entry of ENTRIES) {
      assert.ok(content.split("\n").includes(entry), `missing entry: ${entry}`);
    }
  } finally {
    await engine.close();
  }
});

