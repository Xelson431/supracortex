/**
 * P08 A/B harness: raw Pi vs SupraCortex CLI on fixed fixture tasks.
 *
 * Opt-in: requires provider auth (uses the host Pi agent dir).
 * Usage: node benchmarks/pi-cli/run.ts [--model provider/id] [--reps N]
 *        [--tasks simple,medium] [--configs raw-pi,cortex] [--timeout-ms N]
 *
 * Method: per (config, task, rep) reset fixture (except warm chains), run
 * headless with a timeout, score the executable check, collect usage:
 * - raw-pi: parses --mode json event stream (message_end usage, tool calls).
 * - cortex: reads the run ledger (cli/runs/<latest>/usage.jsonl) afterwards.
 * Costs use provider-reported totals only; missing costs stay undefined
 * (never estimated, never zero-filled). No success => cost-per-success undefined.
 */

import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

interface Task {
  id: string;
  kind: string;
  brief: string;
  check: string[];
  warm: false | string;
}

interface RunResult {
  config: string;
  task: string;
  rep: number;
  success: boolean;
  wallMs: number;
  timedOut: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  providerCost: number | null;
  modelCalls: number | null;
  toolCalls: number | null;
  checkOutput: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string; ms: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    // stdin ignored: an open stdin pipe makes headless Pi wait for EOF.
    const child = spawn(cmd, args, { cwd, shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const finish = (code: number, timedOut: boolean): void => {
      if (done) return;
      done = true;
      resolve({ code: timedOut ? 124 : code, out, ms: Date.now() - start });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124, true);
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.stderr?.on("data", (d) => {
      out += String(d);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(1, false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish(code ?? 1, false);
    });
  });
}

interface StreamStats {
  input: number;
  output: number;
  cost: number;
  priced: boolean;
  modelCalls: number;
  toolCalls: number;
}

function parseJsonStream(out: string): StreamStats {
  const stats: StreamStats = { input: 0, output: 0, cost: 0, priced: false, modelCalls: 0, toolCalls: 0 };
  for (const line of out.split("\n")) {
    if (!line.includes("message_end") && !line.includes("tool_execution_end")) continue;
    if (line.includes("tool_execution_end")) {
      stats.toolCalls++;
      continue;
    }
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } } };
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message.usage) {
        stats.modelCalls++;
        stats.input += event.message.usage.input ?? 0;
        stats.output += event.message.usage.output ?? 0;
        if (typeof event.message.usage.cost?.total === "number") {
          stats.cost += event.message.usage.cost.total;
          stats.priced = true;
        }
      }
    } catch {
      // Non-JSON line; ignore.
    }
  }
  return stats;
}

