import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { readJsonlTail, runDiagnostics, sanitizeDiagnostics, safeReadFile, TAIL_BYTE_CAP, formatFreshness, formatHandshake } from "../../packages/core/src/diagnostics/index.ts";
import { status, modernDoctor, doctor, doctorFix, relativeNpxLoader, perClientWiring, setEnabled, setCodeGraphEnabled, hasPluginLoader, HANDSHAKE_SLOW_MS, sanitizeInjectionReason, isAbsoluteServerSpec, pluginLoaderCandidates } from "../../packages/opencode/src/cli-core.ts";
import { stripJsonc } from "../../packages/opencode/src/config-loader.ts";

async function project(): Promise<string> { return mkdtemp(join(tmpdir(), "sc-doctor-")); }
/** Run `fn` with the supplied env overrides restored afterwards. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name); out.push(p); if (entry.isDirectory()) await visit(p);
    }
  }
  await visit(root); return out;
}
async function runScript(script: string, args: string[], root: string): Promise<{ code: number; out: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"), SUPRACORTEX_ROOT: root } });
    let out = ""; child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { out += b; });
    child.on("error", reject); child.on("close", code => resolveResult({ code: code ?? -1, out }));
  });
}

test("A: status and doctor are read-only in a fresh project", async () => {
  const root = await project();
  try { const before = await tree(root); await status(root); await modernDoctor(root); assert.deepEqual(await tree(root), before); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("B: storage and config paths reject traversal and symlinks", async () => {
  const root = await project(); const outside = await project();
  try {
    const cases = ["../outside", join(root, "link")];
    const traversal = await runDiagnostics({ projectRoot: root, config: { storage: { directory: cases[0] } } });
    assert.ok(traversal.some(c => c.status === "fail" && /outside|root/i.test(c.detail)));
    await symlink(outside, join(root, "link"));
    const checks = await runDiagnostics({ projectRoot: root, config: { storage: { directory: "link" } } });
    assert.ok(checks.some(c => c.status === "fail" && /symlink|outside|project/i.test(c.detail)));
    await assert.rejects(() => safeReadFile(root, join(root, "link", "events.jsonl")), /symlink|outside/);
    const cfg = join(root, ".supracortex"); await symlink(outside, cfg);
    await assert.rejects(() => safeReadFile(root, join(cfg, "config.jsonc")), /symlink/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("C: EISDIR and missing reads are explicit failures, not healthy evidence", async () => {
  const root = await project();
  try {
    const storage = join(root, "storage"); await mkdir(join(storage, "events", "events.jsonl"), { recursive: true });
    const checks = await runDiagnostics({ projectRoot: root, config: { storage: { directory: "storage" } } });
    const evidence = checks.find(c => c.id === "storage-evidence"); assert.ok(evidence); assert.equal(evidence.status, "fail"); assert.match(evidence.detail, /read failed/);
    const tail = await readJsonlTail(join(storage, "events")); assert.equal(tail.records.length, 0); assert.ok(tail.error);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("D: JSONL tail is bounded and retains final records", async () => {
  const root = await project(); const file = join(root, "events.jsonl");
  try {
    const line = JSON.stringify({ padding: "x".repeat(3000) }); const final = JSON.stringify({ final: true });
    await writeFile(file, `${line}\n`.repeat(1800) + `${final}\n`.repeat(2100), "utf8");
    const result = await readJsonlTail(file, 2000, root);
    assert.ok((await stat(file)).size > TAIL_BYTE_CAP);
    assert.ok(result.processed <= 2000); assert.ok(result.records.some(r => r.value?.final === true)); assert.ok(!result.records.some(r => r.value?.padding));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("G/I: sanitization removes sensitive paths and secrets while preserving enums", () => {
  const root = "/tmp/project-sensitive"; const home = process.env.HOME ?? "/home/user";
  const secret = "sk-test-recognizable-secret";
  const checks = sanitizeDiagnostics([{ id: "x", title: "X", status: "fail", evidence: "configured", detail: `${root} ${home} /opt/other ${secret}`, data: { nested: { path: root, token: secret } } }], root);
  const text = JSON.stringify(checks); assert.ok(!text.includes(root) && !text.includes(home) && !text.includes("/opt/other") && !text.includes(secret));
  assert.equal(checks[0]?.status, "fail"); assert.equal(checks[0]?.evidence, "configured"); assert.equal(checks[0]?.id, "x");
});

test("F: doctor emits modern checks in text and JSON", async () => {
  const root = await project();
  try {
    const script = resolve("scripts/doctor.ts");
    const text = await runScript(script, [], root); const json = await runScript(script, ["--json"], root);
    assert.equal(text.code, 1); assert.match(text.out, /Environment/); assert.equal(json.code, 1); assert.ok(JSON.parse(json.out).modern.length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("H: status states + STALE + handshake flag + --fix relative npx", async () => {
  const root = await project();
  const fakeHome = await mkdtemp(join(tmpdir(), "doctor-home-"));
  const realHome = process.env.HOME;
  // Isolate the project state machine from the developer's global OpenCode
  // plugin loader; this test specifically models a fresh machine.
  process.env.HOME = fakeHome;
  try {
    // Fresh project: no loader -> config-without-hook, never/never, honest reason.
    const fresh = await status(root);
    assert.equal(fresh.state, "config-without-hook");
    assert.equal(fresh.lastInjectionAt, null);
    assert.equal(fresh.lastSweepAt, null);
    assert.equal(fresh.freshnessHours, null);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.shouldInjectReason, "gate-below-threshold");
    assert.ok(fresh.aliases.length > 0);

    // Loader + disabled -> INSTALLED-but-disabled.
    await mkdir(join(root, ".opencode", "plugins"), { recursive: true });
    await writeFile(join(root, ".opencode", "plugins", "supracortex.ts"), `// supracortex:owned\nexport { SupraCortex } from "file:///tmp/abs/plugin.ts";\n`, "utf8");
    await setEnabled(root, false);
    assert.equal((await status(root)).state, "INSTALLED-but-disabled");

    // Loader + enabled -> ENABLED.
    await setEnabled(root, true);
    assert.equal((await status(root)).state, "ENABLED");

    // STALE: sweep 72h ago surfaces freshness + STALE.
    const ago72h = new Date(Date.now() - 72 * 3_600_000).toISOString();
    await mkdir(join(root, ".supracortex", "state"), { recursive: true });
    await writeFile(join(root, ".supracortex", "state", "health.json"), JSON.stringify({ version: "test", schemaVersion: 1, updatedAt: ago72h, lastSweepAt: ago72h }), "utf8");
    const stale = await status(root);
    assert.equal(stale.lastSweepAt, ago72h);
    assert.ok((stale.freshnessHours ?? 0) >= 48);
    assert.equal(stale.stale, true);
    assert.equal(typeof stale.handshakeDetail, "string");

    // Handshake flag primitives: slow budget + display.
    assert.equal(HANDSHAKE_SLOW_MS, 15_000);
    assert.match(formatFreshness(72), /STALE/);
    assert.equal(formatFreshness(null), "never");
    assert.match(formatHandshake(16_000, true), /slow/);
    assert.match(formatHandshake(12, true), /12ms/);

    // Doctor: per-client [OK]/[MISSING] + smoke + handshake timing present.
    const checks = await doctor(root);
    const names = checks.map((c) => c.name);
    assert.ok(names.includes("MCP handshake"));
    assert.ok(names.includes("smoke context non-empty"));
    assert.ok(names.some((n) => n.startsWith("client ")));
    const hs = checks.find((c) => c.name === "MCP handshake")!;
    assert.match(hs.detail, /ms|timed out|budget|not available|refused|exited|failed|skipped|dev-ts-no-loader/i);
    const opencodeClient = checks.find((c) => c.name === "client opencode")!;
    assert.match(opencodeClient.detail, /\[OK\]/);
    const claudeClient = checks.find((c) => c.name === "client claude")!;
    assert.match(claudeClient.detail, /\[MISSING\]/);

    // --fix: owned absolute file:// loader rewritten to relative npx.
    assert.ok(perClientWiring(root).some((e) => e.client === "opencode"));
    assert.ok(!relativeNpxLoader("v1").includes("file://"));
    const fix = await doctorFix(root);
    const loader = await readFile(join(root, ".opencode", "plugins", "supracortex.ts"), "utf8");
    assert.ok(!loader.includes("file://"));
    assert.ok(loader.includes("supracortex/opencode"));
    assert.ok(fix.fixed.length > 0);
    assert.equal(fix.green, fix.durationMs <= fix.budgetMs);
    assert.equal((await status(root)).state, "ENABLED");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    await rm(root, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("J: status fast by default, reason validated, win-path + backup capped, dev handshake skipped", async () => {
  const root = await project();
  try {
    // Fast path: default status never spawns (null + skipped note).
    const t0 = Date.now();
    const s = await status(root);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(s.handshakeMs, null);
    assert.equal(s.handshakeSlow, false);
    assert.match(s.handshakeDetail, /skipped/);

    // Reason closed-set + sanitized.
    assert.equal(sanitizeInjectionReason("injected"), "injected");
    assert.equal(sanitizeInjectionReason("bogus"), "gate-below-threshold");
    assert.equal(sanitizeInjectionReason("\x1b[31mnope\n"), "gate-below-threshold");
    await mkdir(join(root, ".supracortex", "state"), { recursive: true });
    await writeFile(join(root, ".supracortex", "state", "injection.json"), JSON.stringify({ lastSkipReason: "evil\nreason" }), "utf8");
    assert.equal((await status(root)).shouldInjectReason, "gate-below-threshold");

    // Windows absolute check works on raw spec strings.
    assert.ok(isAbsoluteServerSpec("C:\\proj\\cli.mcp"));
    assert.ok(isAbsoluteServerSpec({ command: ["C:\\x\\y"] }));
    assert.ok(!isAbsoluteServerSpec({ command: ["npx", "supracortex", "mcp"] }));

    // Backup capped: single .bak reuse, no timestamped litter.
    await writeFile(join(root, "opencode.json"), "{}", "utf8");
    await mkdir(join(root, ".opencode", "plugins"), { recursive: true });
    await writeFile(join(root, ".opencode", "plugins", "supracortex.ts"), "// supracortex:owned\nold loader\n", "utf8");
    await doctorFix(root); await doctorFix(root);
    const tree: string[] = [];
    async function visit(d: string): Promise<void> {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name); tree.push(p);
        if (e.isDirectory()) await visit(p);
      }
    }
    await visit(root);
    assert.ok(!tree.some((n) => n.includes(".ci-backup-")));
    assert.ok(tree.some((n) => n.endsWith(".bak")));

    // Dev handshake: source .ts launcher skips (not failed); doctor still measures.
    const checks = await doctor(root);
    const hs = checks.find((c) => c.name === "MCP handshake")!;
    assert.match(hs.detail, /ms|timed out|budget|not available|refused|exited|failed|skipped|dev-ts-no-loader/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("K: profile-only loader is detected by status and doctor", async () => {
  const root = await project();
  const scratch = await mkdtemp(join(tmpdir(), "doctor-profile-"));
  const supracodeHome = join(scratch, "supracode");
  const loader = join(supracodeHome, "opencode", "plugins", "supracortex.ts");
  try {
    await mkdir(join(supracodeHome, "opencode", "plugins"), { recursive: true });
    await writeFile(loader, "// supracortex:owned\nexport { SupraCortex } from \"file:///tmp/abs/plugin.ts\";\n", "utf8");
    await withEnv(
      {
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "xdg"),
        SUPRACODE_HOME: supracodeHome,
        SUPRACODE_REAL_XDG_CONFIG_HOME: undefined,
      },
      async () => {
        await setEnabled(root, true);
        const report = await status(root);
        assert.equal(report.state, "ENABLED");
        const checks = await doctor(root);
        const entry = checks.find((c) => c.name === "plugin entry")!;
        assert.equal(entry.ok, true);
        assert.equal(entry.detail, `${loader} (global)`);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("L: project-local loader still wins over a profile loader", async () => {
  const root = await project();
  const scratch = await mkdtemp(join(tmpdir(), "doctor-precedence-"));
  const supracodeHome = join(scratch, "supracode");
  const profileLoader = join(supracodeHome, "opencode", "plugins", "supracortex.ts");
  const localLoader = join(root, ".opencode", "plugins", "supracortex.ts");
  try {
    await mkdir(join(root, ".opencode", "plugins"), { recursive: true });
    await writeFile(localLoader, "// supracortex:owned\nlocal loader\n", "utf8");
    await mkdir(join(supracodeHome, "opencode", "plugins"), { recursive: true });
    await writeFile(profileLoader, "// supracortex:owned\nprofile loader\n", "utf8");
    await withEnv(
      {
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "xdg"),
        SUPRACODE_HOME: supracodeHome,
        SUPRACODE_REAL_XDG_CONFIG_HOME: undefined,
      },
      async () => {
        assert.equal((await status(root)).state, "ENABLED");
        const entry = (await doctor(root)).find((c) => c.name === "plugin entry")!;
        assert.equal(entry.ok, true);
        assert.equal(entry.detail, localLoader);
        assert.ok(!entry.detail.includes(supracodeHome));
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("M: no loader anywhere reports config-without-hook", async () => {
  const root = await project();
  const scratch = await mkdtemp(join(tmpdir(), "doctor-noloader-"));
  try {
    await withEnv(
      {
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "xdg"),
        SUPRACODE_HOME: join(scratch, "supracode"),
        SUPRACODE_REAL_XDG_CONFIG_HOME: undefined,
      },
      async () => {
        assert.equal((await status(root)).state, "config-without-hook");
        const entry = (await doctor(root)).find((c) => c.name === "plugin entry")!;
        assert.equal(entry.ok, false);
        assert.match(entry.detail, /\(missing\)$/);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("N: pluginLoaderCandidates resolves env-derived paths in precedence order", () => {
  const root = join(tmpdir(), "sc-candidates-project");
  const home = join(tmpdir(), "sc-candidates-home");
  const candidates = pluginLoaderCandidates(root, { HOME: home });
  assert.deepEqual(candidates, [
    join(root, ".opencode", "plugins", "supracortex.ts"),
    join(home, ".config", "supracode", "opencode", "plugins", "supracortex.ts"),
    join(home, ".config", "opencode", "plugins", "supracortex.ts"),
  ]);
  assert.equal(new Set(candidates).size, candidates.length);
});

test("O: stock loader does not masquerade when the active profile exists", async () => {
  const root = await project();
  const scratch = await mkdtemp(join(tmpdir(), "doctor-stock-loader-"));
  try {
    // Stock OpenCode carries a stale loader...
    const stockHome = join(scratch, "xdg");
    await mkdir(join(stockHome, "opencode", "plugins"), { recursive: true });
    await writeFile(join(stockHome, "opencode", "plugins", "supracortex.ts"), "// supracortex:owned\nstock loader\n", "utf8");
    // ...but the SupraCode profile config dir exists and has no loader.
    await mkdir(join(scratch, "supracode", "opencode"), { recursive: true });

    await withEnv(
      {
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: stockHome,
        SUPRACODE_HOME: join(scratch, "supracode"),
        SUPRACODE_REAL_XDG_CONFIG_HOME: undefined,
      },
      async () => {
        const report = await status(root);
        assert.notEqual(report.state, "ENABLED");
        assert.equal(report.state, "config-without-hook");
        const entry = (await doctor(root)).find((c) => c.name === "plugin entry")!;
        assert.equal(entry.ok, false);
        assert.match(entry.detail, /\(missing\)$/);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("P: status purges a legacy injection mirror with an escaped NUL", async () => {
  const root = await project();
  const scratch = await mkdtemp(join(tmpdir(), "doctor-legacy-mirror-"));
  const file = join(root, ".supracortex", "state", "injection.json");
  try {
    await mkdir(join(root, ".supracortex", "state"), { recursive: true });
    // JSON.stringify emits the six-character `\u0000` escape for the embedded
    // NUL, so this file parses but still carries prompt-bearing text.
    await writeFile(file, JSON.stringify({ lastInjectionAt: "2026-10-17T00:00:00.000Z", requestId: "session\u0000query" }), "utf8");
    assert.match(await readFile(file, "utf8"), /\\u0000/);

    await withEnv(
      {
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "xdg"),
        SUPRACODE_HOME: join(scratch, "supracode"),
        SUPRACODE_REAL_XDG_CONFIG_HOME: undefined,
      },
      async () => {
        await status(root);
      },
    );
    await assert.rejects(access(file), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Q: doctor fails the storage check and does not purge through a symlinked storage root", async () => {
  const root = await project();
  const outside = await project();
  const scratch = await mkdtemp(join(tmpdir(), "doctor-symlink-storage-"));
  try {
    await mkdir(join(outside, "state"), { recursive: true });
    const mirror = join(outside, "state", "injection.json");
    await writeFile(mirror, JSON.stringify({ lastInjectionAt: "2026-10-17T00:00:00.000Z", requestId: "session\u0000query" }), "utf8");
    assert.match(await readFile(mirror, "utf8"), /\\u0000/);
    await symlink(outside, join(root, ".supracortex"));

    await withEnv(
      {
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "xdg"),
        SUPRACODE_HOME: join(scratch, "supracode"),
        SUPRACODE_REAL_XDG_CONFIG_HOME: undefined,
      },
      async () => {
        const checks = await doctor(root);
        const storage = checks.find((c) => c.name === "storage writable");
        assert.ok(storage, "storage check present");
        assert.equal(storage.ok, false);
        assert.match(storage.detail, /containment|outside|symlink/i);
      },
    );

    assert.match(await readFile(mirror, "utf8"), /\\u0000/);
    await assert.rejects(access(join(outside, ".gitignore")), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("R: setCodeGraphEnabled writes an explicit automaticContext in the central config", async () => {
  const root = await project();
  const scratch = await mkdtemp(join(tmpdir(), "doctor-graph-toggle-"));
  const centralHome = join(scratch, "central");
  try {
    await withEnv(
      {
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: join(scratch, "xdg"),
        SUPRACODE_HOME: join(scratch, "supracode"),
        SUPRACODE_REAL_XDG_CONFIG_HOME: centralHome,
      },
      async () => {
        const cfgPath = join(centralHome, "supracortex", "config.jsonc");
        // Seed the override that enabling removes (the delete edit needs an
        // existing graph object).
        await mkdir(dirname(cfgPath), { recursive: true });
        await writeFile(cfgPath, JSON.stringify({ graph: { enabled: false } }), "utf8");

        await setCodeGraphEnabled(root, true, true);
        const enabled = JSON.parse(stripJsonc(await readFile(cfgPath, "utf8")));
        assert.equal(enabled.graph?.automaticContext, true);
        assert.equal(enabled.graph?.enabled, true, "enable writes an explicit true");

        await setCodeGraphEnabled(root, true, false);
        const disabled = JSON.parse(stripJsonc(await readFile(cfgPath, "utf8")));
        assert.equal(disabled.graph?.automaticContext, false);
        assert.equal(disabled.graph?.enabled, true);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("S: loader detection includes the profile path when it equals the stock config root", async () => {
  const root = await project();
  const scratch = await mkdtemp(join(tmpdir(), "doctor-equal-loader-"));
  try {
    // SUPRACODE_HOME === XDG_CONFIG_HOME makes profile and stock coincide.
    const configHome = join(scratch, "xdg");
    const loader = join(configHome, "opencode", "plugins", "supracortex.ts");
    await mkdir(dirname(loader), { recursive: true });
    await writeFile(loader, "// supracortex:owned\nstock-or-profile loader\n", "utf8");

    await withEnv(
      {
        HOME: join(scratch, "home"),
        XDG_CONFIG_HOME: configHome,
        SUPRACODE_HOME: configHome,
        SUPRACODE_REAL_XDG_CONFIG_HOME: undefined,
      },
      async () => {
        const candidates = pluginLoaderCandidates(root);
        assert.equal(candidates.filter((c) => c === loader).length, 1, "emitted exactly once");
        assert.equal(await hasPluginLoader(root), true);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
