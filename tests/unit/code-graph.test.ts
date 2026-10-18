import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodeGraph,
  CodeGraphIntegrityError,
  CodeGraphStore,
  DEFAULT_CONFIG,
  decodeCodeGraph,
  Engine,
  graphNeighbors,
  graphPath,
  graphImpact,
  JsonlStore,
} from "../../packages/core/src/index.ts";
import type { RepositoryIndex } from "../../packages/core/src/index.ts";

const fingerprint = "a".repeat(64);
const now = "2026-01-01T00:00:00.000Z";

function index(): RepositoryIndex {
  return {
    version: 2, root: "/not-exported", generatedAt: now,
    files: {
      "src/a.ts": { path: "src/a.ts", hash: "1".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: ["alpha"], imports: ["src/b", "package-only"], indexedAt: now, mtimeMs: 1 },
      "src/b.ts": { path: "src/b.ts", hash: "2".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: ["beta"], imports: ["src/a"], indexedAt: now, mtimeMs: 1 },
    },
  };
}

test("code graph is deterministic, local-only, and resolves only indexed imports", () => {
  const first = buildCodeGraph({ index: index(), projectFingerprint: fingerprint, generatedAt: now });
  const second = buildCodeGraph({ index: index(), projectFingerprint: fingerprint, generatedAt: now });
  assert.deepEqual(first, second);
  assert.equal(first.edges.filter((edge) => edge.kind === "imports").length, 2);
  assert.equal(first.accounting.unresolvedImports, 1);
  assert.ok(first.nodes.every((node) => !node.path?.startsWith("/")));
  assert.ok(first.edges.every((edge) => !edge.sourcePath.startsWith("/")));
});

test("code graph import edges always target admitted local file nodes", () => {
  const graph = buildCodeGraph({
    index: {
      version: 2, root: "/not-exported", generatedAt: now,
      files: {
        "src/a.ts": { path: "src/a.ts", hash: "1".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: [], imports: ["src/b"], indexedAt: now, mtimeMs: 1 },
        "src/b.ts": { path: "src/b.ts", hash: "2".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: [], imports: [], indexedAt: now, mtimeMs: 1 },
      },
    },
    projectFingerprint: fingerprint,
    generatedAt: now,
  });
  assert.ok(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.from) && graph.nodes.some((node) => node.id === edge.to)));
});

test("code graph emits one edge when two specifier spellings resolve to the same target", () => {
  // Regression: "../lib/money" + "../lib/money.ts" in one file produced two
  // identical edge ids and failed the whole rebuild with "invalid or duplicated".
  const graph = buildCodeGraph({
    index: {
      version: 2, root: "/not-exported", generatedAt: now,
      files: {
        "src/a.ts": { path: "src/a.ts", hash: "1".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: [], imports: ["src/b", "src/b.ts"], indexedAt: now, mtimeMs: 1 },
        "src/b.ts": { path: "src/b.ts", hash: "2".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: [], imports: [], indexedAt: now, mtimeMs: 1 },
      },
    },
    projectFingerprint: fingerprint,
    generatedAt: now,
  });
  const imports = graph.edges.filter((edge) => edge.kind === "imports");
  assert.equal(imports.length, 1);
  assert.ok(decodeCodeGraph(JSON.parse(JSON.stringify(graph))));
});

test("code graph rejects malformed persisted data before any query can consume it", () => {
  const graph = buildCodeGraph({ index: index(), projectFingerprint: fingerprint, generatedAt: now });
  const malformed = structuredClone(graph) as unknown as { nodes: Array<{ id: string }> };
  malformed.nodes[0]!.id = "not-a-digest";
  assert.throws(() => decodeCodeGraph(malformed), CodeGraphIntegrityError);
});

test("generation store activates only a complete validated graph", async () => {
  const store = new JsonlStore(await mkdtemp(join(tmpdir(), "cortex-graph-")));
  const graphs = new CodeGraphStore(store);
  const graph = buildCodeGraph({ index: index(), projectFingerprint: fingerprint, generatedAt: now });
  await graphs.activate(graph);
  assert.equal((await graphs.readActive())?.generationId, graph.generationId);
  const invalid = structuredClone(graph) as unknown as { generationId: string };
  invalid.generationId = "broken";
  await assert.rejects(() => graphs.activate(invalid as never), CodeGraphIntegrityError);
  assert.equal((await graphs.readActive())?.generationId, graph.generationId);
  await store.writeJson("graph/manifest.json", { schemaVersion: 1, generationId: graph.generationId, sourceWatermark: graph.sourceWatermark, nodeCount: 1, edgeCount: 1, createdAt: now });
  await assert.rejects(() => graphs.readActive(), CodeGraphIntegrityError);
});

