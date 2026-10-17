/**
 * `supracode connect`: each host gets a user-scope stdio server whose command
 * actually speaks MCP (verified with a real initialize + tools/list handshake).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect, genericSnippet } from "../../packages/opencode/src/connect.ts";

/** Spawn a configured stdio server and complete initialize + tools/list. */
async function handshake(command: string, args: string[], cwd: string): Promise<string[]> {
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, SUPRACORTEX_NO_DECISION_WARMUP: "1" } });
  let buf = "";
  const replies = new Map<number, any>();
  child.stdout.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined) replies.set(m.id, m);
      } catch { /* ignore */ }
    }
  });
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const wait = async (id: number) => {
    for (let t = 0; t < 600 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 50));
    return replies.get(id);
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal((await wait(1))?.result?.serverInfo?.name, "supracortex");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    return ((await wait(2))?.result?.tools ?? []).map((t: { name: string }) => t.name);
  } finally {
    child.kill();
  }
}

async function fakeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sc-connect-"));
}

test("codex: global block is rootless and the command speaks MCP", async () => {
  const h = await fakeHome();
  const project = await mkdtemp(join(tmpdir(), "sc-connect-proj-"));
  const r = await connect("codex", { env: { ...process.env, HOME: h } });
  assert.equal(r.ok, true);
  const toml = await readFile(join(h, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(toml, /SUPRACORTEX_ROOT/, "rootless: follows the project Codex opens");
  const command = JSON.parse(/command = (".*")/.exec(toml)![1]!);
  const args = JSON.parse(`[${/args = \[(.*)\]/.exec(toml)![1]}]`);
  const tools = await handshake(command, args, project);
  assert.ok(tools.includes("cortex_context") && tools.includes("cortex_jev_status"));
  const off = await connect("codex", { remove: true, env: { ...process.env, HOME: h } });
  assert.equal(off.action, "disconnected");
});

test("claude: uses `claude mcp add -s user` and replaces a stale entry first", async () => {
  const h = await fakeHome();
  const log = join(h, "calls.log");
  const bin = join(h, "claude");
  await writeFile(bin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 0\n`);
  await chmod(bin, 0o755);
  const r = await connect("claude", { env: { ...process.env, HOME: h, SUPRACODE_CLAUDE_BIN: bin } });
  assert.equal(r.ok, true);
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls[0], "--version");
  assert.equal(calls[1], "mcp remove supracortex -s user");
  assert.match(calls[2]!, /^mcp add -s user supracortex -- /);
});

test("claude without the CLI: edits ~/.claude.json user scope, preserving other keys", async () => {
  const h = await fakeHome();
  await writeFile(join(h, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
  const env = { ...process.env, HOME: h, SUPRACODE_CLAUDE_BIN: join(h, "missing-claude") };
  const r = await connect("claude", { env });
  assert.equal(r.action, "connected");
  const data = JSON.parse(await readFile(join(h, ".claude.json"), "utf8"));
  assert.equal(data.theme, "dark");
  assert.equal(data.mcpServers.other.command, "x");
  const project = await mkdtemp(join(tmpdir(), "sc-connect-proj-"));
  const s = data.mcpServers.supracortex;
  assert.ok((await handshake(s.command, s.args, project)).includes("cortex_context"));
  await connect("claude", { remove: true, env });
  assert.equal("supracortex" in JSON.parse(await readFile(join(h, ".claude.json"), "utf8")).mcpServers, false);
});

test("claude JSON fallback: a second connect reports unchanged and does not rewrite the backup", async () => {
  const h = await fakeHome();
  // Seed the file so the first connect writes a backup we can compare later.
  await writeFile(join(h, ".claude.json"), JSON.stringify({ theme: "dark" }), "utf8");
  const env = { ...process.env, HOME: h, SUPRACODE_CLAUDE_BIN: join(h, "missing-claude") };

  const first = await connect("claude", { env });
  assert.equal(first.action, "connected");
  const bakPath = join(h, ".claude.json.supracortex.bak");
  const backupAfterFirst = await readFile(bakPath, "utf8");
  const jsonAfterFirst = await readFile(join(h, ".claude.json"), "utf8");

  const second = await connect("claude", { env });
  assert.equal(second.action, "unchanged");
  assert.equal(await readFile(join(h, ".claude.json"), "utf8"), jsonAfterFirst, "json not rewritten");
  assert.equal(await readFile(bakPath, "utf8"), backupAfterFirst, "backup not rewritten");
});

test("claude CLI: a failed `mcp add` preserves the prior registration", async () => {
  const h = await fakeHome();
  const prior = { type: "stdio", command: "/old/bin/node", args: ["/old/server.js"], env: {} };
  await writeFile(join(h, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: { supracortex: prior } }), "utf8");
  const log = join(h, "calls.log");
  const bin = join(h, "claude");
  await writeFile(
    bin,
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nif [ "$1" = "--version" ]; then exit 0; fi\nif [ "$1 $2" = "mcp add" ]; then exit 1; fi\nexit 0\n`,
  );
  await chmod(bin, 0o755);
  const env = { ...process.env, HOME: h, SUPRACODE_CLAUDE_BIN: bin };

  const r = await connect("claude", { env });
  assert.equal(r.ok, false);
  assert.equal(r.action, "skipped");
  const data = JSON.parse(await readFile(join(h, ".claude.json"), "utf8"));
  assert.deepEqual(data.mcpServers.supracortex, prior, "prior entry preserved after failure");
  assert.equal(data.theme, "dark", "other keys preserved");
});

test("generic: the printed mcpServers snippet speaks MCP", async () => {
  const s = JSON.parse(genericSnippet()).mcpServers.supracortex;
  assert.equal(s.type, "stdio");
  const project = await mkdtemp(join(tmpdir(), "sc-connect-proj-"));
  await mkdir(join(project, "src"), { recursive: true });
  assert.ok((await handshake(s.command, s.args, project)).length >= 10);
});
