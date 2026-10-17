/**
 * P04 live child isolation (OPT-IN: SUPRACORTEX_LIVE_TESTS=1).
 * Uses host Pi auth (OmniRoute fast model). Two concurrent children must not
 * leak transcript content to each other; read evidence must be per-child.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runChild, type ChildSpec } from "../../packages/pi/src/child-runner.ts";
import type { AgentDefinition } from "../../packages/pi/src/agents.ts";

const LIVE = process.env["SUPRACORTEX_LIVE_TESTS"] === "1";
const MODEL = { provider: "omniroute", id: "auto/best-fast" };

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

test("concurrent children keep transcript content isolated", { skip: !LIVE }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pi-live-"));
  // Auth intentionally shared from the host agent dir (key never enters transcripts);
  // isolation comes from loader flags + tool allowlist + in-memory session/settings.
  const agentDir = getAgentDir();
  writeFileSync(join(project, "alpha.txt"), "SEALED-ALPHA-7741\n");
  writeFileSync(join(project, "beta.txt"), "SEALED-BETA-1138\n");

  const base: Omit<ChildSpec, "brief"> = {
    role: "explorer",
    agent: AGENT,
    model: MODEL,
    cwd: project,
    agentDir,
    packetText: "[supracortex context rev=live]\n(no project memory)",
    timeoutMs: 180000,
  };
  const [a, b] = await Promise.all([
    runChild({ ...base, brief: "Read the file alpha.txt and submit its sealed code. Brief code SEALED-ALPHA-7741." }),
    runChild({ ...base, brief: "List the files in this directory with ls and submit their names. Do not read file contents." }),
  ]);

  assert.equal(a.failureCode, undefined, `child A failed: ${a.failureCode} fallback=${a.textFallback}`);
  assert.equal(b.failureCode, undefined, `child B failed: ${b.failureCode} fallback=${b.textFallback}`);
  assert.ok(a.result, "child A must submit a structured result");
  assert.ok(b.result, "child B must submit a structured result");
  const aText = JSON.stringify(a.result);
  const bText = JSON.stringify(b.result);
  assert.ok(aText.includes("SEALED-ALPHA-7741"), "child A reports its own sealed code");
  assert.ok(!bText.includes("SEALED-ALPHA-7741"), "child B must not see child A's sealed code");
  assert.ok(a.reads.some((r) => r.path === "alpha.txt" || r.canonical.endsWith("alpha.txt")), "A read alpha.txt");
  assert.ok(a.reads.every((r) => r.canonical.startsWith(project)), "A reads confined to project");
  assert.ok(!b.reads.some((r) => r.canonical.endsWith("alpha.txt")), "B never read alpha.txt");
  for (const r of a.reads) assert.ok(typeof r.hash === "string" || r.hash === null);
});
