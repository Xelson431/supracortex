/**
 * The dedicated supracode2 (OpenCode V2) config root must be resolved through
 * the same env-aware scheme as the SupraCode profile (profile.ts), not the
 * developer's real os.homedir(). Every case runs under a scratch HOME /
 * SUPRACODE_HOME / SUPRACODE2_CONFIG_DIR; no real config is read or written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cli from "../../packages/opencode/src/cli-core.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Run `fn` with the supplied env overrides restored afterwards. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("ensureV2Root lands under the scratch HOME, never the developer's real config", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "sc2-home-"));
  const project = await mkdtemp(join(tmpdir(), "sc2-proj-"));
  await withEnv({ HOME: fakeHome, SUPRACODE2_CONFIG_DIR: undefined, SUPRACODE_HOME: undefined }, async () => {
    await cli.install({ projectRoot: project, global: true });
    const root = join(fakeHome, ".config", "supracode2");
    assert.ok(
      await exists(join(root, "plugins", "supracode-v2", "index.ts")),
      "V2 server loader lands under the scratch HOME",
    );
    assert.ok(
      await exists(join(root, "plugins", "supracode-v2", "tui.ts")),
      "V2 TUI loader lands under the scratch HOME",
    );
    assert.match(await readFile(join(root, "plugins", "supracode-v2", "index.ts"), "utf8"), /supracortex:owned/);
  });
});

test("ensureV2Root follows SUPRACODE_HOME (profile.ts scheme), not os.homedir()", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sc2-schome-"));
  const project = await mkdtemp(join(tmpdir(), "sc2-proj-"));
  const profileHome = join(scratch, "custom", "supracode");
  await withEnv({ HOME: scratch, SUPRACODE_HOME: profileHome, SUPRACODE2_CONFIG_DIR: undefined }, async () => {
    await cli.install({ projectRoot: project, global: true });
    const root = join(scratch, "custom", "supracode2");
    assert.ok(
      await exists(join(root, "plugins", "supracode-v2", "index.ts")),
      "V2 root is the sibling of the relocated SUPRACODE_HOME",
    );
    // The profile itself moved too, proving the same resolution is in play.
    assert.ok(await exists(join(profileHome, "opencode", "plugins", "supracortex.ts")));
  });
});

test("ensureV2Root honors the SUPRACODE2_CONFIG_DIR override the V2 launcher uses", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sc2-override-"));
  const project = await mkdtemp(join(tmpdir(), "sc2-proj-"));
  const override = join(scratch, "v2-root");
  await withEnv({ HOME: scratch, SUPRACODE2_CONFIG_DIR: override }, async () => {
    await cli.install({ projectRoot: project, global: true });
    assert.ok(
      await exists(join(override, "plugins", "supracode-v2", "index.ts")),
      "V2 root written to the explicit override",
    );
    assert.equal(await exists(join(scratch, ".config", "supracode2")), false, "no default root created");
  });
});

test("uninstall --global removes the owned supracode2 root it created", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "sc2-rm-"));
  const project = await mkdtemp(join(tmpdir(), "sc2-proj-"));
  await withEnv(
    { HOME: fakeHome, SUPRACODE2_CONFIG_DIR: undefined, SUPRACODE_CLAUDE_BIN: join(fakeHome, "missing-claude") },
    async () => {
      await cli.install({ projectRoot: project, global: true });
      const root = join(fakeHome, ".config", "supracode2");
      assert.ok(await exists(root), "root exists after install");

      const report = await cli.uninstall({ projectRoot: project, keepData: true, global: true });
      assert.equal(await exists(root), false, "entirely-owned supracode2 root removed on uninstall");
      assert.ok(report.removed.includes(root), "root reported as removed");
      assert.ok(report.removed.some((p) => p.endsWith(join("plugins", "supracode-v2", "index.ts"))));
      assert.ok(report.removed.some((p) => p.endsWith(join("plugins", "supracode-v2", "tui.ts"))));
    },
  );
});

test("uninstall --global preserves a user-modified supracode2 file with a note and backup", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "sc2-keep-"));
  const project = await mkdtemp(join(tmpdir(), "sc2-proj-"));
  const userBody = "// user tweaked this loader\nexport default 42;\n";
  await withEnv(
    { HOME: fakeHome, SUPRACODE2_CONFIG_DIR: undefined, SUPRACODE_CLAUDE_BIN: join(fakeHome, "missing-claude") },
    async () => {
      await cli.install({ projectRoot: project, global: true });
      const root = join(fakeHome, ".config", "supracode2");
      const tui = join(root, "plugins", "supracode-v2", "tui.ts");
      // The user removes our marker and edits the file.
      await writeFile(tui, userBody, "utf8");

      const report = await cli.uninstall({ projectRoot: project, keepData: true, global: true });
      assert.ok(await exists(tui), "user-modified V2 file is preserved");
      assert.equal(await readFile(tui, "utf8"), userBody, "user content survives byte-for-byte");
      assert.ok(
        report.notes.some((n) => n.includes("preserved user-modified OpenCode V2 file") && n.includes(tui)),
        "uninstall leaves a note",
      );
      assert.ok(report.backups.includes(`${tui}.bak`), "user-modified file is backed up");
      assert.equal(await exists(root), true, "root kept because it still holds user content");
      assert.ok(report.notes.some((n) => n.includes("still contains user content")), "root retention is noted");
      // The owned (marker-fenced) loader is still removed.
      assert.equal(await exists(join(root, "plugins", "supracode-v2", "index.ts")), false);
    },
  );
});

test("uninstall --global is idempotent for the supracode2 root", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "sc2-idem-"));
  const project = await mkdtemp(join(tmpdir(), "sc2-proj-"));
  await withEnv(
    { HOME: fakeHome, SUPRACODE2_CONFIG_DIR: undefined, SUPRACODE_CLAUDE_BIN: join(fakeHome, "missing-claude") },
    async () => {
      await cli.install({ projectRoot: project, global: true });
      const root = join(fakeHome, ".config", "supracode2");
      await cli.uninstall({ projectRoot: project, keepData: true, global: true });
      const second = await cli.uninstall({ projectRoot: project, keepData: true, global: true });
      assert.equal(await exists(root), false);
      assert.equal(second.removed.includes(root), false, "second uninstall does not re-report the root");
    },
  );
});
