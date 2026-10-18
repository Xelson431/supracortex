import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function escapes(path: string): boolean {
  if (path === ".." || path.startsWith(`..${sep}`) || path.startsWith("../") || path.startsWith("..\\")) return true;
  if (isAbsolute(path) || win32.isAbsolute(path)) return true;
  // Windows drive-letter (`C:\…`, `C:/…`) and UNC (`\\host\…`) escapes that
  // POSIX `resolve` would otherwise treat as plain relative segments.
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return true;
  if (path.startsWith("\\\\") || path.startsWith("//")) return true;
  if (path.includes("\0")) return true;
  for (const part of path.split(/[\\/]/)) {
    if (part === "..") return true;
  }
  return false;
}

/** Resolve missing descendants against the closest existing, trusted ancestor. */
async function canonicalRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error) || dirname(path) === path) throw error;
    return join(await canonicalRoot(dirname(path)), basename(path));
  }
}

/**
 * Accept an explicitly supplied root alias (e.g. macOS /var -> /private/var),
 * but never follow a symlink beneath that boundary. Returns a canonical path
 * for the caller to use, not just a boolean check against a different path.
 *
 * Ancestors of root are trusted. This is defense in depth, not an openat-style
 * sandbox against a same-user process concurrently renaming parent directories.
 */
export async function resolveConfinedPath(
  root: string,
  target: string,
  options: { allowMissingRoot?: boolean; rejectRootSymlink?: boolean } = {},
): Promise<string> {
  const lexicalRoot = resolve(root);
  if (typeof target !== "string" || target.includes("\0")) {
    throw new Error("path is outside project/storage root (null byte rejected)");
  }
  // On POSIX, reject Windows absolute forms that `resolve` would misread as
  // plain relative segments (drive `C:\…`/`C:/…`, UNC `\\host\…`,
  // backslash-rooted `\…`). POSIX absolutes (`/…`) are NOT rejected here; they
  // are confined by the relative()+escapes() check below. (win32.isAbsolute()
  // must not be used: it returns true for every POSIX absolute path.)
  //
  // On Windows, callers pass already-resolved absolute targets (e.g.
  // `resolve(root, rel)`), so rejecting drive/UNC forms here would reject every
  // legitimate path. Containment is still enforced by relative()+escapes()
  // below, which rejects `..` segments, cross-drive absolutes, and UNC targets.
  if (
    process.platform !== "win32" &&
    (/^[A-Za-z]:([\\/]|$)/.test(target) || /^\\\\/.test(target) || target.startsWith("\\"))
  ) {
    throw new Error("path is outside project/storage root (absolute/Windows escape rejected)");
  }
  const rel = relative(lexicalRoot, resolve(target));
  if (escapes(rel)) throw new Error("path is outside project/storage root");
  if (options.rejectRootSymlink) {
    try {
      if ((await lstat(lexicalRoot)).isSymbolicLink()) throw new Error("symlink rejected: storage root");
    } catch (error) {
      if (!options.allowMissingRoot || !isMissing(error)) throw error;
    }
  }
  const physicalRoot = options.allowMissingRoot
    ? await canonicalRoot(lexicalRoot)
    : await realpath(lexicalRoot);
  let current = physicalRoot;
  const parts = rel.split(/[\\/]/).filter((p) => p.length > 0 && p !== ".");
  if (parts.includes("..")) throw new Error("path is outside project/storage root");
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`symlink rejected: ${parts.slice(0, i + 1).join("/")}`);
      if (i < parts.length - 1 && !info.isDirectory()) {
        throw Object.assign(new Error("path ancestor is not a directory"), { code: "ENOTDIR" });
      }
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  return resolve(physicalRoot, rel);
}

/** No-follow, non-blocking open; reject special files before and after open. */
export async function openRegularFile(path: string, flags: number): Promise<FileHandle> {
  let before: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    before = await lstat(path);
    if (before.isSymbolicLink()) throw new Error("symlink rejected");
    if (!before.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EISDIR" });
  } catch (error) {
    if (!isMissing(error) || !(flags & constants.O_CREAT)) throw error;
  }
  // POSIX has O_NOFOLLOW; Windows does not. There, the lstat pre-check plus
  // the post-open dev/ino identity check are the available protection. Refuse
  // to run without O_NOFOLLOW on POSIX so a degraded platform cannot silently
  // disable the symlink defense.
  const noFollow = constants.O_NOFOLLOW;
  if (!noFollow && process.platform !== "win32") throw new Error("safe no-follow open unavailable");
  const handle = await open(path, flags | (noFollow ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) {
      throw new Error("file changed or is not a regular file");
    }
    if ((flags & (constants.O_WRONLY | constants.O_RDWR)) && opened.nlink > 1) {
      throw new Error("hard-linked file rejected for writing");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
