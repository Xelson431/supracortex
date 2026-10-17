import test from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Only OS-level variables cross into subprocesses. Nothing from the invoking
 * shell (SUPRACODE*, SUPRACORTEX_*, HOME, XDG_*, config paths, credentials) is
 * inherited, so a developer/VPS environment cannot contaminate the gate.
 */
function osEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "windir", "PATHEXT", "ComSpec"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

interface Scratch {
  /** Base dir deliberately contains a space to prove end-to-end quoting. */
  base: string;
  home: string;
  project: string;
  npmCache: string;
  xdgConfig: string;
  xdgState: string;
  xdgData: string;
  xdgCache: string;
  tmp: string;
}

async function makeScratch(): Promise<Scratch> {
  const base = await mkdtemp(join(tmpdir(), "sc e2e "));
  const scratch: Scratch = {
    base,
    home: join(base, "home"),
    project: join(base, "project"),
    npmCache: join(base, "npm-cache"),
    xdgConfig: join(base, "xdg-config"),
    xdgState: join(base, "xdg-state"),
    xdgData: join(base, "xdg-data"),
    xdgCache: join(base, "xdg-cache"),
    tmp: join(base, "tmp"),
  };
  for (const dir of [
    scratch.home,
    scratch.project,
    scratch.npmCache,
    scratch.xdgConfig,
    scratch.xdgState,
    scratch.xdgData,
    scratch.xdgCache,
    scratch.tmp,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    join(scratch.project, "package.json"),
    JSON.stringify({ name: "e2e", private: true }) + "\n",
    "utf8",
  );
  return scratch;
}

/** Fully isolated child environment: scratch HOME/XDG/caches, no inherited overrides. */
function childEnv(scratch: Scratch): NodeJS.ProcessEnv {
  return {
    ...osEnv(),
    HOME: scratch.home,
    USERPROFILE: scratch.home,
    XDG_CONFIG_HOME: scratch.xdgConfig,
    XDG_STATE_HOME: scratch.xdgState,
    XDG_DATA_HOME: scratch.xdgData,
    XDG_CACHE_HOME: scratch.xdgCache,
    TMPDIR: scratch.tmp,
    TEMP: scratch.tmp,
    TMP: scratch.tmp,
    npm_config_cache: scratch.npmCache,
  };
}

/**
 * Resolve the artifact under test: an explicitly supplied path, or a fresh
 * build+pack. A root `*.tgz` is never discovered implicitly, so a stale/leftover
 * archive can never be silently chosen.
 */
async function resolveTarball(scratch: Scratch, cleanupDirs: string[]): Promise<string> {
  const explicit = process.env.SUPRACORTEX_E2E_TARBALL?.trim();
  if (explicit) {
    const abs = resolve(explicit);
    await stat(abs); // absent explicit artifact is a hard failure, never a fallback
    return abs;
  }
  const out = await mkdtemp(join(tmpdir(), "sc-pack-"));
  cleanupDirs.push(out);
  await run(process.execPath, ["scripts/build.ts"], { cwd: repoRoot, timeout: 120_000, env: childEnv(scratch) });
  const packed = await run(npmBin, ["pack", "--json", "--pack-destination", out], {
    cwd: repoRoot,
    timeout: 120_000,
    env: childEnv(scratch),
  });
  const rows = JSON.parse(packed.stdout) as Array<{ filename?: string }>;
  const filename = rows[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a tarball filename");
  return join(out, filename);
}

function specOf(p: unknown): string {
  return String(Array.isArray(p) ? p[0] : p);
}

/**
 * Extract local relative markdown link targets. Remote URLs, protocol URLs,
 * anchors and glob patterns are intentionally ignored.
 */
function localMarkdownTargets(markdown: string): string[] {
  const targets = new Set<string>();
  const pattern = /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (let match = pattern.exec(markdown); match; match = pattern.exec(markdown)) {
    const target = (match[1] ?? match[2] ?? "").trim();
    if (!target || target.startsWith("#") || target.startsWith("//")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:, ...
    const hashless = target.split("#")[0]!;
    const relativePath = hashless.split("?")[0]!;
    if (!relativePath || relativePath.startsWith("/")) continue;
    if (/[*?\[\]]/.test(relativePath)) continue; // glob, not a concrete file
    try {
      targets.add(decodeURIComponent(relativePath));
    } catch {
      targets.add(relativePath);
    }
  }
  return [...targets];
}

test("isolated packed-artifact install gate (CLI + TUI + profile + MCP)", async (t) => {
  // Installs dependencies from the registry, so it is an explicit release/CI
  // gate, not an ambient developer-unit-test side effect.
  if (process.env.SUPRACORTEX_E2E !== "1") {
    t.skip("set SUPRACORTEX_E2E=1 to run the isolated packed-artifact install gate");
    return;
  }

  const scratch = await makeScratch();
  const cleanupDirs: string[] = [scratch.base];
  let transport: StdioClientTransport | null = null;
  t.after(async () => {
    if (transport) {
      try { await transport.close(); } catch { /* already closed */ }
      transport = null;
    }
    for (const dir of cleanupDirs) {
      try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  const tarball = await resolveTarball(scratch, cleanupDirs);
  const env = childEnv(scratch);
  const installedPkg = join(scratch.project, "node_modules", "supracortex");
  const cli = join(installedPkg, "dist", "cli.js");
  const profileDir = join(scratch.home, ".config", "supracode", "opencode");

  await run(npmBin, ["install", tarball, "--no-audit", "--no-fund"], {
    cwd: scratch.project,
    timeout: 180_000,
    env,
  });

  await t.test("installed artifact ships CLI, API types, Pi extension and TUI bundles", async () => {
    for (const rel of [
      "dist/cli.js",
      "dist/mcp.js",
      "dist/pi-extension.js",
      "dist/types/src/api.d.ts",
      "dist/types/src/protocol.d.ts",
      "packages/tui/package.json",
      "packages/tui/dist/tui.js",
      "packages/tui/dist/tui-v2.js",
    ]) {
      await stat(join(installedPkg, rel));
    }
    // The OpenCode adapter imports `@opencode-ai/plugin/tool` at runtime; the
    // host supplies it. It is declared as an optional peer (pinned to the
    // in-repo version), never bundled.
    const manifest = JSON.parse(await readFile(join(installedPkg, "package.json"), "utf8")) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    assert.equal(manifest.peerDependencies?.["@opencode-ai/plugin"], "1.18.32");
    assert.equal(manifest.peerDependenciesMeta?.["@opencode-ai/plugin"]?.optional, true);
  });

  await t.test("installed artifact ships required docs and excludes repository source trees", async () => {
    for (const rel of [
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "COMPATIBILITY.md",
      "INSTALL.md",
      "MCP_PROTOCOL.md",
    ]) {
      await stat(join(installedPkg, rel));
    }

    for (const rel of ["tests", "benchmarks", "src"]) {
      await assert.rejects(
        stat(join(installedPkg, rel)),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        `artifact unexpectedly ships ${rel}/`,
      );
    }

    // Every relative link in the installed README that points at a file in this
    // checkout must also resolve inside the installed artifact. A genuinely
    // unshipped target fails loudly so the shipping decision is explicit.
    const readme = await readFile(join(installedPkg, "README.md"), "utf8");
    const missing: string[] = [];
    for (const target of localMarkdownTargets(readme)) {
      const repoPath = resolve(repoRoot, target);
      if (repoPath !== repoRoot && !repoPath.startsWith(repoRoot + sep)) continue;
      let repoEntry: Awaited<ReturnType<typeof stat>>;
      try {
        repoEntry = await stat(repoPath);
      } catch {
        continue; // not a file present in this repo
      }
      if (!repoEntry.isFile()) continue;
      try {
        await stat(resolve(installedPkg, target));
      } catch {
        missing.push(target);
      }
    }
    assert.deepStrictEqual(
      missing.sort(),
      [],
      `installed README links to repository files that are not shipped:\n${missing.join("\n")}`,
    );
  });

  await t.test("installed CLI reports its version", async () => {
    const version = await run(process.execPath, [cli, "version"], { cwd: scratch.project, env });
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  await t.test("host-independent server adapters import; UI runtime is not imported", async () => {
    // Import host-independent JS server adapters from the installed artifact to
    // expose missing runtime deps. The OpenCode adapter and TUI bundles need the
    // host-provided UI runtime and are deliberately not imported here.
    const probePath = join(scratch.project, "probe.mjs");
    await writeFile(
      probePath,
      `const out = {};\n` +
        `for (const spec of ["supracortex", "supracortex/protocol", "supracortex/mcp"]) {\n` +
        `  try { await import(spec); out[spec] = "ok"; }\n` +
        `  catch (e) { out[spec] = "fail:" + String(e.message).split("\\n")[0]; }\n` +
        `}\n` +
        `try { await import("supracortex/opencode"); out["supracortex/opencode"] = "ok"; }\n` +
        `catch (e) { out["supracortex/opencode"] = "fail:" + String(e.message).split("\\n")[0]; }\n` +
        `console.log(JSON.stringify(out));\n`,
      "utf8",
    );
    const probe = await run(process.execPath, [probePath], { cwd: scratch.project, env });
    const out = JSON.parse(probe.stdout.trim()) as Record<string, string>;
    assert.equal(out["supracortex"], "ok");
    assert.equal(out["supracortex/protocol"], "ok");
    assert.equal(out["supracortex/mcp"], "ok");
    // Without the host SDK the OpenCode adapter cannot resolve its external
    // import; if it does resolve, that is fine too. Either way the peer is declared.
    if (out["supracortex/opencode"] !== "ok") {
      assert.match(out["supracortex/opencode"]!, /@opencode-ai\/plugin/);
    }
  });

  await t.test("profile init generates paths under the installed artifact", async () => {
    await run(process.execPath, [cli, "profile", "init"], { cwd: scratch.project, env });

    const tui = JSON.parse(await readFile(join(profileDir, "tui.json"), "utf8")) as { plugin?: unknown[] };
    const specs = (tui.plugin ?? []).map(specOf);
    const brand = specs.find((s) => s.includes("node_modules") && s.endsWith(join("supracortex", "packages", "tui")));
    assert.ok(brand, "tui.json points at the installed brand TUI package dir");
    assert.ok(brand!.startsWith(installedPkg), "brand TUI path lives under the installed artifact");
    assert.ok(!brand!.startsWith(repoRoot), "brand TUI path is not the source checkout");
    await stat(join(brand!, "package.json"));
    await stat(join(brand!, "dist", "tui.js"));
    await stat(join(brand!, "dist", "tui-v2.js"));

    const loader = await readFile(join(profileDir, "plugins", "supracortex.ts"), "utf8");
    const bundleMatch = loader.match(/const bundle = "file:\/\/([^"]+)";/);
    assert.ok(bundleMatch, "loader references a plugin bundle");
    const bundlePath = bundleMatch![1]!;
    assert.ok(bundlePath.startsWith(installedPkg), "plugin bundle lives under the installed artifact");
    assert.ok(!bundlePath.startsWith(repoRoot), "plugin bundle is not the source checkout");
    await stat(bundlePath);

    await stat(join(profileDir, "commands", "cortex-status.md"));
    await stat(join(profileDir, "skills", "supracortex", "SKILL.md"));
  });

  await t.test("repeat global install preserves a user sentinel and V2 refs resolve", async () => {
    const tuiPath = join(profileDir, "tui.json");
    const tuiDoc = JSON.parse(await readFile(tuiPath, "utf8")) as { plugin: unknown[]; userSentinel?: boolean };
    tuiDoc.plugin.push("/sentinel/user-tui");
    tuiDoc.userSentinel = true;
    await writeFile(tuiPath, JSON.stringify(tuiDoc, null, 2) + "\n", "utf8");

    const opencodePath = join(profileDir, "opencode.json");
    const opencode = JSON.parse(await readFile(opencodePath, "utf8")) as Record<string, unknown>;
    opencode.userSentinel = "keep-me";
    await writeFile(opencodePath, JSON.stringify(opencode, null, 2) + "\n", "utf8");

    // Isolated global install; ensureProfile runs again, so a second pass is a
    // genuine repeat install over existing user-owned files.
    await run(process.execPath, [cli, "install", "--global", "--yes"], {
      cwd: scratch.project,
      timeout: 120_000,
      env,
    });

    const tuiAfter = JSON.parse(await readFile(tuiPath, "utf8")) as { plugin: unknown[]; userSentinel?: boolean };
    assert.ok(tuiAfter.plugin.map(specOf).includes("/sentinel/user-tui"), "user TUI plugin preserved");
    assert.equal(tuiAfter.userSentinel, true, "user TUI key preserved");
    const brandCount = tuiAfter.plugin.map(specOf).filter((s) => s.includes(join("supracortex", "packages", "tui"))).length;
    assert.equal(brandCount, 1, "exactly one brand TUI entry after repeat install");
    const opencodeAfter = JSON.parse(await readFile(opencodePath, "utf8")) as Record<string, unknown>;
    assert.equal(opencodeAfter.userSentinel, "keep-me", "user opencode.json key preserved");

    await stat(join(scratch.home, ".config", "supracortex", "config.jsonc"));
    const v2Index = join(scratch.home, ".config", "supracode2", "plugins", "supracode-v2", "index.ts");
    const v2Tui = join(scratch.home, ".config", "supracode2", "plugins", "supracode-v2", "tui.ts");
    const adapter = (await readFile(v2Index, "utf8")).match(/const adapter = "([^"]+)";/)?.[1];
    assert.ok(adapter, "V2 loader references the adapter bundle");
    assert.ok(adapter!.startsWith(installedPkg), "V2 adapter lives under the installed artifact");
    await stat(adapter!);
    const v2TuiBundle = (await readFile(v2Tui, "utf8")).match(/from "([^"]+)"/)?.[1];
    assert.ok(v2TuiBundle, "V2 TUI loader references the TUI bundle");
    assert.ok(v2TuiBundle!.startsWith(installedPkg), "V2 TUI bundle lives under the installed artifact");
    await stat(v2TuiBundle!);
  });

  await t.test("public MCP entry answers over real SDK stdio", async () => {
    let command: string;
    let args: string[];
    if (process.platform === "win32") {
      // The public supracortex-mcp / supracode launchers are POSIX bash scripts
      // and are unsupported on Windows; exercise the Node MCP entry directly.
      command = process.execPath;
      args = [cli, "mcp"];
    } else {
      command = join(scratch.project, "node_modules", ".bin", "supracortex-mcp");
      args = [];
    }
    transport = new StdioClientTransport({
      command,
      args,
      cwd: scratch.project,
      env: { ...env, SUPRACORTEX_ROOT: scratch.project },
    });
    const client = new Client({ name: "e2e", version: "0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((tl) => tl.name);
      assert.ok(names.includes("cortex_context"), "cortex_context advertised");
      assert.ok(names.includes("cortex_status"), "cortex_status advertised");
      const status = (await client.callTool({ name: "cortex_status", arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(status.content[0]!.text) as { protocolVersion?: string };
      assert.ok(payload.protocolVersion, "status reports a protocol version");
    } finally {
      await client.close();
      transport = null;
    }
  });
});
