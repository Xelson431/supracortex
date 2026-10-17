/**
 * Value measurement (correlational-only) tests — V1..V13.
 *
 * Deterministic: no sleeps; every assertion reads observable persisted state.
 * Default behaviour is OFF, so these tests opt in per-scenario via
 * `telemetry.valueMeasurement.enabled`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Engine,
  JsonlStore,
  resolveConfig,
  ValueMetricsStore,
  VALUE_EVENTS_FILE,
  buildValueReport,
  formatValueTokenLine,
  MetricsCollector,
  formatMetrics,
} from "../../packages/core/src/index.ts";
import type { ValueEvent, ToolExecutionEvent, ProviderUsageEvent } from "../../packages/core/src/index.ts";
import { SupraCortex } from "../../packages/opencode/src/plugin.ts";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../../scripts/cli.ts", import.meta.url));

interface EngineHarness {
  dir: string;
  engine: Engine;
  store: JsonlStore;
}

async function projectEngine(overrides: Record<string, unknown> = {}): Promise<EngineHarness> {
  const dir = await mkdtemp(join(tmpdir(), "vm-eng-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return true; }\n", "utf8");
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  return { dir, engine, store };
}

async function readValueEvents(dir: string): Promise<ValueEvent[]> {
  const raw = await readFile(join(dir, ".supracortex", VALUE_EVENTS_FILE), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ValueEvent);
}

/** Read the value-events file directly from a storage root (a `.supracortex` dir). */
async function readValueEventsFromStore(storageRoot: string): Promise<ValueEvent[]> {
  const raw = await readFile(join(storageRoot, VALUE_EVENTS_FILE), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ValueEvent);
}

