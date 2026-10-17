/**
 * P07: command text builders + extension command wiring (fake host).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../../packages/pi/src/agents.ts";
import { agentsText, cortexText, jobsText, type CommandDeps } from "../../packages/pi/src/commands.ts";
import supracortexExtension from "../../packages/pi/src/extension.ts";
import { CortexService } from "../../packages/pi/src/service.ts";

const AGENT: AgentDefinition = {
  name: "explorer",
  description: "looks around",
  model: { provider: "p", id: "m" },
  thinking: "low",
  tools: ["read"],
  skills: [],
  body: "b",
  layer: "project",
  path: "explorer.md",
};

async function deps(): Promise<CommandDeps> {
  const project = mkdtempSync(join(tmpdir(), "pi-cmds-"));
  const service = await CortexService.create(project);
  return { service, cli: null, agents: new Map([["explorer", AGENT]]), supervisor: null, mainModel: { provider: "m", id: "mm" } };
}

test("agents text: list, detail, unknown, unconfigured model", async () => {
  const d = await deps();
  try {
    const list = agentsText(d, "");
    assert.ok(list.includes("explorer") && list.includes("project") && list.includes("p/m (agent)"));
    const detail = agentsText(d, "explorer");
    assert.ok(detail.includes("tools: read") && detail.includes("looks around"));
    assert.ok(agentsText(d, "nope").includes("unknown role"));
    const bare = await deps();
    try {
      bare.agents = new Map([{ ...AGENT, model: undefined, name: "bare" }].map((a) => [a.name, a]));
      delete bare.mainModel;
      assert.ok(agentsText(bare, "").includes("unconfigured"));
    } finally {
      await bare.service.close();
    }
  } finally {
    await d.service.close();
  }
});

test("jobs text: unavailable supervisor, live list, cancel/result routing", async () => {
  const d = await deps();
  try {
    assert.equal(await jobsText({ ...d, supervisor: null }, ""), "job supervisor unavailable");
    const fake = {
      listLive: () => [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", role: "explorer", state: "running" as const, stuck: false }],
      limits: () => ({ maxRunning: 2, maxQueued: 8, timeoutMs: 1000 }),
      isAdmissionsBlocked: () => false,
      cancel: async () => "cancelled",
      loadResultText: async () => "summary: done",
      currentRunId: "run-x",
    };
    const status = await jobsText({ ...d, supervisor: fake as never }, "");
    assert.ok(status.includes("1 live") && status.includes("aaaaaaaa"));
    const cancelled = await jobsText({ ...d, supervisor: fake as never }, "cancel aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.ok(cancelled.includes("cancelled"));
    const result = await jobsText({ ...d, supervisor: fake as never }, "result aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.ok(result.includes("done"));
  } finally {
    await d.service.close();
  }
});

test("cortex text surfaces state, jev, caps, roles, storage", async () => {
  const d = await deps();
  try {
    const text = cortexText(d);
    assert.ok(text.includes("cortex: enabled"));
    assert.ok(text.includes("decision: on via jev/typesafe/jev-1.13 (budget 800ms/req)"));
    assert.ok(text.includes("jev usage (measured, this process): 0 input / 0 output tokens · 0 validated responses"));
    assert.ok(text.includes("main 4000 / child 2000"));
    assert.ok(text.includes("roles: explorer"));
    assert.ok(text.includes("storage:"));
  } finally {
    await d.service.close();
  }
});

test("extension registers commands idempotently; /agents handler notifies", async () => {
  const project = mkdtempSync(join(tmpdir(), "pi-cmdext-"));
  const commands = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const hooks = new Map<string, unknown>();
  const notified: string[] = [];
  const fakePi = {
    registerFlag: () => undefined,
    registerCommand: (name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) => {
      commands.set(name, def.handler);
    },
    registerTool: () => undefined,
    on: (event: string, handler: unknown) => {
      hooks.set(event, handler);
      return () => undefined;
    },
    sendUserMessage: () => undefined,
  };
  supracortexExtension(fakePi as never);
  supracortexExtension(fakePi as never); // reload must not crash
  assert.ok(commands.has("cortex") && commands.has("agents") && commands.has("jobs"));
  assert.ok(hooks.has("context") && hooks.has("turn_end") && hooks.has("session_shutdown"));
  const ctx = { cwd: project, ui: { notify: (m: string) => void notified.push(m), setStatus: () => undefined } } as never;
  await commands.get("agents")!("", ctx);
  assert.ok(notified.some((m) => m.includes("explorer") || m.includes("no agent roles")));
  await commands.get("cortex")!("", ctx);
  assert.ok(notified.some((m) => m.includes("cortex:")));
});
