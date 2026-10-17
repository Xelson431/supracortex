/**
 * SupraSpaceStore: path-confined read/write of the six fixed SupraSpace memory
 * Markdown files under `<projectRoot>/.supraspace/`.
 *
 * This mirrors SupraSpace's own MemoryStore contract (same six filenames,
 * missing file -> empty string, allowlist-guarded writes) WITHOUT importing any
 * SupraSpace code — Cortex stays framework-agnostic. It exists so Cortex can
 * unify with SupraSpace's memory instead of running a parallel silo.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SupraSpaceMemoryFile } from "../types.ts";

export const SUPRASPACE_FILES: SupraSpaceMemoryFile[] = [
  "project.md",
  "architecture.md",
  "decisions.md",
  "tasks.md",
  "agent-notes.md",
  "review-notes.md",
];

export function isSupraSpaceFile(f: string): f is SupraSpaceMemoryFile {
  return (SUPRASPACE_FILES as string[]).includes(f);
}

export class SupraSpaceStore {
  private readonly dir: string;
  private readonly root: string;

  constructor(projectRoot: string, directory = ".supraspace") {
    this.root = resolve(projectRoot);
    this.dir = resolve(this.root, directory);
    // Confine the memory dir to the project root.
    const rel = relative(this.root, this.dir);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`.supraspace directory escapes project root: ${directory}`);
    }
  }

  async readAll(): Promise<Record<SupraSpaceMemoryFile, string>> {
    const out = {} as Record<SupraSpaceMemoryFile, string>;
    await Promise.all(
      SUPRASPACE_FILES.map(async (f) => {
        out[f] = await this.read(f);
      }),
    );
    return out;
  }

  async read(file: SupraSpaceMemoryFile): Promise<string> {
    if (!isSupraSpaceFile(file)) throw new Error(`Invalid SupraSpace file: ${String(file)}`);
    try {
      return await readFile(join(this.dir, file), "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return "";
      throw err;
    }
  }

  async write(file: SupraSpaceMemoryFile, content: string): Promise<void> {
    if (!isSupraSpaceFile(file)) throw new Error(`Invalid SupraSpace file: ${String(file)}`);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, file), content, "utf8");
  }

  async exists(): Promise<boolean> {
    try {
      await readFile(join(this.dir, "project.md"), "utf8");
      return true;
    } catch (err) {
      // Directory may exist with other files; probe the dir via any file.
      if ((err as { code?: string }).code === "ENOENT") {
        for (const f of SUPRASPACE_FILES) {
          try {
            await readFile(join(this.dir, f), "utf8");
            return true;
          } catch {
            /* keep trying */
          }
        }
        return false;
      }
      return false;
    }
  }
}