function makeToolEvent(taskId: string, incarnationId: string, at: string): ToolExecutionEvent {
  return {
    schemaVersion: 1,
    eventType: "tool_execution",
    recordedAt: at,
    taskId,
    incarnationId,
    genAi: { "gen_ai.operation.name": "bash" },
    supracortex: { "supracortex.latency_ms": 1 },
    estimated: true,
    estimatedFields: ["supracortex.retry.count"],
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("V1: explicit opt-out creates no value-events.jsonl and changes nothing", async () => {
  const { dir, engine } = await projectEngine({ telemetry: { valueMeasurement: { enabled: false } } });
  const claim = await engine.claimFiles("v1-task", ["src/auth.ts"], { sessionId: "v1-session" });
  assert.ok(claim.incarnationId, "claim still returns the incarnation id");
  assert.equal(
    await engine.recordContextInjection({ injected: true, sessionId: "v1-session" }),
    null,
    "injection recording is a no-op when disabled",
  );
  assert.equal(
    await engine.recordToolExecution({ tool: "bash", latencyMs: 5, retryCount: 0, sessionId: "v1-session" }),
    null,
    "tool recording is a no-op when disabled",
  );
  const outcome = await engine.recordOutcome({
    taskId: "v1-task",
    incarnationId: claim.incarnationId,
    status: "success",
    summary: "done",
    touchedFiles: ["src/auth.ts"],
    recordedAt: new Date().toISOString(),
  });
  assert.equal(outcome?.recorded, true, "outcome recording is unchanged when disabled");
  await engine.recordHostUsage({
    messageId: "m1",
    sessionId: "v1-session",
    provider: "anthropic",
    model: "claude",
    reportedCost: 0,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  await assert.rejects(
    access(join(dir, ".supracortex", "metrics", VALUE_EVENTS_FILE)),
    "value-events.jsonl must not exist when measurement is disabled",
  );
  const metricsFiles = await readdir(join(dir, ".supracortex", "metrics"));
  assert.equal(
    metricsFiles.some((f) => f.startsWith("session-")),
    false,
    "no session snapshot written",
  );
  const report = await engine.valueReport();
  assert.equal(report.enabled, false);
  assert.equal(report.comparisonRendered, false);
});

test("V2: enabled — injection, tool, usage-link and outcome rows carry (taskId, incarnationId)", async () => {
  const { dir, engine } = await projectEngine({
    telemetry: { valueMeasurement: { enabled: true } },
  });
  const claim = await engine.claimFiles("v2-task", ["src/auth.ts"], { sessionId: "v2-session" });
  assert.ok(claim.incarnationId);
  const incarnationId = claim.incarnationId as string;

  const inj = await engine.recordContextInjection({ injected: true, sessionId: "v2-session" });
  assert.equal(inj?.eventType, "context_injection");
  assert.equal(inj?.taskId, "v2-task");
  assert.equal(inj?.incarnationId, incarnationId);
  assert.equal(inj?.supracortex["supracortex.context.injected"], true);

  const tool = await engine.recordToolExecution({
    tool: "bash",
    latencyMs: 42,
    retryCount: 1,
    sessionId: "v2-session",
    argumentsHash: "a".repeat(64),
  });
  assert.equal(tool?.eventType, "tool_execution");
  assert.equal(tool?.taskId, "v2-task");
  assert.equal(tool?.incarnationId, incarnationId);
  assert.equal(tool?.estimated, true, "heuristic retry count is marked estimated");
  assert.equal(tool?.supracortex["supracortex.latency_ms"], 42);
  assert.equal(tool?.genAi?.["gen_ai.operation.name"], "bash");

  const outcome = await engine.recordOutcome({
    taskId: "v2-task",
    incarnationId,
    status: "success",
    summary: "ok",
    touchedFiles: ["src/auth.ts"],
    recordedAt: new Date().toISOString(),
  });
  assert.ok(outcome?.recorded);

  const usage = await engine.recordHostUsage({
    messageId: "m-v2",
    sessionId: "v2-session",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    reportedCost: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(usage.recorded, true);

  const rows = await readValueEvents(dir);
  assert.equal(rows.length, 4, "one row per event type");
  for (const row of rows) {
    assert.equal(row.schemaVersion, 1);
    assert.equal(row.taskId, "v2-task");
    assert.equal(row.incarnationId, incarnationId);
    assert.ok(!Number.isNaN(Date.parse(row.recordedAt)), "recordedAt is a valid ISO-8601 timestamp");
  }
  assert.deepEqual(
    rows.map((r) => r.eventType).sort(),
    ["context_injection", "provider_usage_link", "task_outcome", "tool_execution"].sort(),
  );
  const link = rows.find((r) => r.eventType === "provider_usage_link") as
    | Extract<ValueEvent, { eventType: "provider_usage_link" }>
    | undefined;
  assert.ok(link, "usage link row exists");
  assert.equal(link.messageId, "m-v2");
  assert.match(link.eventKey, /^[a-f0-9]{64}$/);
});

test("V3: prompts, arguments and results never appear in the file — only an arguments hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "vm-privacy-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(
    join(root, ".supracortex", "config.jsonc"),
    JSON.stringify({ enabled: true, telemetry: { valueMeasurement: { enabled: true } } }),
    "utf8",
  );
  await writeFile(join(root, "src/auth.ts"), "export function login() { return true; }\n", "utf8");

  const hooks = await SupraCortex({
    directory: root,
    worktree: root,
    client: {},
    $: async () => ({ stdout: "" }),
  } as never);
  try {
    // A user prompt containing a secret reaches the injection site.
    await hooks["experimental.chat.messages.transform"]?.(
      {} as never,
      {
        messages: [{
          info: { role: "user", sessionID: "privacy-session" },
          parts: [{ type: "text", text: "THE PROMPT SEKRET_MARKER_42" }],
        }],
      } as never,
    );
    const systemOut = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "privacy-session", model: {} as never } as never,
      systemOut as never,
    );

    // A tool execution whose arguments and result contain secrets.
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "privacy-session", callID: "c1" } as never,
      { args: { command: "rm -rf /  # ARGSEKRET", apiKey: "sk-live-abcdef0123456789" } } as never,
    );
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "privacy-session", callID: "c1", args: { command: "rm -rf /  # ARGSEKRET" } } as never,
      { title: "bash", output: "RESULTSECRET_OUTPUT", metadata: {} } as never,
    );

    const raw = await readFile(join(root, ".supracortex", VALUE_EVENTS_FILE), "utf8");
    assert.ok(raw.length > 0, "value events file exists with recorded rows");
    for (const secret of ["SEKRET_MARKER_42", "ARGSEKRET", "sk-live-abcdef0123456789", "RESULTSECRET_OUTPUT", "THE PROMPT"]) {
      assert.ok(!raw.includes(secret), `sensitive content must never be persisted: ${secret}`);
    }
    const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ValueEvent);
    const toolRows = rows.filter((r) => r.eventType === "tool_execution");
    assert.equal(toolRows.length, 1);
    const tool = toolRows[0] as Extract<ValueEvent, { eventType: "tool_execution" }>;
    assert.match(tool.argumentsHash ?? "", /^[a-f0-9]{64}$/, "only a stable arguments hash is stored");
  } finally {
    await hooks.dispose?.();
  }
});