test("a successful replacement reclaims the superseded derived generation", async () => {
  const store = new JsonlStore(await mkdtemp(join(tmpdir(), "cortex-graph-cleanup-")));
  const graphs = new CodeGraphStore(store);
  const first = buildCodeGraph({ index: index(), projectFingerprint: fingerprint, generatedAt: now });
  const changed = index();
  changed.files["src/a.ts"]!.hash = "3".repeat(64);
  const second = buildCodeGraph({ index: changed, projectFingerprint: fingerprint, generatedAt: now });
  await graphs.activate(first);
  await graphs.activate(second);
  assert.equal(await store.exists(`graph/generations/${first.generationId}.json`), false);
  assert.equal(await store.exists(`graph/generations/${second.generationId}.json`), true);
  assert.equal((await graphs.readActive())?.generationId, second.generationId);
});

test("neighbor traversal is cycle-safe and obeys result bounds", () => {
  const graph = buildCodeGraph({ index: index(), projectFingerprint: fingerprint, generatedAt: now });
  const result = graphNeighbors(graph, "path:src/a.ts", { maxDepth: 5, maxResults: 1, maxFanout: 10 });
  assert.equal(result.edges.length, 1);
  assert.equal(result.truncated, true);
  assert.ok(result.nodes.length <= 2);
});

test("neighbor traversal defaults to two hops and honors explicit depth", () => {
  const files: RepositoryIndex["files"] = {};
  const chain = ["a", "b", "c", "d"];
  chain.forEach((name, i) => {
    const next = chain[i + 1];
    files[`src/${name}.ts`] = {
      path: `src/${name}.ts`, hash: String(i + 1).repeat(64), sizeBytes: 1, estimatedTokens: 1,
      language: "typescript", symbols: [name], imports: next ? [`src/${next}`] : [], indexedAt: now, mtimeMs: 1,
    };
  });
  const graph = buildCodeGraph({ index: { version: 2, root: "/not-exported", generatedAt: now, files }, projectFingerprint: fingerprint, generatedAt: now });
  const byDefault = graphNeighbors(graph, "path:src/a.ts");
  assert.ok(byDefault.nodes.some((node) => node.path === "src/c.ts"), "default query reaches two hops");
  const explicitOne = graphNeighbors(graph, "path:src/a.ts", { maxDepth: 1 });
  assert.ok(explicitOne.nodes.some((node) => node.path === "src/b.ts"), "explicit depth 1 reaches one hop");
  assert.ok(!explicitOne.nodes.some((node) => node.path === "src/c.ts"), "explicit depth 1 stops at one hop");
  assert.equal(explicitOne.truncated, true);
});

test("graph selectors reject ambiguous bare labels", () => {
  const graph = buildCodeGraph({ index: index(), projectFingerprint: fingerprint, generatedAt: now });
  assert.throws(() => graphNeighbors(graph, "alpha" as never), /selector/);
  assert.throws(() => graphNeighbors(graph, 1 as never), /string/);
});

test("path and impact queries use bounded directional traversal", () => {
  const graph = buildCodeGraph({ index: index(), projectFingerprint: fingerprint, generatedAt: now });
  const path = graphPath(graph, "path:src/a.ts", "path:src/b.ts", { maxDepth: 3, maxResults: 10 });
  assert.equal(path.edges.length, 1);
  const inbound = graphImpact(graph, "path:src/a.ts", "incoming", { maxDepth: 1, maxResults: 10 });
  assert.ok(inbound.edges.some((edge) => edge.kind === "imports" && edge.from !== edge.to));
});

