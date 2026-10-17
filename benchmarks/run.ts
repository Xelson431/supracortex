/**
 * Deterministic offline quality harness. Loads committed fixtures into a temp
 * Engine and scores retrieval, exclusion, redaction, handoff completeness, and
 * token-budget conformance. Deterministic (injected clock, fixed inputs). Timing
 * is printed but never a pass/fail assertion.
 */

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodeGraph, Engine, JsonlStore, resolveConfig } from "../packages/core/src/index.ts";
import type { RepositoryIndex } from "../packages/core/src/index.ts";

export interface BenchResult { name: string; pass: boolean; detail: string; }

const FIXED_NOW = Date.UTC(2026, 0, 2);
const here = dirname(fileURLToPath(import.meta.url));

async function seededEngine(): Promise<{ engine: Engine; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sc-bench-"));
  await mkdir(join(dir, ".supracortex", "memory"), { recursive: true });
  const fixture = await readFile(join(here, "fixtures", "memory.jsonl"), "utf8");
  await writeFile(join(dir, ".supracortex", "memory", "durable.jsonl"), fixture, "utf8");
  const { config } = resolveConfig({ project: { enabled: true, context: { maxTokens: 4000 } } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.2.0", projectRoot: dir, now: () => FIXED_NOW });
  return { engine, dir };
}

/** Labelled query set: query -> ids expected in the top results. */
const QUERIES: Array<{ q: string; relevant: string[] }> = [
  { q: "default storage driver portability", relevant: ["m1"] },
  { q: "redact secrets before persisting", relevant: ["m2"] },
  { q: "core must not import opencode", relevant: ["m3"] },
  { q: "deterministic lexical retrieval no embeddings", relevant: ["m6"] },
];

export async function runBenchmarks(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const { engine } = await seededEngine();
  await engine.ensureIndex();

  // 1. Retrieval precision@5 / recall on labelled queries.
  let hits = 0;
  let total = 0;
  for (const { q, relevant } of QUERIES) {
    const sel = await engine.searchMemory(q);
    const topIds = sel.slice(0, 5).map((s) => s.entry.id);
    for (const r of relevant) { total++; if (topIds.includes(r)) hits++; }
  }
  const recall = total ? hits / total : 0;
  results.push({ name: "retrieval recall@5", pass: recall >= 0.75, detail: `${hits}/${total} = ${recall.toFixed(2)}` });

  // 2. Graph extraction is intentionally conservative: it must retain only
  // indexed local modules and make no claims about external dependencies.
  const graphIndex: RepositoryIndex = {
    version: 2, root: "/not-exported", generatedAt: new Date(FIXED_NOW).toISOString(),
    files: {
      "src/entry.ts": { path: "src/entry.ts", hash: "a".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: ["billingEntry"], imports: ["src/helper", "third-party"], indexedAt: new Date(FIXED_NOW).toISOString(), mtimeMs: FIXED_NOW },
      "src/helper.ts": { path: "src/helper.ts", hash: "b".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: ["helper"], imports: [], indexedAt: new Date(FIXED_NOW).toISOString(), mtimeMs: FIXED_NOW },
    },
  };
  const graph = buildCodeGraph({ index: graphIndex, projectFingerprint: "c".repeat(64), generatedAt: new Date(FIXED_NOW).toISOString() });
  const localImports = graph.edges.filter((edge) => edge.kind === "imports");
  const graphSafe = localImports.length === 1 && graph.accounting.unresolvedImports === 1 && localImports.every((edge) => graph.nodes.some((node) => node.id === edge.from) && graph.nodes.some((node) => node.id === edge.to));
  results.push({ name: "graph local-edge integrity", pass: graphSafe, detail: `${localImports.length} local, ${graph.accounting.unresolvedImports} unresolved` });

  // 3. Stale/candidate exclusion: m7 (stale) and m8 (candidate) never returned.
  const broad = await engine.searchMemory("cache deployment topology note");
  const leaked = broad.filter((s) => s.entry.id === "m7" || s.entry.id === "m8");
  results.push({ name: "stale/candidate excluded", pass: leaked.length === 0, detail: `${leaked.length} leaked` });

  // 3. Secret redaction: a fake secret must not survive into stored memory.
  const secret = "sk-live-ABCDEF1234567890ABCDEF1234567890";
  const rec = await engine.recordMemory({
    kind: "fact",
    content: `deploy token is ${secret} keep private`,
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: "README.md" }],
  });
  const stored = rec.entry?.content ?? "";
  results.push({ name: "secret redaction", pass: !stored.includes(secret), detail: rec.redacted ? "redacted" : "NOT redacted" });

  // 4. Handoff completeness after round-trip.
  const capsule = await engine.createHandoff({ goal: "ship the release", completedWork: ["wrote harness"], nextActions: ["run CI"] });
  const complete = !!capsule && capsule.schemaVersion === 1 && capsule.goal.length > 0 && typeof capsule.eventWatermark !== "undefined" && Array.isArray(capsule.changedFiles);
  results.push({ name: "handoff completeness", pass: complete, detail: capsule ? `id ${capsule.id.slice(0, 8)}` : "null" });

  // 5. Token-budget conformance.
  const packet = await engine.prepareContext({ query: "storage retrieval redaction architecture" });
  const withinBudget = !!packet && packet.estimatedTokens <= packet.budget.maxTokens;
  results.push({ name: "token-budget conformance", pass: withinBudget, detail: packet ? `${packet.estimatedTokens}/${packet.budget.maxTokens}` : "no packet" });

  return results;
}

// Direct execution prints a scorecard (used by the `bench` npm script).
if (import.meta.url === `file://${process.argv[1]}`) {
  const started = Date.now();
  const results = await runBenchmarks();
  const pad = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    process.stdout.write(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}  ${r.detail}\n`);
  }
  const failed = results.filter((r) => !r.pass).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} passed in ${Date.now() - started}ms (timing is diagnostic only)\n`);
  process.exit(failed ? 1 : 0);
}
