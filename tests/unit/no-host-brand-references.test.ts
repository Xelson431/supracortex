/**
 * Guard: the public product must not reference the removed third-party host
 * integration. The needles are assembled at runtime so this guard itself does
 * not contain the literal strings it searches for.
 *
 * Skips when the repository source tree is absent (packed/installed layout).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const chars = (...codes: number[]): string => String.fromCharCode(...codes);
const NEEDLES = [
  `${chars(111, 109, 111)}-${chars(115, 108, 105, 109)}`,
  `oh-my-${chars(111, 112, 101, 110, 99, 111, 100, 101)}`,
];
const EXTENSIONS = new Set([".ts", ".md", ".json", ".jsonc", ".sh"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".supracortex"]);

async function collectFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
      out.push(join(dir, entry.name));
    }
  }
}

test("source tree contains no removed host-integration references", async (t) => {
  if (!existsSync(join(repoRoot, "packages"))) {
    t.skip("repository source tree not present (packed install)");
    return;
  }
  const files: string[] = [];
  for (const dir of ["packages", "src", "scripts", "templates", "tests"]) {
    await collectFiles(join(repoRoot, dir), files);
  }
  files.push(join(repoRoot, "package.json"));

  const hits: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = (await readFile(file, "utf8")).toLowerCase();
    } catch {
      continue;
    }
    for (const needle of NEEDLES) {
      if (text.includes(needle)) {
        hits.push(`${file.slice(repoRoot.length + 1)}: ${needle}`);
      }
    }
  }
  assert.deepEqual(hits, [], `unexpected host-integration references:\n${hits.join("\n")}`);
});
