import test from "node:test";
import assert from "node:assert";
import { mkdtemp, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../../packages/core/src/index.ts";

test("same-size edit with restored mtime receives a new verified hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-index-"));
  await mkdir(join(root, "src"));
  const file = join(root, "src/a.ts");
  await writeFile(file, "export const value = 1;\n");
  const first = await buildIndex({ root });
  const before = await stat(file);
  await writeFile(file, "export const value = 2;\n");
  await utimes(file, before.atime, before.mtime);
  // Bytes are the truth only when verification is demanded.
  const second = await buildIndex({ root, previous: first.index, verify: true });
  assert.notEqual(second.index.files["src/a.ts"]?.hash, first.index.files["src/a.ts"]?.hash);
  assert.equal(second.reused, 0);
  assert.equal(second.verifiedFiles, 1);
  assert.equal(second.reusedHashes, 0);
  assert.equal(second.index.verified, true);
});

test("unchanged mtime+size with verify:false reuses the hash without reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-index-fast-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "export function alpha() {}\n");
  await writeFile(join(root, "src/b.ts"), "export function beta() {}\n");
  const first = await buildIndex({ root });
  assert.equal(first.index.verified, true, "a cold build reads every byte");
  const second = await buildIndex({ root, previous: first.index }); // verify defaults to false
  assert.equal(second.reusedHashes, 2, "both files served from the mtime+size fast path");
  assert.equal(second.verifiedFiles, 0, "no bytes were read");
  assert.equal(second.scanned, 0, "scanned now means read+hashed");
  assert.equal(second.index.verified, false);
  assert.equal(second.index.unverifiedFiles, 2);
  // The whole prior IndexedFile is reused, so analysis is byte-identical.
  assert.deepEqual(second.index.files, first.index.files);
});

test("unchanged bytes reuse analysis; changed bytes are re-analyzed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-index-reuse-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "export function alpha() {}\n");
  await writeFile(join(root, "src/b.ts"), "export function beta() {}\n");
  const first = await buildIndex({ root });
  assert.equal(first.reused, 0);
  // verify:true forces a byte read so hash-based analysis reuse is exercised.
  const second = await buildIndex({ root, previous: first.index, verify: true });
  assert.equal(second.reused, 2);
  assert.equal(second.scanned, 2, "verify:true byte-verifies every file");
  await writeFile(join(root, "src/b.ts"), "export function gamma() {}\n");
  const third = await buildIndex({ root, previous: second.index, verify: true });
  assert.equal(third.reused, 1);
  assert.deepEqual(third.index.files["src/b.ts"]?.symbols, ["gamma"]);
  assert.deepEqual(Object.keys(third.index.files), Object.keys(first.index.files), "stable key order");
});
