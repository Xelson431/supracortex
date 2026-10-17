/**
 * Prove the SupraCode profile contract empirically: stock plugins/agents never
 * leak in, while stock MCP servers ARE shared. Prove isolation empirically: resolve OpenCode's effective config twice in a
 * throwaway directory — once as stock `opencode`, once as SupraCode — and
 * compare what each would load. Read-only; `opencode debug config` makes no
 * model calls.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { profilePaths, refreshConfigFarm, supracodeEnv } from "./profile.ts";
import { buildSharedLayer } from "./shared.ts";

export interface ResolvedSide {
  label: "stock" | "supracode";
  ms: number;
  ok: boolean;
  plugins: string[];
  mcp: string[];
  agents: string[];
  commands: string[];
  error?: string;
}

export interface IsolationResult {
  ok: boolean;
  stock: ResolvedSide;
  supracode: ResolvedSide;
  problems: string[];
  shared?: { mcp: string[]; provider: string[]; skills: string[] };
}

function run(bin: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["debug", "config"], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "" });
    });
  });
}

const PLUGIN_NAME = (spec: unknown): string => {
  const s = String(Array.isArray(spec) ? spec[0] : spec);
  return s.replace(/^file:\/\//, "");
};

async function resolveSide(label: ResolvedSide["label"], bin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ResolvedSide> {
  const started = performance.now();
  const r = await run(bin, cwd, env, 60_000);
  const ms = Math.round(performance.now() - started);
  try {
    const cfg = JSON.parse(r.stdout) as Record<string, unknown>;
    const mcp = Object.entries((cfg.mcp as Record<string, { enabled?: boolean }>) ?? {})
      .filter(([, v]) => v && v.enabled !== false)
      .map(([k]) => k);
    return {
      label,
      ms,
      ok: r.code === 0,
      plugins: ((cfg.plugin as unknown[]) ?? []).map(PLUGIN_NAME),
      mcp,
      agents: Object.keys((cfg.agent as object) ?? {}),
      commands: Object.keys((cfg.command as object) ?? {}),
    };
  } catch {
    return { label, ms, ok: false, plugins: [], mcp: [], agents: [], commands: [], error: `exit ${r.code}, unparseable output` };
  }
}

export async function verifyIsolation(opts: { bin: string; env?: NodeJS.ProcessEnv }): Promise<IsolationResult> {
  const base = opts.env ?? process.env;
  const paths = profilePaths(base);
  refreshConfigFarm(paths);
  const dir = await mkdtemp(join(tmpdir(), "supracode-isolation-"));
  try {
    const stockEnv: NodeJS.ProcessEnv = { ...base };
    // Present the user's REAL config home to the stock run even when this
    // command itself was started from inside a SupraCode session.
    if (base.SUPRACODE_REAL_XDG_CONFIG_HOME) stockEnv.XDG_CONFIG_HOME = base.SUPRACODE_REAL_XDG_CONFIG_HOME;
    delete stockEnv.SUPRACODE;
    const stock = await resolveSide("stock", opts.bin, dir, stockEnv);
    const shared = buildSharedLayer(paths);
    const supracode = await resolveSide("supracode", opts.bin, dir, supracodeEnv(base, paths, shared.configFile));
    const problems: string[] = [];
    const cortex = (xs: string[]) => xs.filter((x) => /supracortex|supracode/i.test(x));
    if (!stock.ok) problems.push(`stock opencode config did not resolve (${stock.error ?? "non-zero exit"})`);
    if (!supracode.ok) problems.push(`supracode config did not resolve (${supracode.error ?? "non-zero exit"})`);
    if (cortex(stock.plugins).length) problems.push(`stock opencode loads SupraCortex plugin(s): ${cortex(stock.plugins).join(", ")}`);
    if (cortex(stock.mcp).length) problems.push(`stock opencode loads SupraCortex MCP: ${cortex(stock.mcp).join(", ")}`);
    if (stock.commands.some((c) => c.startsWith("cortex-"))) problems.push("stock opencode loads cortex-* commands");
    const inherited = supracode.plugins.filter((p) => !/supracortex/i.test(p) && stock.plugins.includes(p));
    if (inherited.length) problems.push(`supracode inherited stock plugin(s): ${inherited.join(", ")}`);
    // MCP servers are SHARED by design: every enabled stock server must be
    // present in SupraCode too (unless the profile overrides that name).
    // Compare against what the stock CONFIG FILE shares (shared.mcp), not the
    // stock runtime: some plugins inject extra servers that belong to the
    // plugin and are correctly absent from SupraCode.
    const enabledShared = shared.mcp.filter((m) => stock.mcp.includes(m));
    const missingMcp = enabledShared.filter((m) => !supracode.mcp.includes(m));
    if (missingMcp.length) problems.push(`supracode is missing shared stock MCP server(s): ${missingMcp.join(", ")}`);
    // Extra plugins in the SupraCode profile are a supported, opt-in choice:
    // the requirement is that they are NOT inherited from stock (checked
    // above), not that they are absent. Only inherited agents are a problem.
    const inheritedAgents = supracode.agents.filter((a) => stock.agents.includes(a) && !["build", "plan", "general", "explore"].includes(a));
    if (inheritedAgents.length) problems.push(`supracode inherited stock agent(s): ${inheritedAgents.join(", ")}`);
    if (!supracode.plugins.some((p) => /supracortex/i.test(p))) problems.push("supracode does not load the SupraCortex plugin");
    return { ok: problems.length === 0, stock, supracode, problems, shared: { mcp: shared.mcp, provider: shared.provider, skills: shared.skills } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
