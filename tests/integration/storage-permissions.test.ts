/**
 * POSIX storage-permission checks.
 *
 * The JSONL driver writes files with 0o600 and creates its own directories with
 * 0o700. The SQLite driver hardens its state directory, database, and WAL/shm
 * sidecars the same way; these tests assert it rather than reporting a gap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createSqliteStore, Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";

function octal(mode: number): string {
  return `0o${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function assertPrivate(mode: number, label: string): void {
  assert.equal(
    mode & 0o077,
    0,
    `${label} must not grant group/other access (mode ${octal(mode)})`,
  );
}

async function collectDirectories(root: string): Promise<string[]> {
  const dirs = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      dirs.push(...(await collectDirectories(join(root, entry.name))));
    }
  }
  return dirs;
}

test(
  "storage directories and files are owner-only",
  { skip: process.platform === "win32" ? "POSIX permission bits are not meaningful on win32" : false },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "sc-permissions-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const project = join(base, "project");
    await mkdir(project);
    const storage = join(project, ".supracortex");

    const store = new JsonlStore(storage);
    const { config } = resolveConfig({ project: { enabled: true, supraspace: { enabled: false } } });
    const engine = new Engine({ config, store, projectRoot: project, pluginVersion: "test" });
    t.after(() => engine.close());
    await engine.init();
    await store.appendJsonl("logs/permissions.jsonl", [{ kind: "permission-probe" }]);

    // Every directory the engine creates under storage is private.
    for (const dir of await collectDirectories(storage)) {
      const info = await stat(dir);
      assert.ok(info.isDirectory(), `${dir} is a directory`);
      assertPrivate(info.mode, `directory ${relative(storage, dir) || "."}`);
    }

    // Appended JSONL files are opened with 0o600 by the JSONL driver.
    const jsonl = await stat(join(storage, "logs", "permissions.jsonl"));
    assert.ok(jsonl.isFile(), "appended JSONL is a regular file");
    assertPrivate(jsonl.mode, "appended JSONL file");

    // Runtime .gitignore must exist and be readable by the current process.
    const gitignorePath = join(storage, ".gitignore");
    await access(gitignorePath, constants.R_OK);
    const gitignore = await readFile(gitignorePath, "utf8");
    assert.ok(gitignore.includes("supracortex generated runtime state"), ".gitignore protects runtime state");
    t.diagnostic(`runtime .gitignore mode ${octal((await stat(gitignorePath)).mode)}`);

    // SQLite is optional at runtime; when unavailable, report and keep the
    // JSONL assertions meaningful instead of skipping the whole test.
    let sqlite: Awaited<ReturnType<typeof createSqliteStore>> | undefined;
    // A fresh root proves the SQLite driver creates `state` itself.
    const sqliteStorage = join(base, "sqlite-project", ".supracortex");
    try {
      sqlite = await createSqliteStore(sqliteStorage);
    } catch (error) {
      const message = (error as Error).message;
      if (/node:sqlite|SQLite runtime is unavailable/i.test(message)) {
        t.diagnostic(`SQLite permission modes not observed: ${message}`);
      } else {
        throw error;
      }
    }

    if (sqlite) {
      try {
        // Force WAL/shm sidecars to exist while the database is open.
        await sqlite.writeJson("state/permission-probe.json", { ok: true });
        await sqlite.appendJsonl("state/permission-probe.jsonl", [{ ok: true }]);

        const stateDir = join(sqliteStorage, "state");
        const stateInfo = await stat(stateDir);
        assert.ok(stateInfo.isDirectory(), "SQLite state path is a directory");
        assertPrivate(stateInfo.mode, "SQLite state directory");
        t.diagnostic(`SQLite state directory mode ${octal(stateInfo.mode)}`);

        const dbPath = join(stateDir, "store.sqlite");
        const dbInfo = await stat(dbPath);
        assert.ok(dbInfo.isFile(), "SQLite database is a regular file");
        assertPrivate(dbInfo.mode, "SQLite database");
        t.diagnostic(`SQLite database mode ${octal(dbInfo.mode)}`);

        for (const suffix of ["-wal", "-shm"] as const) {
          const sidecar = `${dbPath}${suffix}`;
          try {
            const info = await stat(sidecar);
            assertPrivate(info.mode, `SQLite ${suffix} sidecar`);
            t.diagnostic(`SQLite ${suffix} sidecar mode ${octal(info.mode)}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              t.diagnostic(`SQLite ${suffix} sidecar not present while open; mode assertion skipped`);
              continue;
            }
            throw error;
          }
        }
      } finally {
        await sqlite.close();
      }
    }
  },
);