test("engine graph is opt-in and does not alter normal context behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-graph-engine-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "import { b } from './b'; export const accounting = b;\n", "utf8");
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");
  const disabledConfig = structuredClone(DEFAULT_CONFIG);
  disabledConfig.graph.enabled = false;
  const disabled = new Engine({ config: disabledConfig, store: new JsonlStore(join(root, ".disabled")), pluginVersion: "test", projectRoot: root, now: () => Date.parse(now) });
  assert.equal(await disabled.rebuildCodeGraph(), null);
  const config = structuredClone(DEFAULT_CONFIG);
  config.graph.enabled = true;
  config.graph.automaticContext = false;
  const engine = new Engine({ config, store: new JsonlStore(join(root, ".enabled")), pluginVersion: "test", projectRoot: root, now: () => Date.parse(now) });
  const graph = await engine.rebuildCodeGraph();
  assert.ok(graph && graph.nodes.length >= 3);
  assert.equal((await engine.queryCodeGraphNeighbors("path:src/a.ts"))?.generationId, graph?.generationId);
  assert.deepEqual(await engine.recommendCodeGraphFilesForTask("change accounting"), []);
  config.graph.automaticContext = true;
  assert.ok((await engine.recommendCodeGraphFilesForTask("change accounting")).includes("src/a.ts"));
  await engine.close();
});

test("graph status reports the effective automaticContext setting", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-graph-status-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const graphConfig = (automaticContext: boolean) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.graph.enabled = true;
    config.graph.automaticContext = automaticContext;
    return config;
  };
  const newEngine = (config: typeof DEFAULT_CONFIG, directory: string) =>
    new Engine({ config, store: new JsonlStore(join(root, directory)), pluginVersion: "test", projectRoot: root, now: () => Date.parse(now) });

  const off = newEngine(graphConfig(false), ".off");
  await off.rebuildCodeGraph();
  const offStatus = await off.codeGraphStatus();
  assert.equal(offStatus.available, true);
  assert.equal(offStatus.automaticContext, false);
  await off.close();

  const on = newEngine(graphConfig(true), ".on");
  await on.rebuildCodeGraph();
  const onStatus = await on.codeGraphStatus();
  assert.equal(onStatus.available, true);
  assert.equal(onStatus.automaticContext, true);
  await on.close();

  const unbuilt = newEngine(graphConfig(true), ".unbuilt");
  const unbuiltStatus = await unbuilt.codeGraphStatus();
  assert.equal(unbuiltStatus.available, false);
  assert.equal(unbuiltStatus.automaticContext, false);
  await unbuilt.close();

  const disabledConfig = graphConfig(true);
  disabledConfig.enabled = false;
  const disabled = newEngine(disabledConfig, ".disabled");
  const disabledStatus = await disabled.codeGraphStatus();
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.automaticContext, false);
  await disabled.close();
});

