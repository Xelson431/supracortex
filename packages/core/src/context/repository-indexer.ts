/**
 * Incremental repository indexer.
 *
 * Responsibilities:
 *  - Walk the project root, respecting ignore rules (.gitignore + built-ins).
 *  - Skip binaries, dependency dirs, build output, and secret files.
 *  - Default (fast) path: trust an unchanged mtime+size and reuse the prior
 *    hash without reading bytes. This is a deliberate tradeoff — an adversarial
 *    same-size edit that also restores mtime is NOT detected. Pass
 *    `verify: true` (explicit force) to restore "bytes are the truth": every
 *    candidate is then read and re-hashed.
 *  - Extract lightweight symbols for lexical retrieval.
 *
 * The core stays framework-agnostic: filesystem access is done via node:fs, and
 * git awareness is optional (passed in by the caller as changed-file lists).
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { IndexedFile, RepositoryIndex } from "../types.ts";
import { isSecretFile } from "../memory/validation.ts";
import { estimateBytesTokens } from "../metrics/token-estimator.ts";
import { extractSymbols, extractImports, detectLanguage } from "./summaries.ts";

export const INDEX_VERSION = 2;
/** Parallel file reads during indexing (bounded to keep fd use modest). */
const READ_CONCURRENCY = 16;

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".turbo",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".supracortex",
  // Keep another provider's generated reports out of source context.
  "graphify-out",
]);

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "svg",
  "pdf", "zip", "gz", "tar", "tgz", "bz2", "7z", "rar",
  "mp3", "mp4", "mov", "avi", "webm", "wav", "flac", "ogg",
  "woff", "woff2", "ttf", "eot", "otf",
  "wasm", "so", "dylib", "dll", "exe", "bin", "class", "o", "a",
  "db", "sqlite", "sqlite3", "lock",
]);

const MAX_FILE_BYTES = 2_000_000; // Skip very large files for indexing.

export interface IndexOptions {
  root: string;
  /** Additional ignore glob-ish substrings (matched against relative path). */
  extraIgnore?: string[];
  /** Prior index to reuse hashes from. */
  previous?: RepositoryIndex | null;
  /** gitignore matcher: returns true if the relative path should be ignored. */
  isGitIgnored?: (relPath: string) => boolean;
  /** Whether paths outside root are allowed (default false). */
  allowOutside?: boolean;
  /**
   * When true, read and re-hash every candidate (bytes are the truth). When
   * false (default), a prior file whose mtime and size are both unchanged is
   * reused without reading — a fast path that trusts mtime+size as a
   * correctness signal for the common case.
   */
  verify?: boolean;
}

export interface IndexOutcome {
  index: RepositoryIndex;
  /** Files read+hashed this run (= verifiedFiles). */
  scanned: number;
  /** Files whose symbol/import analysis was reused (hash unchanged or skipped). */
  reused: number;
  skipped: number;
  /** Files whose bytes were read and hashed this run. */
  verifiedFiles: number;
  /** Files whose hash was reused WITHOUT reading (mtime+size unchanged). */
  reusedHashes: number;
}

