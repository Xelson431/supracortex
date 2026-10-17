/**
 * Filesystem-backed StorageAdapter using JSON and JSONL files.
 *
 * Design points:
 *  - Writes go to a temp file then rename() for atomic replacement.
 *  - JSONL reads tolerate corrupt lines (skip + count) instead of throwing.
 *  - Descendant symlinks and lexical traversal are rejected. Root ancestors
 *    are trusted; this is not a sandbox against concurrent parent renames.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { acquireFileLock } from "./file-lock.ts";
import { isMissing, openRegularFile, resolveConfinedPath } from "./safe-path.ts";
import type { JsonlAppendResult, JsonlReadResult, StorageAdapter } from "./storage-adapter.ts";

export class JsonlStore implements StorageAdapter {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async resolveSafe(relPath: string): Promise<string> {
    const abs = resolve(this.root, relPath);
    const rel = relative(this.root, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Path escapes storage root: ${relPath}`);
    }
    return resolveConfinedPath(this.root, abs, { allowMissingRoot: true, rejectRootSymlink: true });
  }

  async ensureDir(relDir: string): Promise<void> {
    await mkdir(await this.resolveSafe(relDir), { recursive: true, mode: 0o700 });
    await this.resolveSafe(relDir);
  }

  private async readText(relPath: string): Promise<string> {
    const handle = await openRegularFile(await this.resolveSafe(relPath), constants.O_RDONLY);
    try { return await handle.readFile("utf8"); }
    finally { await handle.close(); }
  }

  async readJson<T>(relPath: string): Promise<T | null> {
    try {
      const raw = await this.readText(relPath);
      return JSON.parse(raw) as T;
    } catch (err) {
      if (isMissing(err)) return null;
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    await this.atomicWrite(relPath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async appendJsonl(relPath: string, entries: unknown[]): Promise<JsonlAppendResult> {
    if (entries.length === 0) return { written: 0 };
    await this.resolveSafe(relPath);
    await this.ensureDir(dirname(relPath));
    const payload = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const handle = await openRegularFile(await this.resolveSafe(relPath), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
    try { await handle.writeFile(payload, "utf8"); }
    finally { await handle.close(); }
    return { written: entries.length };
  }

  async readJsonl<T>(relPath: string): Promise<JsonlReadResult<T>> {
    let raw: string;
    try {
      raw = await this.readText(relPath);
    } catch (err) {
      if (isMissing(err)) return { entries: [], corruptLines: 0 };
      throw err;
    }
    const entries: T[] = [];
    let corruptLines = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as T);
      } catch {
        corruptLines++;
      }
    }
    return { entries, corruptLines };
  }

  async readJsonlTail<T>(relPath: string, limit: number): Promise<JsonlReadResult<T>> {
    if (!Number.isSafeInteger(limit) || limit < 1) return { entries: [], corruptLines: 0 };
    const raw = await this.readText(relPath).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (raw === null) return { entries: [], corruptLines: 0 };
    const lines = raw.split("\n").filter((line) => line.trim()).slice(-limit);
    const entries: T[] = [];
    let corruptLines = 0;
    for (const line of lines) {
      try { entries.push(JSON.parse(line) as T); }
      catch { corruptLines++; }
    }
    return { entries, corruptLines };
  }

  async rewriteJsonl(relPath: string, entries: unknown[]): Promise<void> {
    const payload = entries.length ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : "";
    await this.atomicWrite(relPath, payload);
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await lstat(await this.resolveSafe(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async remove(relPath: string): Promise<void> {
    if (resolve(this.root, relPath) === this.root) throw new Error("cannot remove storage root");
    await rm(await this.resolveSafe(relPath), { recursive: true, force: true });
  }

  async listFiles(relDir: string): Promise<string[]> {
    const dir = await this.resolveSafe(relDir);
    let names: string[];
    try { names = await readdir(dir); }
    catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const files: string[] = [];
    for (const name of names) {
      const path = join(dir, name);
      try {
        const info = await lstat(path);
        if (info.isFile() && !info.isSymbolicLink()) files.push(`${relDir.replace(/[\\/]+$/, "")}/${name}`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return files.sort();
  }

  async totalSizeBytes(): Promise<number> {
    return dirSize(await this.resolveSafe("."));
  }

  async acquireLock(
    name: string,
    opts?: { staleMs?: number; retryMs?: number; timeoutMs?: number },
  ): Promise<() => Promise<void>> {
    const safeName = createHash("sha256").update(name).digest("hex").slice(0, 16);
    const rel = `state/${safeName}.lock`;
    await this.ensureDir("state");
    const lockDir = await this.resolveSafe(rel);
    await this.resolveSafe(`${rel}/owner.json`);
    const release = await acquireFileLock(lockDir, opts);
    return async () => {
      await this.resolveSafe(`${rel}/owner.json`);
      await release();
    };
  }

  private async atomicWrite(relPath: string, content: string): Promise<void> {
    await this.resolveSafe(relPath);
    await this.ensureDir(dirname(relPath));
    const abs = await this.resolveSafe(relPath);
    const tmp = `${abs}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
    const handle = await openRegularFile(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      await handle.writeFile(content, "utf8");
      await handle.close();
      if (await this.resolveSafe(relPath) !== abs) throw new Error("storage path changed during write");
      await rename(tmp, abs);
    } finally {
      await handle.close().catch(() => undefined);
      await rm(tmp, { force: true });
    }
  }

  async close(): Promise<void> {
    // Filesystem operations do not retain a backend handle.
  }

  // ---------------------------------------------------------------------------
  // HistoryManager: JSONL-swappable history log (delegates to the JSONL core).
  // ---------------------------------------------------------------------------

  async appendHistory(relPath: string, entries: unknown[]): Promise<JsonlAppendResult> {
    return this.appendJsonl(relPath, entries);
  }

  async readHistory<T>(relPath: string): Promise<JsonlReadResult<T>> {
    return this.readJsonl<T>(relPath);
  }

  async rewriteHistory(relPath: string, entries: unknown[]): Promise<void> {
    return this.rewriteJsonl(relPath, entries);
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let visited = 0;
  const stack = [{ path: dir, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (++visited > 50_000 || item.depth > 64) throw new Error("storage size traversal limit exceeded");
    try {
      const st = await lstat(item.path);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        const names = await readdir(item.path);
        if (names.length + visited + stack.length > 50_000) throw new Error("storage size traversal limit exceeded");
        for (const name of names) stack.push({ path: join(item.path, name), depth: item.depth + 1 });
      } else if (st.isFile()) total += st.size;
    } catch (error) {
      // Never under-report a quota on permission errors or traversal limits.
      if (!isMissing(error)) throw error;
    }
  }
  return total;
}