test("V4: bounded — exceeding maxEvents trims the oldest rows; the file never grows unbounded", async () => {
  const { store } = await projectEngine();
  const cfg = { enabled: true, maxEvents: 5, maxAgeDays: 30 };
  const vm = new ValueMetricsStore({ storage: store, config: () => cfg });
  const base = Date.now() - 60_000;
  for (let i = 0; i < 12; i++) {
    const at = new Date(base + i * 1_000).toISOString();
    const event = makeToolEvent(`v4-task-${i}`, `v4-inc-${i}`, at);
    assert.ok(await vm.append(event), `append ${i} succeeds`);
  }
  const rows = await readValueEventsFromStore(store.root);
  assert.equal(rows.length, 5, "file is bounded at maxEvents");
  assert.equal(rows[0]?.taskId, "v4-task-7", "oldest rows are trimmed first");
  assert.equal(rows.at(-1)?.taskId, "v4-task-11", "newest rows are retained");
});

test("V5: correlation — a reused taskId with a NEW incarnationId never merges into the previous group", async () => {
  const { engine } = await projectEngine({
    telemetry: { valueMeasurement: { enabled: true } },
  });
  // Incarnation A of "reuse-task".
  await engine.recordContextInjection({ taskId: "reuse-task", incarnationId: "inc-A", injected: true });
  await engine.recordToolExecution({ taskId: "reuse-task", incarnationId: "inc-A", tool: "bash", latencyMs: 5, retryCount: 0 });
  await engine.recordOutcome({
    taskId: "reuse-task",
    incarnationId: "inc-A",
    status: "success",
    summary: "a",
    touchedFiles: [],
    recordedAt: new Date().toISOString(),
  });
  // New incarnation B of the SAME taskId.
  await engine.recordContextInjection({ taskId: "reuse-task", incarnationId: "inc-B", injected: true });
  await engine.recordOutcome({
    taskId: "reuse-task",
    incarnationId: "inc-B",
    status: "failure",
    summary: "b",
    touchedFiles: [],
    recordedAt: new Date().toISOString(),
  });
  const report = await engine.valueReport();
  const seg = report.segments.injected;
  assert.ok(seg, "injected segment exists");
  assert.equal(seg.taskCount, 2, "a new incarnation is a distinct task, not merged");
  assert.equal(seg.outcomesAgent.success, 1);
  assert.equal(seg.outcomesAgent.failure, 1);
  assert.equal(report.unattributed.rows, 0);
});

test("V6: legacy rows lacking incarnationId land in the unattributed bucket and are excluded", async () => {
  const { engine } = await projectEngine({
    telemetry: { valueMeasurement: { enabled: true } },
  });
  // Legacy rows: taskId present but NO incarnationId.
  await engine.recordOutcome({
    taskId: "legacy-task",
    status: "success",
    summary: "legacy",
    touchedFiles: [],
    recordedAt: new Date().toISOString(),
  });
  await engine.recordContextInjection({ taskId: "legacy-task", injected: true });
  // Modern keyed row.
  await engine.recordContextInjection({ taskId: "modern-task", incarnationId: "new-1", injected: true });
  const report = await engine.valueReport();
  assert.equal(report.unattributed.rows, 2, "legacy rows counted in the unattributed bucket");
  assert.equal(report.unattributed.distinctTaskIds, 1);
  assert.equal(report.segments.injected?.taskCount, 1, "only the keyed task joins a segment");
  assert.equal(report.sample.injected, 1, "legacy rows never feed the keyed sample");
});

