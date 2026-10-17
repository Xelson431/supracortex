/**
 * Live host compatibility: drives the real `claude` / `codex` CLIs against the
 * built MCP entry and verifies a real stdio handshake with `dist/cli.js mcp`.
 *
 * Opt-in and hermetic:
 *  - skipped unless SUPRACORTEX_LIVE_HOSTS=1 and the platform is not win32;
 *  - each child gets a throwaway HOME/XDG/CLAUDE_CONFIG_DIR/CODEX_HOME and a
 *    temp cwd, and inherits only OS-level variables (never the caller's config
 *    paths);
 *  - no network: decision-provider warmup is disabled and only local stdio
 *    processes are spawned.
 *
 * The add/list/remove commands intentionally mutate only the temp host config.
 * The real `~/.claude.json` and `~/.codex/config.toml` are stat-snapshotted
 * before each test and must be byte-for-byte untouched (same mtime) after it.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ExecFileOptions } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MCP_ENTRY = join(REPO_ROOT, "dist", "cli.js");
const NODE = process.execPath;
const HAS_DIST = existsSync(MCP_ENTRY);
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

const SUITE_SKIP =
  process.platform === "win32"
    ? "live host checks run only on linux/macOS"
    : process.env.SUPRACORTEX_LIVE_HOSTS !== "1"
      ? "set SUPRACORTEX_LIVE_HOSTS=1"
      : false;

/** Locate an executable on PATH without spawning it. */
function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

const CLAUDE_BIN = findOnPath("claude");
const CODEX_BIN = findOnPath("codex");

function hostSkip(binary: string | undefined): false | string {
  if (!binary) return "host binary not found on PATH";
  if (!HAS_DIST) return `missing ${MCP_ENTRY}; run pnpm run build`;
  return false;
}

interface Isolation {
  root: string;
  project: string;
  home: string;
  xdg: string;
  claudeConfig: string;
  codexHome: string;
  tmp: string;
}

async function makeIsolation(label: string): Promise<Isolation> {
  const root = await mkdtemp(join(tmpdir(), `sc-live-${label}-`));
  const iso: Isolation = {
    root,
    project: join(root, "project"),
    home: join(root, "home"),
    xdg: join(root, "xdg"),
    claudeConfig: join(root, "claude-config"),
    codexHome: join(root, "codex-home"),
    tmp: join(root, "tmp"),
  };
  for (const dir of [iso.project, iso.home, iso.xdg, iso.claudeConfig, iso.codexHome, iso.tmp]) {
    await mkdir(dir, { recursive: true });
  }
  // Enable the project so cortex_context has real work to do (and a prompt to
  // potentially leak) during the MCP handshake.
  await mkdir(join(iso.project, ".supracortex"), { recursive: true });
  await writeFile(join(iso.project, ".supracortex", "config.jsonc"), '{\n  "enabled": true\n}\n', "utf8");
  return iso;
}

/**
 * Only OS-level variables cross into subprocesses. The user's real HOME,
 * XDG paths, CLAUDE_CONFIG_DIR, CODEX_HOME and SUPRACORTEX_* overrides are
 * replaced (never inherited) and point at the temp tree instead.
 */
function childEnv(iso: Isolation, host: "claude" | "codex" | "mcp"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TZ",
    "SystemRoot",
    "windir",
    "PATHEXT",
    "ComSpec",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HOME = iso.home;
  env.USERPROFILE = iso.home;
  env.XDG_CONFIG_HOME = iso.xdg;
  env.XDG_STATE_HOME = join(iso.xdg, "state");
  env.XDG_DATA_HOME = join(iso.xdg, "data");
  env.XDG_CACHE_HOME = join(iso.xdg, "cache");
  env.TMPDIR = iso.tmp;
  env.TEMP = iso.tmp;
  env.TMP = iso.tmp;
  env.NO_COLOR = "1";
  // No provider warmup and therefore no network request from the MCP child.
  env.SUPRACORTEX_NO_DECISION_WARMUP = "1";
  if (host === "claude") env.CLAUDE_CONFIG_DIR = iso.claudeConfig;
  if (host === "codex") env.CODEX_HOME = iso.codexHome;
  return env;
}

interface FileSnapshot {
  path: string;
  exists: boolean;
  mtimeNs?: bigint;
}

function snapshotRealHostConfigs(): FileSnapshot[] {
  const realHome = userInfo().homedir;
  return [join(realHome, ".claude.json"), join(realHome, ".codex", "config.toml")].map((path) => {
    try {
      const stats = statSync(path, { bigint: true });
      return { path, exists: true, mtimeNs: stats.mtimeNs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false };
      throw error;
    }
  });
}

