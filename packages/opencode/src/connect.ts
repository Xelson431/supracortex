/**
 * `supracode connect <host>`: register SupraCortex as a global (user-scope)
 * stdio MCP server in other coding agents, so it works in every project they
 * open. The server is rootless: with no SUPRACORTEX_ROOT it uses the host's
 * working directory as the project.
 *
 *   codex    ~/.codex/config.toml (marker-fenced block, reversible)
 *   claude   `claude mcp add -s user` (Claude Code's own CLI; falls back to
 *            editing ~/.claude.json when the CLI is not on PATH)
 *   generic  prints a standard `mcpServers` JSON snippet for any MCP host
 *            (DeepSeek-based harnesses, Cursor, Gemini CLI, Cline, Zed, ...)
 *
 * Every command references the stable `supracortex-mcp` shim when installed,
 * so host configs survive the checkout moving or being rebuilt.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { mcpLaunch, unwireCodexGlobal, wireCodexGlobal } from "./agent-wiring.ts";

export const CONNECT_HOSTS = ["codex", "claude", "generic"] as const;
export type ConnectHost = (typeof CONNECT_HOSTS)[number];

export interface ConnectResult {
  host: ConnectHost;
  ok: boolean;
  action: "connected" | "unchanged" | "disconnected" | "printed" | "skipped";
  detail: string;
  file?: string;
  snippet?: string;
}

/** Portable `mcpServers` JSON most MCP hosts accept verbatim. */
export function genericSnippet(): string {
  const l = mcpLaunch();
  return JSON.stringify({ mcpServers: { supracortex: { type: "stdio", command: l.command, args: l.args } } }, null, 2);
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

function claudeCli(env: NodeJS.ProcessEnv): string | null {
  const bin = env.SUPRACODE_CLAUDE_BIN?.trim() || "claude";
  const r = spawnSync(bin, ["--version"], { env, encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? bin : null;
}

/** Edit ~/.claude.json directly (user-scope mcpServers) when the CLI is absent. */
async function claudeJson(env: NodeJS.ProcessEnv, remove: boolean): Promise<ConnectResult> {
  const file = join(home(env), ".claude.json");
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      return { host: "claude", ok: false, action: "skipped", detail: `${file} is not valid JSON; refusing to edit`, file };
    }
  }
  const servers = { ...((data.mcpServers as Record<string, unknown>) ?? {}) };
  if (remove) {
    if (!("supracortex" in servers)) return { host: "claude", ok: true, action: "unchanged", detail: "not connected", file };
    delete servers.supracortex;
  } else {
    const l = mcpLaunch();
    const desired: Record<string, unknown> = { type: "stdio", command: l.command, args: l.args, env: {} };
    if (isDeepStrictEqual(servers.supracortex, desired)) {
      return { host: "claude", ok: true, action: "unchanged", detail: `user-scope server already present in ${file}`, file };
    }
    servers.supracortex = desired;
  }
  // Only rewrite the file (and refresh its backup) when the entry actually
  // changes, so a redundant `connect` never churns ~/.claude.json or its backup.
  if (existsSync(file)) await copyFile(file, `${file}.supracortex.bak`);
  data.mcpServers = servers;
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { host: "claude", ok: true, action: remove ? "disconnected" : "connected", detail: `${remove ? "removed from" : "user-scope server in"} ${file}`, file };
}

/** Best-effort read of the current user-scope `supracortex` entry from
 * ~/.claude.json, where Claude Code persists user-scope MCP servers. */
async function claudeJsonEntry(env: NodeJS.ProcessEnv): Promise<unknown> {
  const file = join(home(env), ".claude.json");
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const servers = data.mcpServers as Record<string, unknown> | undefined;
    return servers && "supracortex" in servers ? servers.supracortex : undefined;
  } catch {
    return undefined;
  }
}

/** Put a captured `supracortex` entry back into ~/.claude.json after a failed
 * CLI replace, so a partial failure never leaves the user with no registration. */
async function restoreClaudeJsonEntry(env: NodeJS.ProcessEnv, entry: unknown): Promise<boolean> {
  const file = join(home(env), ".claude.json");
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  const servers = { ...((data.mcpServers as Record<string, unknown>) ?? {}) };
  servers.supracortex = entry;
  data.mcpServers = servers;
  try {
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function connectClaude(env: NodeJS.ProcessEnv, remove: boolean): Promise<ConnectResult> {
  const bin = claudeCli(env);
  if (!bin) return claudeJson(env, remove);
  if (remove) {
    spawnSync(bin, ["mcp", "remove", "supracortex", "-s", "user"], { env, encoding: "utf8", timeout: 30_000 });
    return { host: "claude", ok: true, action: "disconnected", detail: "removed user-scope server (claude mcp remove -s user)" };
  }
  // Capture the current entry before replacing it: if `mcp add` fails after the
  // removal below, we restore it so the user keeps a working registration.
  const prior = await claudeJsonEntry(env);
  // Replace any previous user-scope entry (e.g. one pointing at an old checkout).
  spawnSync(bin, ["mcp", "remove", "supracortex", "-s", "user"], { env, encoding: "utf8", timeout: 30_000 });
  const l = mcpLaunch();
  const r = spawnSync(bin, ["mcp", "add", "-s", "user", "supracortex", "--", l.command, ...l.args], { env, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) {
    const restored = prior !== undefined ? await restoreClaudeJsonEntry(env, prior) : false;
    const extra = prior === undefined ? "" : restored ? "; prior entry restored" : "; could not restore prior entry";
    return { host: "claude", ok: false, action: "skipped", detail: `claude mcp add failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}${extra}` };
  }
  return { host: "claude", ok: true, action: "connected", detail: `user scope: ${l.command} ${l.args.join(" ")}`.trim() };
}

export async function connect(host: ConnectHost, opts: { remove?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<ConnectResult> {
  const env = opts.env ?? process.env;
  const remove = opts.remove === true;
  if (host === "generic") {
    return { host, ok: true, action: "printed", detail: "add this to your MCP host's config (stdio server)", snippet: genericSnippet() };
  }
  if (host === "codex") {
    if (remove) {
      const file = await unwireCodexGlobal(home(env));
      return { host, ok: true, action: file ? "disconnected" : "unchanged", detail: file ? `removed block from ${file}` : "not connected" };
    }
    const r = await wireCodexGlobal(home(env));
    return { host, ok: true, action: "connected", detail: `${r.created ? "created" : "updated"} ${r.file}`, file: r.file };
  }
  return connectClaude(env, remove);
}
