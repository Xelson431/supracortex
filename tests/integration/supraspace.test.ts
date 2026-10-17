/**
 * SupraSpace unification tests. Prove that Cortex and SupraSpace share ONE
 * memory source without conflict:
 *  - projection writes marker-fenced blocks and preserves human free-form text
 *  - projection is idempotent
 *  - ingest reads free-form notes but NEVER re-ingests Cortex's managed block
 *    (loop-safety) and dedups against existing memory
 *  - a full round-trip (ingest -> project) converges
 *  - graph export produces a valid typed graph for the galaxy visualizer
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  JsonlStore,
  resolveConfig,
  planProjection,
  composeFileContent,
  stripManagedBlock,
  ingestFromFiles,
  buildGraphExport,
  BLOCK_BEGIN,
  BLOCK_END,
} from "../../packages/core/src/index.ts";
import type { MemoryEntry } from "../../packages/core/src/index.ts";

function mem(partial: Partial<MemoryEntry> & { id: string; content: string; kind: MemoryEntry["kind"] }): MemoryEntry {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    updatedAt: now,
    confidence: 0.9,
    status: "active",
    sourceReferences: [],
    relatedFiles: [],
    relatedSymbols: [],
    tags: [],
    invalidationRules: [],
    ...partial,
  };
}

async function project(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ci-supra-"));
  const { config } = resolveConfig({ project: { enabled: true, supraspace: { enabled: true, projectMemory: true, ingestNotes: true, syncOnSweep: false }, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  return { dir, engine };
}

// ---- pure projector tests ----

test("composeFileContent preserves human text and appends a managed block", () => {
  const human = "# Architecture\n\nWe use a hexagonal layout.\n";
  const entries = [mem({ id: "1", kind: "fact", content: "auth uses JWT" })];
  const out = composeFileContent(human, entries, Date.now());
  assert.ok(out.includes("hexagonal layout"), "human text preserved");
  assert.ok(out.includes(BLOCK_BEGIN) && out.includes(BLOCK_END), "managed block present");
  assert.ok(out.includes("auth uses JWT"), "entry projected");
});

test("projection is idempotent (re-projecting same entries is a no-op write)", () => {
  const entries = [mem({ id: "1", kind: "decision", content: "adopt pnpm workspaces" })];
  const first = composeFileContent("", entries, 1000);
  // Feed the produced content back in; the free-form part is empty, block replaced.
  const second = composeFileContent(first, entries, 1000);
  assert.equal(second, first, "second projection identical");
});

test("stripManagedBlock removes only the managed block", () => {
  const content =
    "human before\n\n" + BLOCK_BEGIN + "\nmanaged stuff\n" + BLOCK_END + "\n\nhuman after\n";
  const stripped = stripManagedBlock(content);
  assert.ok(stripped.includes("human before"));
  assert.ok(stripped.includes("human after"));
  assert.ok(!stripped.includes("managed stuff"), "managed content removed");
});

test("ingest reads free-form bullets but skips the managed block (loop-safe)", () => {
  const decisions =
    "# Decisions\n\n- We chose Postgres for durability reasons\n\n" +
    BLOCK_BEGIN +
    "\n### Decisions\n- managed decision that must NOT be re-ingested here\n" +
    BLOCK_END +
    "\n";
  const contents = {
    "project.md": "",
    "architecture.md": "",
    "decisions.md": decisions,
    "tasks.md": "",
    "agent-notes.md": "",
    "review-notes.md": "",
  };
  const candidates = ingestFromFiles(contents, 0.6);
  assert.ok(
    candidates.some((c) => c.content.includes("Postgres for durability")),
    "human bullet ingested",
  );
  assert.ok(
    !candidates.some((c) => c.content.includes("must NOT be re-ingested")),
    "managed block NOT ingested (loop-safe)",
  );
});

test("planProjection only schedules writes when content changes", () => {
  const entries = [mem({ id: "1", kind: "fact", content: "uses vite" })];
  const empty = { "project.md": "", "architecture.md": "", "decisions.md": "", "tasks.md": "", "agent-notes.md": "", "review-notes.md": "" };
  const plan1 = planProjection(entries, empty, 1000);
  assert.ok(plan1.writes.has("architecture.md"), "fact -> architecture.md");
  // Now simulate the files already containing that projection.
  const afterContents = { ...empty };
  for (const [f, c] of plan1.writes) afterContents[f] = c;
  const plan2 = planProjection(entries, afterContents, 1000);
  assert.equal(plan2.writes.size, 0, "no rewrite when already up to date");
});

// ---- engine integration ----

test("engine syncSupraSpace: ingest human notes + project structured memory", async () => {
  const { dir, engine } = await project();
  // Seed a .supraspace with human notes.
  await mkdir(join(dir, ".supraspace"), { recursive: true });
  await writeFile(
    join(dir, ".supraspace/decisions.md"),
    "# Decisions\n\n- The team standardized on TypeScript strict mode everywhere\n",
    "utf8",
  );
  // Also record a Cortex-native decision.
  await engine.recordMemory({
    kind: "decision",
    content: "use nodenext module resolution",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "tsconfig.json" }],
  });

  // Sync may already have run opportunistically during init; force one more.
  await engine.syncSupraSpace();

  // End-state assertions (robust to opportunistic sync-on-init/sweep):
  // The human note is now searchable in Cortex memory.
  const found = await engine.searchMemory("typescript strict mode");
  assert.ok(found.length >= 1, "ingested note retrievable in Cortex");

  // decisions.md now contains BOTH the human text and the managed block.
  const decisions = await readFile(join(dir, ".supraspace/decisions.md"), "utf8");
  assert.ok(decisions.includes("strict mode everywhere"), "human text preserved");
  assert.ok(decisions.includes(BLOCK_BEGIN), "managed block written");
  assert.ok(decisions.includes("nodenext module resolution"), "cortex decision projected");
  // Exactly one managed block.
  assert.equal(decisions.split(BLOCK_BEGIN).length - 1, 1, "single managed block");
});

test("repeated syncSupraSpace converges (no unbounded growth / no dup ingest)", async () => {
  const { dir, engine } = await project();
  await mkdir(join(dir, ".supraspace"), { recursive: true });
  await writeFile(
    join(dir, ".supraspace/agent-notes.md"),
    "# Notes\n\n- Implemented the retry logic in the http client wrapper\n",
    "utf8",
  );
  // Run several syncs; regardless of when the first ingest happened, the system
  // must converge: stable file content and no duplicate ingestion.
  await engine.syncSupraSpace();
  const a = await engine.syncSupraSpace();
  const afterA = await readFile(join(dir, ".supraspace/agent-notes.md"), "utf8");
  const b = await engine.syncSupraSpace();
  const afterB = await readFile(join(dir, ".supraspace/agent-notes.md"), "utf8");

  assert.equal(a.ingestedRecorded, 0, "steady state: no re-ingest (dedup + loop-safe)");
  assert.equal(b.ingestedRecorded, 0, "still stable");
  assert.equal(afterA, afterB, "file content converged (idempotent projection)");
  // The note was ingested exactly once total.
  const found = await engine.searchMemory("retry logic http client");
  const ingested = found.filter((m) => m.entry.content.includes("retry logic"));
  assert.equal(ingested.length, 1, "note ingested exactly once (no duplicates)");
  // Only ONE managed block ever exists.
  assert.equal(afterB.split(BLOCK_BEGIN).length - 1, 1, "exactly one managed block");
});

test("disabled supraspace config skips sync", async () => {
  const { engine } = await project({ supraspace: { enabled: false } });
  const report = await engine.syncSupraSpace();
  assert.ok(report.skippedReason?.includes("disabled"));
});

test("sync is a no-op when there is no .supraspace directory", async () => {
  const { engine } = await project();
  const report = await engine.syncSupraSpace();
  assert.ok(report.skippedReason?.includes("no .supraspace"));
});

test("exportGraph produces a valid typed graph for the visualizer", async () => {
  const { engine } = await project();
  await engine.recordMemory({
    kind: "constraint",
    content: "never write to the production database directly",
    confidence: 0.95,
    sourceReferences: [{ kind: "file", value: "db/config.ts" }],
    relatedFiles: ["db/config.ts"],
  });
  await engine.recordMemory({
    kind: "decision",
    content: "use drizzle for migrations",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "drizzle.config.ts" }],
  });
  await engine.claimFiles("task-42", ["db/config.ts"], { sessionId: "s1", title: "harden db" });

  const graph = await engine.exportGraph();
  assert.ok(graph);
  // Root exists exactly once.
  assert.equal(graph!.nodes.filter((n) => n.kind === "root").length, 1);
  // Memory-kind groupings + entities present.
  assert.ok(graph!.nodes.some((n) => n.kind === "constraint"));
  assert.ok(graph!.nodes.some((n) => n.kind === "decision"));
  // Task + ownership edge present.
  assert.ok(graph!.nodes.some((n) => n.kind === "task" && n.label.includes("harden db")));
  assert.ok(graph!.edges.some((e) => e.relation === "owns"));
  // Every edge references existing nodes (graph integrity).
  const ids = new Set(graph!.nodes.map((n) => n.id));
  for (const e of graph!.edges) {
    assert.ok(ids.has(e.source), `edge source ${e.source} exists`);
    assert.ok(ids.has(e.target), `edge target ${e.target} exists`);
  }
  assert.equal(graph!.stats.memoryEntries, 2);
});

test("buildGraphExport is pure and deterministic for the same input", () => {
  const memory = [mem({ id: "a", kind: "fact", content: "x", relatedFiles: ["a.ts"] })];
  const g1 = buildGraphExport({ memory, now: 1000 });
  const g2 = buildGraphExport({ memory, now: 1000 });
  assert.deepEqual(g1, g2);
});