async function newestUsage(dir: string): Promise<{ input: number; output: number; cost: number; priced: boolean; calls: number } | null> {
  const runsDir = join(dir, ".supracortex", "cli", "runs");
  let runs: string[];
  try {
    runs = await readdir(runsDir);
  } catch {
    return null;
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const run of runs) {
    const path = join(runsDir, run, "usage.jsonl");
    try {
      const st = await stat(path);
      if (!newest || st.mtimeMs > newest.mtime) newest = { path, mtime: st.mtimeMs };
    } catch {
      // No usage file for this run.
    }
  }
  if (!newest) return null;
  const out = { input: 0, output: 0, cost: 0, priced: false, calls: 0 };
  for (const line of (await readFile(newest.path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { source?: string; complete?: boolean; input?: number; output?: number; cost?: number; costSource?: string };
      if (!r.complete || (r.source !== "main" && r.source !== "child")) continue;
      out.calls++;
      out.input += r.input ?? 0;
      out.output += r.output ?? 0;
      if (typeof r.cost === "number" && r.costSource === "provider") {
        out.cost += r.cost;
        out.priced = true;
      }
    } catch {
      // Corrupt line; skip (ledger open skips it too).
    }
  }
  return out;
}

async function main(): Promise<void> {
  const model = arg("--model", "omniroute/auto/best-fast");
  const reps = Math.max(1, Number(arg("--reps", "1")) || 1);
  const onlyTasks = new Set((arg("--tasks", "") || "").split(",").filter(Boolean));
  const onlyConfigs = new Set((arg("--configs", "") || "").split(",").filter(Boolean));
  const timeoutMs = Math.max(10000, Number(arg("--timeout-ms", "300000")) || 300000);
  const manifest = JSON.parse(await readFile(join(here, "fixtures", "tasks.json"), "utf8")) as { tasks: Task[] };
  const tasks = manifest.tasks.filter((t) => !onlyTasks.size || onlyTasks.has(t.id));
  const configs = ["raw-pi", "cortex"].filter((c) => !onlyConfigs.size || onlyConfigs.has(c));
  const piBin = join(ROOT, "node_modules", ".bin", "pi");
  const cliBin = join(ROOT, "dist", "cli.js");

  // Groups of (config, rep); warm roots run before their dependents inside
  // each group, groups run in shuffled order. Warm-chain dirs are per group.
  const groups: Array<Array<{ config: string; task: Task; rep: number }>> = [];
  for (let rep = 0; rep < reps; rep++) {
    for (const config of configs) {
      const roots = tasks.filter((t) => !t.warm);
      const dependents = tasks.filter((t) => t.warm);
      groups.push([...roots, ...dependents].map((task) => ({ config, task, rep })));
    }
  }
  const seed = Date.now();
  let rng = seed % 2147483647;
  const rand = (): number => {
    rng = (rng * 16807) % 2147483647;
    return rng / 2147483647;
  };
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [groups[i], groups[j]] = [groups[j]!, groups[i]!];
  }
  const plan = groups.flat();

  const workRoots = new Map<string, string>();
  const results: RunResult[] = [];
  for (const { config, task, rep } of plan) {
    // Warm chains reuse one dir per (config, rep) — never across configs
    // (that would leak answers between configurations). A task that is a
    // warm root shares its dependent's dir (same id namespace).
    const chainId = task.warm ? String(task.warm) : (tasks.some((t) => t.warm === task.id) ? task.id : null);
    const key = chainId ? `${config}:warm:${chainId}:rep${rep}` : `${config}:${task.id}:rep${rep}`;
    let work = workRoots.get(key);
    if (!work) {
      work = await mkdtemp(join(tmpdir(), `pi-bench-${task.id}-`));
      await cp(join(here, "fixtures", "pristine"), work, { recursive: true });
      workRoots.set(key, work);
    }
    const brief = `${task.brief} Work in the current directory. When done, stop.`;
    let out = "";
    let ms = 0;
    if (config === "raw-pi") {
      const r = await runCmd(piBin, ["--mode", "json", "-p", "--no-session", "--model", model, brief], work, timeoutMs);
      out = r.out;
      ms = r.ms;
    } else {
      const r = await runCmd("node", [cliBin, "run", "-p", brief, "--no-session", "--model", model], work, timeoutMs);
      out = r.out;
      ms = r.ms;
    }
    const timedOut = ms >= timeoutMs;
    const check = await runCmd(task.check[0]!, task.check.slice(1), work, 60000);
    const success = check.code === 0 && !timedOut;
    if (config === "raw-pi") {
      const s = parseJsonStream(out);
      results.push({
        config, task: task.id, rep, success, wallMs: ms, timedOut,
        inputTokens: s.input, outputTokens: s.output,
        providerCost: s.priced ? s.cost : null,
        modelCalls: s.modelCalls, toolCalls: s.toolCalls,
        checkOutput: check.out.slice(0, 500),
      });
    } else {
      const usage = await newestUsage(work);
      results.push({
        config, task: task.id, rep, success, wallMs: ms, timedOut,
        inputTokens: usage?.input ?? null, outputTokens: usage?.output ?? null,
        providerCost: usage?.priced ? usage.cost : null,
        modelCalls: usage?.calls ?? null, toolCalls: null,
        checkOutput: check.out.slice(0, 500),
      });
    }
    console.log(`${config}/${task.id}/rep${rep}: ${success ? "PASS" : "FAIL"} ${ms}ms`);
  }

  const report = { seed, model, reps, timeoutMs, results };
  await writeFile(join(here, `report-${seed}.json`), JSON.stringify(report, null, 2));
  // Markdown summary: success rate + medians; cost-per-success undefined without success.
  const lines = ["| config | task | reps | success | median wall (ms) | median in/out | cost/success |", "|---|---|---|---|---|---|---|"];
  for (const config of configs) {
    for (const task of tasks) {
      const rows = results.filter((r) => r.config === config && r.task === task.id);
      const wins = rows.filter((r) => r.success).length;
      const med = (nums: number[]): number | null => {
        const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
        return s.length ? s[Math.floor(s.length / 2)]! : null;
      };
      const costs = rows.filter((r) => r.success && r.providerCost !== null).map((r) => r.providerCost as number);
      lines.push(
        `| ${config} | ${task.id} | ${rows.length} | ${wins}/${rows.length} | ${med(rows.map((r) => r.wallMs)) ?? "?"} | ${med(rows.map((r) => r.inputTokens ?? NaN)) ?? "?"}/${med(rows.map((r) => r.outputTokens ?? NaN)) ?? "?"} | ${costs.length ? (costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(6) : "n/a"} |`,
      );
    }
  }
  console.log(lines.join("\n"));
  for (const dir of new Set(workRoots.values())) await rm(dir, { recursive: true, force: true });
}

await main();
