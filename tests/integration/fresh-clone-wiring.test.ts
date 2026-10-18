/**
 * Fresh-clone wiring safety. `dist/` is gitignored and only appears after
 * `pnpm build`, so `supracode install` / `supracode connect` can run from a
 * clean checkout with no build. The MCP launch command those paths bake into
 * Codex/Claude/generic configs runs under the documented Node minimum
 * (>=22.6, see scripts/launcher-common.sh), which cannot execute TypeScript
 * unless type stripping is explicitly enabled.
 *
 * The fix: a fresh checkout falls back to `scripts/cli.ts` WITH
 * `--experimental-strip-types` (accepted by Node 22.6+ for this file), never a
 * bare `.ts` path that crashes on Node 22. We import a throwaway copy of the
 * adapter whose packageRoot() has no `dist/` and assert the emitted command is
 * the runnable flagged form. Real host CLIs are never invoked; HOME is a
 * scratch directory.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const linkType = process.platform === "win32" ? "junction" : "dir";
const builtCli = join(repoRoot, "dist", "cli.js");

type ConnectFn = (host: string, opts?: { env?: NodeJS.ProcessEnv }) => Promise<{ ok: boolean; action: string; detail: string }>;

/** A source-only copy of the adapter: `packageRoot()` resolves to the copy, and
 * `dist/` is absent but `scripts/cli.ts` exists. node_modules is reused via
 * links so no install is needed. */
async function makeFreshClone(): Promise<{ dir: string; connect: ConnectFn; genericSnippet: () => string }> {
  const dir = await mkdtemp(join(tmpdir(), "sc-fresh-clone-"));
  // Guarantee the marker packageRoot() walks up to.
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "supracortex", type: "module" }));
  const srcDir = join(dir, "packages", "opencode", "src");
  await mkdir(srcDir, { recursive: true });
  await cp(join(repoRoot, "packages", "opencode", "src"), srcDir, { recursive: true });
  // The source entry the fallback needs; present on every real checkout.
  await cp(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });
  await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"), linkType);
  await mkdir(join(dir, "packages", "opencode"), { recursive: true });
  await symlink(join(repoRoot, "packages", "opencode", "node_modules"), join(dir, "packages", "opencode", "node_modules"), linkType);
  const mod = (await import(pathToFileURL(join(srcDir, "connect.ts")).href)) as {
    connect: ConnectFn;
    genericSnippet: () => string;
  };
  return { dir, connect: mod.connect, genericSnippet: mod.genericSnippet };
}

/** Run `fn` with SUPRACORTEX_MCP_BIN forced to "" (no stable shim) and restore it. */
async function withoutShim<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.SUPRACORTEX_MCP_BIN;
  process.env.SUPRACORTEX_MCP_BIN = "";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SUPRACORTEX_MCP_BIN;
    else process.env.SUPRACORTEX_MCP_BIN = prev;
  }
}

test("fresh clone (no dist): wiring emits a runnable --experimental-strip-types command", async () => {
  const clone = await makeFreshClone();
  try {
    assert.equal(existsSync(join(clone.dir, "dist", "cli.js")), false, "temp copy must have no dist");
    const sourceEntry = join(clone.dir, "scripts", "cli.ts");
    assert.equal(existsSync(sourceEntry), true, "temp copy must have scripts/cli.ts");
    // Node resolves the imported module through the filesystem's canonical
    // path (macOS: /var/folders/... -> /private/var/folders/...), so the
    // emitted args are canonical even though mkdtemp() hands us a symlinked
    // form. Compare exact canonical paths on both sides rather than relaxing
    // to a basename/substring match that could point at a different file.
    const canonicalSourceEntry = await realpath(sourceEntry);

    // generic host: no throw, and the command must carry the strip-types flag.
    const snippet = await withoutShim(() => JSON.parse(clone.genericSnippet()).mcpServers.supracortex);
    assert.equal(snippet.type, "stdio");
    assert.deepEqual(snippet.args, ["--experimental-strip-types", canonicalSourceEntry, "mcp"]);
    // The original bug was a bare `.ts` path with no flag.
    assert.equal(snippet.args[0], "--experimental-strip-types");
    assert.match(snippet.args[1], /cli\.ts$/);

    // codex host: connect must succeed and persist the same runnable command.
    const r = await withoutShim(() => clone.connect("codex", { env: { ...process.env, HOME: clone.dir } }));
    assert.equal(r.ok, true);
    const toml = await readFile(join(clone.dir, ".codex", "config.toml"), "utf8");
    assert.match(toml, /--experimental-strip-types/, "codex config carries the flag");
    assert.ok(toml.includes(canonicalSourceEntry), "codex config points at scripts/cli.ts");
  } finally {
    await rm(clone.dir, { recursive: true, force: true });
  }
});

test("built tree: the MCP command points at the compiled dist entry", { skip: !existsSync(builtCli) }, async () => {
  const { genericSnippet } = (await import("../../packages/opencode/src/connect.ts")) as { genericSnippet: () => string };
  const snippet = JSON.parse(await withoutShim(() => genericSnippet())).mcpServers.supracortex;
  assert.deepEqual(snippet.args, [builtCli, "mcp"], "built checkouts keep using dist/cli.js");
});