test("V7: below-threshold sample refuses to render a comparison and says not enough data", async () => {
  const { engine } = await projectEngine({
    telemetry: { valueMeasurement: { enabled: true } },
  });
  for (let i = 0; i < 10; i++) {
    await engine.recordContextInjection({ taskId: `low-inj-${i}`, incarnationId: `a${i}`, injected: true });
    await engine.recordOutcome({
      taskId: `low-inj-${i}`,
      incarnationId: `a${i}`,
      status: "success",
      summary: "s",
      touchedFiles: [],
      recordedAt: new Date().toISOString(),
    });
  }
  for (let i = 0; i < 5; i++) {
    await engine.recordContextInjection({ taskId: `low-noinj-${i}`, incarnationId: `b${i}`, injected: false });
    await engine.recordOutcome({
      taskId: `low-noinj-${i}`,
      incarnationId: `b${i}`,
      status: "failure",
      summary: "f",
      touchedFiles: [],
      recordedAt: new Date().toISOString(),
    });
  }
  const report = await engine.valueReport();
  assert.equal(report.comparisonRendered, false);
  assert.ok(report.refusalReason?.includes("not enough data"), "refusal carries the literal text");
  assert.match(report.refusalReason ?? "", /injected: 10/);
  assert.match(report.refusalReason ?? "", /not injected: 5/);
  assert.equal(report.correlationLabel, "correlational — not causal; sessions with and without context are not randomized");
});

test("V8: above-threshold sample renders a comparison with the exact correlation label", async () => {
  const { engine } = await projectEngine({
    telemetry: { valueMeasurement: { enabled: true } },
  });
  for (let i = 0; i < 22; i++) {
    await engine.recordContextInjection({ taskId: `hi-inj-${i}`, incarnationId: `c${i}`, injected: true });
    await engine.recordToolExecution({ taskId: `hi-inj-${i}`, incarnationId: `c${i}`, tool: "bash", latencyMs: 10 + i, retryCount: i % 3 });
    await engine.recordOutcome({
      taskId: `hi-inj-${i}`,
      incarnationId: `c${i}`,
      status: "success",
      summary: "s",
      touchedFiles: [],
      recordedAt: new Date().toISOString(),
    });
  }
  for (let i = 0; i < 21; i++) {
    await engine.recordContextInjection({ taskId: `hi-noinj-${i}`, incarnationId: `d${i}`, injected: false });
    await engine.recordToolExecution({ taskId: `hi-noinj-${i}`, incarnationId: `d${i}`, tool: "bash", latencyMs: 20 + i, retryCount: 0 });
    await engine.recordOutcome({
      taskId: `hi-noinj-${i}`,
      incarnationId: `d${i}`,
      status: "failure",
      summary: "f",
      touchedFiles: [],
      recordedAt: new Date().toISOString(),
    });
  }
  const report = await engine.valueReport();
  assert.equal(report.comparisonRendered, true);
  assert.equal(
    report.correlationLabel,
    "correlational — not causal; sessions with and without context are not randomized",
  );
  assert.equal(report.sample.injected, 22);
  assert.equal(report.sample.notInjected, 21);
  const inj = report.segments.injected;
  const noinj = report.segments.notInjected;
  assert.ok(inj && noinj);
  assert.equal(inj.outcomesAgent.success, 22);
  assert.equal(noinj.outcomesAgent.failure, 21);
  assert.ok(inj.latencyMedianMs !== null && inj.latencyMedianMs > 0, "latency median is computed");
  assert.ok((inj.latencyP90Ms ?? 0) >= (inj.latencyMedianMs ?? 0), "p90 is not below the median");
  assert.ok(inj.totalRetryCount > 0, "retries are aggregated");
  assert.ok(noinj.toolExecutions === 21);
  assert.equal(report.unattributed.rows, 0);
});

