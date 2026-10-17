/**
 * P04 unit (network-free): contracts, result collector, request validation,
 * prompt composition. Live execution is tests/integration/pi-child-live.test.ts.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentDefinition } from "../../packages/pi/src/agents.ts";
import { assemblePrompt, runChild, type ChildSpec } from "../../packages/pi/src/child-runner.ts";
import { CHILD_RESULT_JSON_MAX_BYTES, parseChildResult } from "../../packages/pi/src/contracts.ts";
import { cortexSubmitResultTool, createResultCollector } from "../../packages/pi/src/result-tool.ts";

const AGENT: AgentDefinition = {
  name: "explorer",
  description: "test explorer",
  thinking: "low",
  tools: ["read", "grep", "find", "ls", "cortex_submit_result"],
  skills: [],
  body: "Explore read-only.",
  layer: "bundled",
  path: "explorer.md",
};

function spec(): ChildSpec {
  return {
    role: "explorer",
    brief: "Read alpha.txt.",
    agent: AGENT,
    model: { provider: "p", id: "m" },
    cwd: "/tmp/pi-child-test",
    agentDir: "/tmp/pi-child-agent",
    packetText: "[supracortex context rev=abc]\n- memory one",
    timeoutMs: 60000,
  };
}

test("child result contract: valid, invalid, oversize", () => {
  const valid = parseChildResult({
    schemaVersion: 1,
    summary: "done",
    findings: [{ text: "f", files: ["a.txt"], evidenceIds: [] }],
    recommendedActions: [],
    unresolved: [],
  });
  assert.equal(valid.summary, "done");
  assert.throws(() => parseChildResult({ schemaVersion: 1, summary: "", findings: [], recommendedActions: [], unresolved: [] }), /summary/);
  assert.throws(() => parseChildResult({ schemaVersion: 2, summary: "x", findings: [], recommendedActions: [], unresolved: [] }), /schemaVersion/);
  const big = "x".repeat(CHILD_RESULT_JSON_MAX_BYTES + 1);
  assert.throws(() => parseChildResult({ schemaVersion: 1, summary: big, findings: [], recommendedActions: [], unresolved: [] }), /exceeds/);
});

test("result tool: first valid wins, invalid is repairable", async () => {
  const collector = createResultCollector();
  const tool = cortexSubmitResultTool(collector);
  assert.equal(tool.name, "cortex_submit_result");
  const bad = await tool.execute("1", { summary: "", findings: [], recommendedActions: [], unresolved: [] }, undefined, undefined, undefined as never);
  assert.match((bad.content[0] as { text: string }).text, /rejected/);
  assert.equal(collector.accepted === null, true);
  const good = await tool.execute(
    "2",
    { summary: "s", findings: [{ text: "f", files: [], evidenceIds: [] }], recommendedActions: [], unresolved: ["u"] },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match((good.content[0] as { text: string }).text, /accepted/);
  assert.equal(collector.submissions, 2);
  const late = await tool.execute(
    "3",
    { summary: "other", findings: [], recommendedActions: [], unresolved: [] },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match((late.content[0] as { text: string }).text, /already accepted/);
  assert.equal(collector.accepted?.summary, "s");
});

test("runChild rejects oversized brief/handoff before any provider use", async () => {
  await assert.rejects(runChild({ ...spec(), brief: "" }), /brief/);
  await assert.rejects(runChild({ ...spec(), brief: "x".repeat(8001) }), /brief/);
  await assert.rejects(
    runChild({ ...spec(), handoff: { text: "y".repeat(9000), evidenceIds: [] } }),
    /handoff/,
  );
  const tooMany = { ...spec(), handoff: { text: "ok", evidenceIds: Array.from({ length: 21 }, (_, i) => `e${i}`) } };
  await assert.rejects(runChild(tooMany), /handoff/);
});

test("prompt assembly: role, repo, packet, brief, handoff; no parent transcript", () => {
  const text = assemblePrompt(spec(), "### AGENTS.md\nBe nice.", "");
  assert.ok(text.includes("# Role: explorer"));
  assert.ok(text.includes("Be nice."));
  assert.ok(text.includes("memory one"));
  assert.ok(text.includes("Read alpha.txt."));
  assert.ok(text.includes("cortex_submit_result"));
  assert.ok(!text.includes("SEALED-PARENT-TRANSCRIPT"));
  const withHandoff = assemblePrompt(
    { ...spec(), handoff: { text: "parent note", evidenceIds: ["e1"] } },
    "",
    "",
  );
  assert.ok(withHandoff.includes("parent note"));
  assert.ok(withHandoff.includes("e1"));
});