function assertRealHostConfigsUnchanged(before: FileSnapshot[]): void {
  for (const entry of before) {
    if (!entry.exists) {
      assert.equal(
        existsSync(entry.path),
        false,
        `${entry.path} appeared during a live-host test; the real user config was touched`,
      );
      continue;
    }
    assert.ok(existsSync(entry.path), `${entry.path} disappeared during a live-host test`);
    const after = statSync(entry.path, { bigint: true });
    assert.equal(
      after.mtimeNs,
      entry.mtimeNs,
      `${entry.path} mtime changed during a live-host test; the real user config was touched`,
    );
  }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

/** Bound and trim captured output; the full child environment is never logged. */
function captured(value: unknown): string {
  const text = asText(value);
  return text.length <= MAX_OUTPUT_BYTES ? text : `${text.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]`;
}

function reportOutput(value: string, max = 1_200): string {
  const clean = value.replace(/\r/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…[truncated]`;
}

interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Run a host command headlessly with a hard timeout and a stdout/stderr cap. */
function runCommand(
  file: string,
  args: string[],
  iso: Isolation,
  host: "claude" | "codex",
): Promise<ExecResult> {
  const options: ExecFileOptions = {
    cwd: iso.project,
    env: childEnv(iso, host),
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: "utf8",
    windowsHide: true,
  };
  return new Promise((resolvePromise) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise({ code: 0, signal: null, stdout: captured(stdout), stderr: captured(stderr) });
        return;
      }
      const failure = error as NodeJS.ErrnoException & {
        signal?: NodeJS.Signals | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      resolvePromise({
        code: typeof failure.code === "number" ? failure.code : null,
        signal: failure.signal ?? null,
        stdout: captured(failure.stdout ?? stdout),
        stderr: captured(failure.stderr ?? stderr),
      });
    });
  });
}

function findServerLine(stdout: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`^\\s*${escaped}(?::|\\s)`);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => matcher.test(line));
}

test(
  "live host: claude adds, lists, and removes the real MCP server",
  { skip: SUITE_SKIP || hostSkip(CLAUDE_BIN) },
  async (t) => {
    const bin = CLAUDE_BIN ?? "claude";
    const name = `supracortex-live-${process.pid}`;
    const before = snapshotRealHostConfigs();
    const iso = await makeIsolation("claude");
    t.after(async () => {
      try {
        assertRealHostConfigsUnchanged(before);
      } finally {
        await rm(iso.root, { recursive: true, force: true });
      }
    });

    const add = await runCommand(
      bin,
      ["mcp", "add", "-s", "user", name, "--", NODE, MCP_ENTRY, "mcp"],
      iso,
      "claude",
    );
    assert.equal(
      add.code,
      0,
      `claude mcp add failed (code ${add.code}): ${reportOutput(add.stderr || add.stdout)}`,
    );

    const listed = await runCommand(bin, ["mcp", "list"], iso, "claude");
    assert.equal(
      listed.code,
      0,
      `claude mcp list failed (code ${listed.code}): ${reportOutput(listed.stderr || listed.stdout)}`,
    );
    const line = findServerLine(listed.stdout, name);
    assert.ok(
      line,
      `${name} missing from claude mcp list: ${reportOutput(listed.stdout)}${listed.stderr ? `\nstderr: ${reportOutput(listed.stderr)}` : ""}`,
    );
    assert.doesNotMatch(
      line,
      /Failed to connect/i,
      `claude could not connect to ${name}: ${reportOutput(line)}`,
    );
    if (/Pending approval/i.test(line)) {
      t.diagnostic(
        `[claude] documented limitation: the headless list reports Pending approval (not a failure): ${reportOutput(line)}`,
      );
    }
    t.diagnostic(`[claude] list: ${reportOutput(line)}`);

    const removed = await runCommand(bin, ["mcp", "remove", "-s", "user", name], iso, "claude");
    assert.equal(
      removed.code,
      0,
      `claude mcp remove failed (code ${removed.code}): ${reportOutput(removed.stderr || removed.stdout)}`,
    );

    const after = await runCommand(bin, ["mcp", "list"], iso, "claude");
    assert.equal(
      after.code,
      0,
      `claude mcp list after remove failed (code ${after.code}): ${reportOutput(after.stderr || after.stdout)}`,
    );
    assert.equal(
      findServerLine(after.stdout, name),
      undefined,
      `${name} is still listed after remove: ${reportOutput(after.stdout)}`,
    );
    t.diagnostic(`[claude] remove: ${reportOutput(removed.stdout || removed.stderr)}`);
  },
);

test(
  "live host: codex adds, lists, and removes the real MCP server",
  { skip: SUITE_SKIP || hostSkip(CODEX_BIN) },
  async (t) => {
    const bin = CODEX_BIN ?? "codex";
    const name = `supracortex-live-${process.pid}`;
    const before = snapshotRealHostConfigs();
    const iso = await makeIsolation("codex");
    t.after(async () => {
      try {
        assertRealHostConfigsUnchanged(before);
      } finally {
        await rm(iso.root, { recursive: true, force: true });
      }
    });

    const add = await runCommand(bin, ["mcp", "add", name, "--", NODE, MCP_ENTRY, "mcp"], iso, "codex");
    assert.equal(
      add.code,
      0,
      `codex mcp add failed (code ${add.code}): ${reportOutput(add.stderr || add.stdout)}`,
    );

    const listed = await runCommand(bin, ["mcp", "list"], iso, "codex");
    assert.equal(
      listed.code,
      0,
      `codex mcp list failed (code ${listed.code}): ${reportOutput(listed.stderr || listed.stdout)}`,
    );
    const line = findServerLine(listed.stdout, name);
    assert.ok(
      line,
      `${name} missing from codex mcp list: ${reportOutput(listed.stdout)}${listed.stderr ? `\nstderr: ${reportOutput(listed.stderr)}` : ""}`,
    );
    t.diagnostic(`[codex] list: ${reportOutput(line)}`);

    const removed = await runCommand(bin, ["mcp", "remove", name], iso, "codex");
    assert.equal(
      removed.code,
      0,
      `codex mcp remove failed (code ${removed.code}): ${reportOutput(removed.stderr || removed.stdout)}`,
    );

    const after = await runCommand(bin, ["mcp", "list"], iso, "codex");
    assert.equal(
      after.code,
      0,
      `codex mcp list after remove failed (code ${after.code}): ${reportOutput(after.stderr || after.stdout)}`,
    );
    assert.equal(
      findServerLine(after.stdout, name),
      undefined,
      `${name} is still listed after remove: ${reportOutput(after.stdout)}`,
    );
    t.diagnostic(`[codex] remove: ${reportOutput(removed.stdout || removed.stderr)}`);
  },
);

test(
  "live MCP stdio: dist/cli.js answers initialize + tools/list in an isolated project",
  { skip: SUITE_SKIP || (HAS_DIST ? false : `missing ${MCP_ENTRY}; run pnpm run build`) },
  async (t) => {
    const before = snapshotRealHostConfigs();
    const iso = await makeIsolation("mcp");
    const sentinel = `RAW_PROMPT_${process.pid}_${Date.now()}`;
    t.after(async () => {
      try {
        assertRealHostConfigsUnchanged(before);
      } finally {
        await rm(iso.root, { recursive: true, force: true });
      }
    });

    const child = spawn(NODE, [MCP_ENTRY, "mcp"], {
      cwd: iso.project,
      env: childEnv(iso, "mcp"),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const replies = new Map<number, unknown>();
    let pending = "";
    let stderr = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        pending = "";
        child.kill("SIGKILL");
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: unknown };
            if (typeof message.id === "number") replies.set(message.id, message);
          } catch {
            // Non-protocol stdout is tolerated here; the handshake itself must
            // still answer (the existing compatibility suite pins stdout purity).
          }
        }
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES);
    });

    const waitFor = async (id: number): Promise<unknown> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (overflow) throw new Error("MCP stdout exceeded the byte cap");
        if (replies.has(id)) return replies.get(id);
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `MCP exited before JSON-RPC id ${id} (code ${String(child.exitCode)}, signal ${String(child.signalCode)}): ${reportOutput(stderr)}`,
          );
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      throw new Error(`timed out waiting for JSON-RPC id ${id}; stderr: ${reportOutput(stderr)}`);
    };
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "live-hosts-test", version: "0" },
        },
      });
      const initialized = (await waitFor(1)) as {
        result?: { serverInfo?: { name?: string } };
      };
      assert.equal(initialized?.result?.serverInfo?.name, "supracortex");

      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listed = (await waitFor(2)) as { result?: { tools?: Array<{ name?: string }> } };
      const names = (listed?.result?.tools ?? []).map((tool) => tool.name).filter(Boolean);
      assert.ok(names.length > 0, "tools/list returned no tools");
      assert.ok(
        names.includes("cortex_context"),
        `cortex_context missing from tools/list: ${names.join(", ")}`,
      );
      t.diagnostic(`[mcp] tools/list: ${names.length} tools advertised`);

      // Exercise a query through the real server so any prompt-mirroring path
      // would have real prompt text to persist. The response payload is not
      // asserted here; the handshake above and the no-leak check below are.
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "cortex_context", arguments: { query: sentinel } },
      });
      const call = (await waitFor(3)) as { result?: unknown; error?: unknown };
      assert.ok(
        call && (call.result !== undefined || call.error !== undefined),
        "tools/call returned no JSON-RPC response",
      );
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
      ]);
    }

    const injectionPaths = [
      join(iso.project, ".supracortex", "state", "injection.json"),
      join(iso.project, "state", "injection.json"),
    ];
    let inspected = 0;
    for (const file of injectionPaths) {
      if (!existsSync(file)) continue;
      inspected += 1;
      const text = await readFile(file, "utf8");
      assert.equal(
        text.includes(sentinel),
        false,
        `raw prompt text leaked into ${file}`,
      );
    }
    t.diagnostic(
      inspected === 0
        ? "[mcp] no state/injection.json created; no prompt mirror to inspect"
        : `[mcp] inspected ${inspected} state/injection.json file(s); sentinel absent`,
    );
  },
);