export async function buildIndex(opts: IndexOptions): Promise<IndexOutcome> {
  const root = resolve(opts.root);
  const files: Record<string, IndexedFile> = {};
  let verifiedFiles = 0;
  let reused = 0;
  let reusedHashes = 0;
  let skipped = 0;

  // Phase 1 walks directories (cheap: readdir + lstat). Phase 2 reads, hashes
  // and analyzes candidate files with bounded concurrency; results are written
  // back by path, so output is independent of completion order.
  const candidates: Array<{ abs: string; rel: string; size: number; mtimeMs: number }> = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..")) {
        skipped++;
        continue;
      }
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      // Do not follow symlinks unless explicitly allowed: a symlinked dir/file
      // could point outside the project root.
      if (st.isSymbolicLink()) {
        if (!opts.allowOutside) {
          skipped++;
          continue;
        }
        try {
          st = await stat(abs); // resolve only when outside access is permitted
        } catch {
          continue;
        }
      }
      if (st.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(name)) continue;
        if (opts.isGitIgnored?.(rel + "/")) continue;
        if (matchesExtra(rel, opts.extraIgnore)) continue;
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;

      if (shouldSkipFile(rel, st.size, opts)) {
        skipped++;
        continue;
      }

      candidates.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const c = candidates[next++]!;
      const prev = opts.previous?.files[c.rel];
      // Fast path: mtime+size are trusted. A prior file whose metadata is
      // unchanged is reused without reading bytes or re-hashing. This is the
      // deliberate tradeoff called out in the module header; `verify: true`
      // disables it so bytes remain the truth.
      if (!opts.verify && prev && prev.mtimeMs === c.mtimeMs && prev.sizeBytes === c.size) {
        files[c.rel] = prev;
        reusedHashes++;
        reused++; // the whole prior IndexedFile (including analysis) is reused
        continue;
      }
      const indexed = await indexOneFile(c.abs, c.rel, c.size, c.mtimeMs, prev);
      if (indexed) {
        files[c.rel] = indexed.file;
        verifiedFiles++;
        if (indexed.reusedAnalysis) reused++;
      } else {
        skipped++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, candidates.length) }, worker));
  // Stable key order regardless of completion order.
  const ordered: Record<string, IndexedFile> = {};
  for (const c of candidates) if (files[c.rel]) ordered[c.rel] = files[c.rel]!;
  for (const key of Object.keys(files)) delete files[key];
  Object.assign(files, ordered);

  const index: RepositoryIndex = {
    version: INDEX_VERSION,
    root,
    generatedAt: new Date().toISOString(),
    files,
    // `verified` is true only when every indexed file had its bytes read and
    // hashed this run. Any mtime+size fast-path reuse marks the generation
    // `unverified` (unverifiedFiles = reusedHashes) so callers can see that the
    // index was not fully proven against current bytes.
    verified: reusedHashes === 0,
    unverifiedFiles: reusedHashes,
  };
  // `scanned` now counts *byte-verified* files (read+hashed this run) and
  // therefore equals `verifiedFiles`. Files served from the mtime+size fast
  // path are counted in `reusedHashes` instead. `reused` remains the count of
  // files whose symbol/import analysis was reused (hash unchanged or skipped
  // without reading).
  return { index, scanned: verifiedFiles, reused, skipped, verifiedFiles, reusedHashes };
}

function shouldSkipFile(rel: string, size: number, opts: IndexOptions): boolean {
  if (isSecretFile(rel)) return true;
  if (size > MAX_FILE_BYTES) return true;
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (BINARY_EXT.has(ext)) return true;
  if (opts.isGitIgnored?.(rel)) return true;
  if (matchesExtra(rel, opts.extraIgnore)) return true;
  return false;
}

function matchesExtra(rel: string, extra?: string[]): boolean {
  if (!extra || !extra.length) return false;
  return extra.some((frag) => rel.includes(frag));
}

async function indexOneFile(
  abs: string,
  rel: string,
  size: number,
  mtimeMs: number,
  previous?: IndexedFile,
): Promise<{ file: IndexedFile; reusedAnalysis: boolean } | null> {
  try {
    const buf = await readFile(abs);
    if (looksBinary(buf)) return null;
    const hash = createHash("sha256").update(buf).digest("hex");
    // Identical bytes => identical analysis. Keyed on the content hash only,
    // so a same-size edit with a restored mtime still gets fresh analysis.
    if (previous && previous.hash === hash && previous.path === rel) {
      return {
        file: { ...previous, sizeBytes: size, estimatedTokens: estimateBytesTokens(size), mtimeMs },
        reusedAnalysis: true,
      };
    }
    const content = buf.toString("utf8");
    const language = detectLanguage(rel);
    const symbols = extractSymbols(content, language);
    const imports = extractImports(content, language, rel);
    return {
      file: {
        path: rel,
        hash,
        sizeBytes: size,
        estimatedTokens: estimateBytesTokens(size),
        language,
        symbols,
        imports,
        indexedAt: new Date().toISOString(),
        mtimeMs,
      },
      reusedAnalysis: false,
    };
  } catch {
    return null;
  }
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