test("V9: inferred outcomes are reported separately and never counted as verified success", async () => {
  const { engine } = await projectEngine({
    telemetry: { valueMeasurement: { enabled: true } },
  });
  await engine.recordContextInjection({ taskId: "agent-task", incarnationId: "e1", injected: true });
  await engine.recordOutcome({
    taskId: "agent-task",
    incarnationId: "e1",
    status: "success",
    source: "agent",
    summary: "verified",
    touchedFiles: [],
    recordedAt: new Date().toISOString(),
  });
  await engine.recordContextInjection({ taskId: "inferred-task", incarnationId: "e2", injected: true });
  await engine.recordOutcome({
    taskId: "inferred-task",
    incarnationId: "e2",
    status: "success",
    source: "inferred",
    summary: "guessed",
    touchedFiles: [],
    recordedAt: new Date().toISOString(),
  });
  const report = await engine.valueReport();
  const seg = report.segments.injected;
  assert.ok(seg);
  assert.equal(seg.outcomesAgent.success, 1, "only the agent outcome counts as verified success");
  assert.equal(seg.outcomesInferred.success, 1, "the inferred outcome is tracked separately");
  assert.equal(seg.outcomesInferred.failure + seg.outcomesInferred.partial, 0);
  assert.equal(seg.outcomesAgent.success + seg.outcomesAgent.failure + seg.outcomesAgent.partial, 1);
});