test("graph recommendations expand a direct match by one local import hop only", async () => {
  const root = await mkdtemp(join(tmpdir(), "cortex-graph-recommend-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "entry.ts"), "import { helper } from './helper'; export const billingEntry = helper;\n", "utf8");
  await writeFile(join(root, "src", "helper.ts"), "export const helper = 1;\n", "utf8");
  await writeFile(join(root, "src", "unrelated.ts"), "export const unrelated = 1;\n", "utf8");
  const config = structuredClone(DEFAULT_CONFIG);
  config.graph.enabled = true;
  config.graph.automaticContext = true;
  const engine = new Engine({ config, store: new JsonlStore(join(root, ".supracortex")), pluginVersion: "test", projectRoot: root, now: () => Date.parse(now) });
  await engine.rebuildCodeGraph();
  assert.deepEqual(await engine.recommendCodeGraphFilesForTask("change billing entry", 3), ["src/entry.ts", "src/helper.ts"]);
  await engine.close();
});

// --- Module 8: extractor upgrades (regex default, tree-sitter opt-in, SCIP stub) ---

test("structured extraction finds nested/multiline defs the regex baseline misses", async () => {
  const { extractSymbolsRegex, extractSymbolsStructured } = await import("../../packages/core/src/graph/extractor.ts");
  const py = "class MyClass:\n    async def my_method(\n        self,\n        arg,\n    ):\n        pass\n";
  const regex = extractSymbolsRegex(py, "python");
  const structured = extractSymbolsStructured(py, "python");
  assert.ok(!regex.includes("my_method"), `regex unexpectedly found my_method: ${regex}`);
  assert.ok(structured.includes("MyClass") && structured.includes("my_method"), `structured missed: ${structured}`);
  const ts = "export class Store {\n  my_method(input: string) {\n    return input;\n  }\n}\n";
  assert.ok(!extractSymbolsRegex(ts, "typescript").includes("my_method"));
  assert.ok(extractSymbolsStructured(ts, "typescript").includes("my_method"));
});

test("import validator ignores commented-out imports", async () => {
  const { extractImportsRobust } = await import("../../packages/core/src/graph/extractor.ts");
  const ts = "// import { ghost } from './ghost';\nimport { real } from './real';\n";
  assert.deepEqual(extractImportsRobust(ts, "typescript", "src/a.ts"), ["src/real"]);
  const py = "# import ghost\n# from ghost import x\nimport real_mod\n";
  assert.deepEqual(extractImportsRobust(py, "python", "src/a.py"), ["real_mod"]);
});

test("regex default keeps single-file def recall >= 95%", async () => {
  const { extractSymbolsRegex } = await import("../../packages/core/src/graph/extractor.ts");
  const defs = Array.from({ length: 20 }, (_, i) => `def func_${i}():\n    pass`).join("\n");
  const found = extractSymbolsRegex(defs, "python");
  assert.ok(found.length / 20 >= 0.95, `recall ${found.length}/20`);
});

test("cap, allowlist, and grammar-missing fallbacks always carry a reason", async () => {
  const { extractFile } = await import("../../packages/core/src/graph/extractor.ts");
  const many = Array.from({ length: 10 }, (_, i) => `def func_${i}():\n    pass`).join("\n");
  const capped = extractFile("src/a.py", many, "python", { maxSymbolsPerFile: 3 });
  assert.equal(capped.truncated, true);
  assert.match(capped.reason ?? "", /cap/);
  const denied = extractFile("src/a.exe", many, undefined, {});
  assert.equal(denied.truncated, true);
  assert.match(denied.reason ?? "", /allowlist/);
  const fallback = extractFile("src/a.go", "package a\nfunc Main() {}\n", "go", { mode: "tree-sitter" });
  assert.equal(fallback.extractor, "regex-fallback");
  assert.match(fallback.reason ?? "", /grammar missing/);
});

test("incremental re-parse touches only the edited subtree", async () => {
  const { incrementalExtract } = await import("../../packages/core/src/graph/extractor.ts");
  const oldContent = "class A:\n    def one(self):\n        pass\n\nclass B:\n    def two(self):\n        pass\n";
  const newContent = "class A:\n    def one(self):\n        pass\n\nclass B:\n    def two_renamed(self):\n        pass\n";
  const result = incrementalExtract({ oldContent, newContent, language: "python", editedRange: { start: 6, end: 6 } });
  assert.ok(result.symbols.includes("two_renamed"));
  assert.ok(result.reparsedLines < newContent.split("\n").length, `reparsed ${result.reparsedLines} of full file`);
});

test("SCIP sidecar is on-demand only and never auto-indexes", async () => {
  const { queryScipRefs, RENAME_REFS_LIMIT_NOTE, symbolAnchorId } = await import("../../packages/core/src/graph/extractor.ts");
  const skipped = queryScipRefs({ indexPath: "no/such/index.scip", symbol: "MyClass#my_method" });
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.reason, /on-demand only|not found/);
  assert.ok(RENAME_REFS_LIMIT_NOTE.includes("SCIP"));
  assert.ok(symbolAnchorId(fingerprint, "src/a.ts", "alpha").includes("src/a.ts#alpha"));
});

test("content-aware build surfaces nested defs and logs cap reasons", () => {
  const pyIndex: RepositoryIndex = {
    version: 2, root: "/not-exported", generatedAt: now,
    files: {
      "src/nested.py": { path: "src/nested.py", hash: "4".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "python", symbols: ["MyClass"], imports: [], indexedAt: now, mtimeMs: 1 },
    },
  };
  const content = "class MyClass:\n    async def my_method(\n        self,\n    ):\n        pass\n";
  const baseline = buildCodeGraph({ index: pyIndex, projectFingerprint: fingerprint, generatedAt: now });
  assert.ok(!baseline.nodes.some((n) => n.symbol === "my_method"));
  const upgraded = buildCodeGraph({
    index: pyIndex, projectFingerprint: fingerprint, generatedAt: now,
    sources: { "src/nested.py": content }, extraction: { mode: "tree-sitter" },
  });
  assert.ok(upgraded.nodes.some((n) => n.symbol === "my_method"), "nested def missing from upgraded graph");
  const capped = buildCodeGraph({
    index: pyIndex, projectFingerprint: fingerprint, generatedAt: now,
    sources: { "src/nested.py": content }, extraction: { mode: "tree-sitter", maxSymbolsPerFile: 1 },
  });
  assert.ok(
    capped.omissions.some((o) => "reason" in o && typeof (o as { reason?: string }).reason === "string"),
    "cap hit must log a reason",
  );
});

// --- Graph minors: distinct partial reasons + bounded query cost ---

test("partial reasons stay distinct across truncation, fallback, and scip-skip", async () => {
  const { classifyPartialReason } = await import("../../packages/core/src/graph/builder.ts");
  const cap = classifyPartialReason("symbol cap 3 hit: src/a.py");
  const grammar = classifyPartialReason("grammar missing for language 'go'; regex fallback");
  const budget = classifyPartialReason("per-file budget 25ms exceeded: src/a.ts");
  const scip = classifyPartialReason("SCIP index not found at x.scip; on-demand only, refusing to auto-index (TS sidecar)");
  assert.match(cap, /^truncation:/);
  assert.match(grammar, /^per-file-fallback:/);
  assert.match(budget, /^per-file-fallback:/);
  assert.match(scip, /^scip-skip:/);
  assert.notEqual(new Set([cap.split(":")[0], grammar.split(":")[0], scip.split(":")[0]]).size < 3, true);
  // End-to-end: a capped content-aware build surfaces a namespaced reason, never a bare partial.
  const cappedIndex: RepositoryIndex = {
    version: 2, root: "/not-exported", generatedAt: now,
    files: {
      "src/a.py": { path: "src/a.py", hash: "5".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "python", symbols: ["A"], imports: [], indexedAt: now, mtimeMs: 1 },
    },
  };
  const many = Array.from({ length: 5 }, (_, i) => `def func_${i}():\n    pass`).join("\n");
  const graph = buildCodeGraph({
    index: cappedIndex, projectFingerprint: fingerprint, generatedAt: now,
    sources: { "src/a.py": many }, extraction: { maxSymbolsPerFile: 2 },
  });
  const reasons = graph.omissions.map((o) => (o as { reason?: string }).reason ?? "");
  assert.ok(reasons.length > 0 && reasons.every((r) => r.length > 0), "every omission must carry a reason");
  assert.ok(reasons.some((r) => r.startsWith("truncation:")), `expected a truncation reason, got ${reasons}`);
});

test("large-graph neighbor query stays bounded and reasons the cut", () => {
  const files: RepositoryIndex["files"] = {};
  const hubImports = Array.from({ length: 60 }, (_, i) => `src/leaf-${i}`);
  for (let i = 0; i < 60; i++) {
    files[`src/leaf-${i}.ts`] = { path: `src/leaf-${i}.ts`, hash: String(i % 10).repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: [`leaf${i}`], imports: [], indexedAt: now, mtimeMs: 1 };
  }
  files["src/hub.ts"] = { path: "src/hub.ts", hash: "f".repeat(64), sizeBytes: 1, estimatedTokens: 1, language: "typescript", symbols: ["hub"], imports: hubImports, indexedAt: now, mtimeMs: 1 };
  const graph = buildCodeGraph({ index: { version: 2, root: "/not-exported", generatedAt: now, files }, projectFingerprint: fingerprint, generatedAt: now });
  const result = graphNeighbors(graph, "path:src/hub.ts", { maxDepth: 2, maxResults: 10, maxFanout: 5 });
  assert.ok(result.edges.length <= 10, `edges ${result.edges.length} exceed bound`);
  assert.ok(result.nodes.length <= 11, `nodes ${result.nodes.length} exceed bound`);
  assert.equal(result.truncated, true);
  assert.match(result.reason ?? "", /truncated:/);
});
