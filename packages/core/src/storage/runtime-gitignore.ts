/**
 * Ensure `<storage>/.gitignore` excludes generated runtime state.
 *
 * Shared by Engine init and the OpenCode engine factory: `createEngine` runs
 * the guard before `createSqliteStore` executes DDL. This helper is
 * intentionally best-effort and never follows symlinks: a repo-shipped
 * `.supracortex` or `.supracortex/.gitignore` link could otherwise redirect our
 * writes (including `*`) outside the project.
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Byte-identical to the installer's ensureGitignore block in cli-core.ts. */
const RUNTIME_GITIGNORE_BLOCK = [
  "# supracortex generated runtime state: do not un-ignore",
  "*",
  "!.gitignore",
  "!config.jsonc",
  "!config.schema.json",
  "!.supracortexignore",
  "",
].join("\n");

const MARKER_SUBSTRING = "supracortex generated runtime state";
const MAX_GITIGNORE_BYTES = 256 * 1024;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function ensureRuntimeGitignore(storageRoot: string): Promise<void> {
  const gitignorePath = join(storageRoot, ".gitignore");
  try {
    // Never write through a symlinked storage root: a repo-shipped
    // `.supracortex` link could redirect the whole runtime state tree outside
    // the project, including this `.gitignore` write.
    let rootInfo: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      rootInfo = await lstat(storageRoot);
    } catch (error) {
      if (!isMissing(error)) return;
    }
    if (rootInfo?.isSymbolicLink()) return;

    // A fresh root may not exist yet (createEngine runs before the adapter's
    // first mkdir). Only create it when the parent is a real directory in an
    // existing tree; never create a path through a symlinked or missing parent.
    if (!rootInfo) {
      let parentInfo: Awaited<ReturnType<typeof lstat>> | null = null;
      try {
        parentInfo = await lstat(dirname(storageRoot));
      } catch {
        return;
      }
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) return;
    }

    let info: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      info = await lstat(gitignorePath);
    } catch (error) {
      if (!isMissing(error)) return;
    }

    if (info) {
      // Do not follow symlinks, and leave directories/devices/sockets/fifos
      // untouched: only a regular file is ours to read and append.
      if (info.isSymbolicLink() || !info.isFile()) return;
      if (info.size > MAX_GITIGNORE_BYTES) return;

      const current = await readFile(gitignorePath, "utf8");
      if (current.includes(MARKER_SUBSTRING)) return;
      if (Buffer.byteLength(current, "utf8") > MAX_GITIGNORE_BYTES) return;

      await writeFile(gitignorePath, current + "\n" + RUNTIME_GITIGNORE_BLOCK, "utf8");
      return;
    }

    // The root is missing (checked above) and its parent is a real directory:
    // create only the root, then the ignore file. Failures are swallowed below.
    await mkdir(storageRoot, { recursive: true });
    await writeFile(gitignorePath, RUNTIME_GITIGNORE_BLOCK, { mode: 0o600 });
  } catch {
    /* never throw: the guard must not block init or store creation */
  }
}