test("V10: a deterministic append failure never breaks the task or throws into the host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vm-fail-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/auth.ts"), "export function login() { return true; }\n", "utf8");
  const { config } = resolveConfig({
    project: { enabled: true, telemetry: { valueMeasurement: { enabled: true, maxEvents: 20_000, maxAgeDays: 30 } } },
  });
  const real = new JsonlStore(join(dir, ".supracortex"));
  const failing = new Proxy(real, {
    get(target, prop: string | symbol, receiver: unknown) {
      if (prop === "appendJsonl") {
        return async (relPath: string, entries: unknown[]) => {
          if (entries === undefined) throw new Error("unreachable");
          if (relPath === VALUE_EVENTS_FILE) throw new Error("injected value-metrics append failure");
          return target.appendJsonl(relPath, entries);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as JsonlStore;
  const engine = new Engine({ config, store: failing, pluginVersion: "0.1.0", projectRoot: dir });

  const tool = await engine.recordToolExecution({ tool: "bash", latencyMs: 3, retryCount: 0, taskId: "f", incarnationId: "f1" });
  assert.equal(tool, null, "the failure is swallowed; no throw into the host");

  const outcome = await engine.recordOutcome({
    taskId: "f",
    incarnationId: "f1",
    status: "success",
    summary: "ok",
    touchedFiles: [],
    recordedAt: new Date().toISOString(),
  });
  assert.ok(outcome?.recorded, "outcome recording is unaffected by value-metrics failure");
  const completedRaw = await readFile(join(dir, ".supracortex", "tasks", "completed.jsonl"), "utf8");
  const completed = JSON.parse(completedRaw.split("\n").filter(Boolean).at(-1)!) as { status?: string };
  assert.equal(completed.status, "success", "the outcome record landed in the completed ledger");
});

test("V11: the hot path never writes metrics/session-YYYY-MM-DD.json", async () => {
  const { dir, engine } = await projectEngine({
    telemetry: { valueMeasurement: { enabled: true } },
  });
  const claim = await engine.claimFiles("v11-task", ["src/auth.ts"], { sessionId: "v11-session" });
  await engine.recordContextInjection({ injected: true, sessionId: "v11-session" });
  await engine.recordToolExecution({ tool: "bash", latencyMs: 5, retryCount: 0, sessionId: "v11-session" });
  await engine.recordOutcome({
    taskId: "v11-task",
    incarnationId: claim.incarnationId,
    status: "success",
    summary: "ok",
    touchedFiles: ["src/auth.ts"],
    recordedAt: new Date().toISOString(),
  });
  await engine.recordHostUsage({
    messageId: "m-v11",
    sessionId: "v11-session",
    provider: "anthropic",
    model: "claude",
    reportedCost: 0,
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const metricsFiles = await readdir(join(dir, ".supracortex", "metrics"));
  assert.equal(
    metricsFiles.some((f) => f.startsWith("session-")),
    false,
    "no session-YYYY-MM-DD.json written by any measurement path",
  );
  assert.ok(metricsFiles.includes(VALUE_EVENTS_FILE.replace("metrics/", "")), "value events file exists");
  const report = await engine.valueReport();
  assert.equal(report.enabled, true);
});

test("V12: value-report --json is stable and preserves refusal/label semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "vm-cli-"));
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(
    join(root, ".supracortex", "config.jsonc"),
    JSON.stringify({ enabled: true, telemetry: { valueMeasurement: { enabled: true } } }),
    "utf8",
  );
  const { config } = resolveConfig({
    project: { enabled: true, telemetry: { valueMeasurement: { enabled: true, maxEvents: 20_000, maxAgeDays: 30 } } },
  });
  const engine = new Engine({
    config,
    store: new JsonlStore(join(root, ".supracortex")),
    pluginVersion: "0.1.0",
    projectRoot: root,
  });
  for (let i = 0; i < 22; i++) {
    await engine.recordContextInjection({ taskId: `c-inj-${i}`, incarnationId: `x${i}`, injected: true });
    await engine.recordOutcome({
      taskId: `c-inj-${i}`,
      incarnationId: `x${i}`,
      status: "success",
      summary: "s",
      touchedFiles: [],
      recordedAt: new Date().toISOString(),
    });
  }
  for (let i = 0; i < 21; i++) {
    await engine.recordContextInjection({ taskId: `c-noinj-${i}`, incarnationId: `y${i}`, injected: false });
    await engine.recordOutcome({
      taskId: `c-noinj-${i}`,
      incarnationId: `y${i}`,
      status: "failure",
      summary: "f",
      touchedFiles: [],
      recordedAt: new Date().toISOString(),
    });
  }

  const { stdout } = await execFileAsync(process.execPath, [CLI, "value-report", "--json"], {
    cwd: root,
    timeout: 60_000,
  });
  const rendered = JSON.parse(stdout) as {
    enabled: boolean;
    comparisonRendered: boolean;
    correlationLabel: string;
    sample: { injected: number; notInjected: number };
    segments: Record<string, { taskCount: number } | null>;
  };
  assert.equal(rendered.enabled, true);
  assert.equal(rendered.comparisonRendered, true);
  assert.equal(
    rendered.correlationLabel,
    "correlational — not causal; sessions with and without context are not randomized",
  );
  assert.equal(rendered.sample.injected, 22);
  assert.equal(rendered.sample.notInjected, 21);
  assert.equal(rendered.segments.injected?.taskCount, 22);
  assert.equal(rendered.segments.notInjected?.taskCount, 21);

  // Disabled mode: the SAME stable shape, refusing with an enable hint.
  // Features are switched centrally (a project file may only opt out
  // entirely), so disable value measurement in a private central config.
  const centralHome = await mkdtemp(join(tmpdir(), "vm-central-"));
  await mkdir(join(centralHome, "supracortex"), { recursive: true });
  await writeFile(join(centralHome, "supracortex", "config.jsonc"), JSON.stringify({ telemetry: { valueMeasurement: { enabled: false } } }), "utf8");
  const { stdout: disabledStdout } = await execFileAsync(
    process.execPath,
    [CLI, "value-report", "--json"],
    { cwd: root, timeout: 60_000, env: { ...process.env, SUPRACODE_REAL_XDG_CONFIG_HOME: centralHome } },
  );
  const disabled = JSON.parse(disabledStdout) as {
    enabled: boolean;
    comparisonRendered: boolean;
    refusalReason: string | null;
    correlationLabel: string;
  };
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.comparisonRendered, false);
  assert.match(disabled.refusalReason ?? "", /disable/i);
  assert.equal(
    disabled.correlationLabel,
    "correlational — not causal; sessions with and without context are not randomized",
  );
});

test("V13: injectionRecorded deduplicates recent request keys end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "vm-bound-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(
    join(root, ".supracortex", "config.jsonc"),
    JSON.stringify({ enabled: true, telemetry: { valueMeasurement: { enabled: true } } }),
    "utf8",
  );
  await writeFile(join(root, "src/auth.ts"), "export function login() { return true; }\n", "utf8");

  const hooks = await SupraCortex({
    directory: root,
    worktree: root,
    client: {},
    $: async () => ({ stdout: "" }),
  } as never);
  try {
    // Exercise the end-to-end persistence/dedup path with a representative
    // sample. The bounded-set unit tests prove oldest-first eviction and large
    // churn without re-running the full context pipeline thousands of times.
    const total = 24;
    const drive = async (i: number) => {
      const sessionID = `bound-sess-${i}`;
      await hooks["experimental.chat.messages.transform"]?.(
        {} as never,
        {
          messages: [{
            info: { role: "user", sessionID },
            parts: [{ type: "text", text: `BOUND QUERY ${i}` }],
          }],
        } as never,
      );
      const systemOut = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]?.(
        { sessionID, model: {} as never } as never,
        systemOut as never,
      );
    };

    for (let i = 0; i < total; i++) await drive(i);

    // Every distinct request key records exactly one context_injection row.
    const injections = (await readValueEvents(root)).filter(
      (e) => e.eventType === "context_injection",
    );
    assert.equal(injections.length, total, "each distinct request key records exactly one injection");
    const distinctSessions = new Set(injections.map((e) => (e as { sessionId?: string }).sessionId));
    assert.equal(distinctSessions.size, total, "no request key was re-recorded during the first pass");

    // Dedup still works for a recently-seen key (retained inside the window):
    // re-driving the newest key must NOT append another row.
    await drive(total - 1);
    assert.equal(
      (await readValueEvents(root)).filter((e) => e.eventType === "context_injection").length,
      total,
      "a recently-seen request key is still deduplicated",
    );

    // A request key still in the retained window deduplicates as well.
    await drive(0);
    assert.equal(
      (await readValueEvents(root)).filter((e) => e.eventType === "context_injection").length,
      total,
      "recent request keys are deduplicated end to end",
    );
  } finally {
    await hooks.dispose?.();
  }
});

// ---------------------------------------------------------------------------
// Measurement honesty: billed vs estimated split, main/subagent, compactions
// (Wave 2, item 9a). Billed figures are measured ledger deltas; estimates are
// labeled and never a savings basis.
// ---------------------------------------------------------------------------

function makeUsageEvent(eventKey: string, delta: ProviderUsageEvent["delta"]): ProviderUsageEvent {
  return {
    schemaVersion: 2,
    eventKey,
    source: "opencode-host",
    messageId: "m-split",
    sessionId: "s-split",
    provider: "openai",
    model: "gpt-4o",
    observedAt: new Date().toISOString(),
    currency: null,
    cumulative: {
      reportedCost: 0.01,
      inputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: 0,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    },
    delta,
  };
}

function makeSplitToolEvent(
  role: "main" | "subagent" | undefined,
  op: string,
  estimatedTokens?: number,
): ToolExecutionEvent {
  return {
    schemaVersion: 1,
    eventType: "tool_execution",
    recordedAt: new Date().toISOString(),
    taskId: "split-task",
    incarnationId: "split-inc",
    genAi: { "gen_ai.operation.name": op },
    supracortex: {
      "supracortex.latency_ms": 5,
      "supracortex.retry.count": 0,
      ...(role ? { "supracortex.agent.role": role } : {}),
      ...(estimatedTokens !== undefined ? { "supracortex.tokens.estimated": estimatedTokens } : {}),
    },
    estimated: true,
    estimatedFields: ["supracortex.retry.count"],
  };
}

test("V14: per-task report splits billed (measured) vs estimated, main vs subagent, compactions", () => {
  const events: ValueEvent[] = [
    {
      schemaVersion: 1,
      eventType: "context_injection",
      recordedAt: new Date().toISOString(),
      taskId: "split-task",
      incarnationId: "split-inc",
      supracortex: { "supracortex.context.injected": true },
    },
    makeSplitToolEvent("main", "bash", 50),
    makeSplitToolEvent("subagent", "read"),
    makeSplitToolEvent(undefined, "compact-memory"),
    {
      schemaVersion: 1,
      eventType: "provider_usage_link",
      recordedAt: new Date().toISOString(),
      taskId: "split-task",
      incarnationId: "split-inc",
      eventKey: "k1",
      messageId: "m-split",
    },
    {
      schemaVersion: 1,
      eventType: "task_outcome",
      recordedAt: new Date().toISOString(),
      taskId: "split-task",
      incarnationId: "split-inc",
      supracortex: { "supracortex.task.status": "success" },
    },
  ];
  const usage = new Map<string, ProviderUsageEvent>([
    ["k1", makeUsageEvent("k1", {
      reportedCost: 0.01,
      inputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: 0,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    })],
  ]);
  const report = buildValueReport(events, usage);
  const seg = report.segments.injected;
  assert.ok(seg, "injected segment exists");
  // Disjoint billed identity: billed-in = inputExclCache + reads + writes.
  assert.equal(seg.cacheReadTokens, 400);
  assert.equal(seg.cacheWriteTokens, 100);
  assert.equal(seg.billedInputTokens, 600 + 400 + 100);
  // Estimates are labeled and separate from billed.
  assert.equal(seg.estimatedTokens, 50);
  // Main vs subagent split; unknown role is unattributed, never guessed.
  assert.equal(seg.mainToolExecutions, 1);
  assert.equal(seg.subToolExecutions, 1);
  assert.equal(seg.unattributedRoleExecutions, 1);
  // Compactions are counted executions, not tokens saved.
  assert.equal(seg.compactions, 1);
  // One billed vs estimated output line.
  const line = formatValueTokenLine(seg);
  assert.ok(line.includes("billed-in (measured): 1100"), `billed line renders: ${line}`);
  assert.ok(line.includes("estimated tool traffic"), "estimate is labeled");
  assert.ok(line.includes("main 1 / subagent 1"), "role split renders");
  assert.ok(line.includes("compactions observed"), "compaction count renders");
});

test("V15: collector extras keep billed disjoint from estimates; report renders one split block", () => {
  const collector = new MetricsCollector();
  collector.add({
    hostInputTokens: 1000,
    hostOutputTokens: 200,
    providerCacheReadTokens: 400,
    providerCacheWriteTokens: 100,
  });
  collector.recordEstimatedToolTokens(75);
  collector.recordEstimatedToolTokens(Number.NaN);
  collector.recordCompaction();
  collector.recordCompaction(2);
  collector.recordAgentUsage("main", 800, 150);
  collector.recordAgentUsage("subagent", 200, 50);
  assert.equal(collector.billedInputTokens(), 1500, "billed-in = input + reads + writes");
  const extras = collector.extrasSnapshot();
  assert.equal(extras.estimatedToolTokens, 75, "NaN contributes nothing");
  assert.equal(extras.compactionsObserved, 3);
  assert.equal(extras.mainInputTokens, 800);
  assert.equal(extras.subInputTokens, 200);
  const out = formatMetrics(collector.snapshot(), extras);
  assert.ok(out.includes("billed-in (measured): 1500 = input 1000 + cache reads 400 + cache writes 100"), out);
  assert.ok(out.includes("estimated tool traffic (labeled estimate, not billing): 75"), out);
  assert.ok(out.includes("main vs subagent input (measured): main 800 / subagent 200"), out);
  assert.ok(out.includes("compactions observed (counted, not tokens saved): 3"), out);
  // Backward compatible: single-arg call still renders the billed line.
  const plain = formatMetrics(collector.snapshot());
  assert.ok(plain.includes("billed-in (measured): 1500"), plain);
});
