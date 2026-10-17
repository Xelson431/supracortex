/**
 * P05 live background E2E (OPT-IN: SUPRACORTEX_LIVE_TESTS=1).
 * Real supervisor + real runChild: background delegate returns while the
 * parent continues, result persists, delivery goes to the original parent.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../../packages/pi/src/agents.ts";
import { JobStore } from "../../packages/pi/src/job-store.ts";
import { CortexService } from "../../packages/pi/src/service.ts";
import { Supervisor } from "../../packages/pi/src/supervisor.ts";

const LIVE = process.env["SUPRACORTEX_LIVE_TESTS"] === "1";

const AGENT: AgentDefinition = {
  name: "explorer",
  description: "test explorer",
  thinking: "low",
  tools: ["read", "grep", "find", "ls", "cortex_submit_result"],
  skills: [],
  body: "Explore read-only. Report exactly what you are asked and nothing else.",
  layer: "bundled",
  path: "explorer.md",
};

test("background delegate completes, persists, and notifies the parent", { skip: !LIVE }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pi-jobslive-"));
  writeFileSync(join(project, "gamma.txt"), "SEALED-GAMMA-4242\n");
  const service = await CortexService.create(project);
  const store = await JobStore.create(service.storagePath);
  const supervisor = new Supervisor({
    store,
    runId: "run-live-1",
    service,
    cli: null,
    agentDir: getAgentDir(),
    agents: new Map([["explorer", AGENT]]),
    mainModel: { provider: "omniroute", id: "auto/best-fast" },
  });
  try {
    const parent = { sessionFile: join(project, "parent.jsonl"), sessionId: "p1", cwd: project };
    const started = Date.now();
    const bg = (await supervisor.delegate(
      { role: "explorer", task: "Read gamma.txt and submit its sealed code. Brief code SEALED-GAMMA-4242.", mode: "background" },
      parent,
    )) as { jobId: string; state: string };
    // Parent continues: delegate returned fast relative to model work.
    assert.ok(Date.now() - started < 30000, "background delegate must return without awaiting the child");
    assert.equal(bg.state, "queued");
    for (let i = 0; i < 150 && (await supervisor.lookup(bg.jobId)).record.state !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    const { record } = await supervisor.lookup(bg.jobId);
    assert.equal(record.state, "succeeded", `failure: ${record.failureCode}`);
    assert.ok(record.resultPath, "result persisted");
    const text = await supervisor.loadResultText("run-live-1", bg.jobId);
    assert.ok(text?.includes("SEALED-GAMMA-4242"));
    const sent: string[] = [];
    const n = await supervisor.deliverPending({ currentSessionFile: parent.sessionFile, send: (t) => void sent.push(t) });
    assert.equal(n, 1);
    assert.ok(sent[0]!.includes("SEALED-GAMMA-4242"));
  } finally {
    await supervisor.shutdown();
    await service.close();
  }
});
