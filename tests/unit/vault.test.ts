import test from "node:test";
import assert from "node:assert/strict";
import { buildVaultProjection } from "../../packages/core/src/index.ts";

test("vault projection is a faithful, stable view of Cortex memory", () => {
  const snapshot = {
    schemaVersion: 1 as const,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: { generatedAt: "2026-01-01T00:00:00.000Z", nodes: [], edges: [], stats: { memoryEntries: 1, activeTasks: 0, ownedFiles: 0 } },
    memory: [{ id: "dec-1", kind: "decision" as const, content: "Use SupraCortex as the only memory backend.", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", confidence: 0.9, status: "active" as const, sourceReferences: [{ kind: "file" as const, value: "README.md", lines: [1, 2] as [number, number] }], relatedFiles: ["README.md"], relatedSymbols: [], tags: ["architecture"], invalidationRules: [] }],
    activeTasks: [], ownership: null,
  };
  const { files, manifest } = buildVaultProjection(snapshot);
  const note = files.get("Memory/Decisions/dec-1.md") ?? "";
  assert.match(note, /id: "dec-1"/);
  assert.match(note, /Use SupraCortex as the only memory backend/);
  assert.match(note, /README.md:1-2/);
  assert.ok(files.has("Home.md"));
  assert.ok(manifest.files.some((file) => file.path === "Memory/Decisions/dec-1.md" && file.entityId === "dec-1"));
});

test("vault projects a bounded, derived code-graph section without source bodies", () => {
  const fileId = "a".repeat(64);
  const symbolId = "b".repeat(64);
  const snapshot = {
    schemaVersion: 1 as const,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: { generatedAt: "2026-01-01T00:00:00.000Z", nodes: [], edges: [], stats: { memoryEntries: 0, activeTasks: 0, ownedFiles: 0 } },
    codeGraph: {
      schemaVersion: 1, extractorVersion: 1, generationId: "c".repeat(64), projectFingerprint: "d".repeat(64), repositoryId: "e".repeat(64), generatedAt: "2026-01-01T00:00:00.000Z", sourceWatermark: "f".repeat(64),
      nodes: [
        { id: fileId, kind: "file" as const, label: "src/auth.ts", path: "src/auth.ts", language: "typescript", sourceHash: "1".repeat(64), provenance: "repository-index" as const, confidence: "extracted" as const, extractorVersion: 1 },
        { id: symbolId, kind: "symbol" as const, label: "authorize", path: "src/auth.ts", symbol: "authorize", language: "typescript", sourceHash: "1".repeat(64), provenance: "repository-index" as const, confidence: "extracted" as const, extractorVersion: 1 },
      ],
      edges: [{ id: "2".repeat(64), from: fileId, to: symbolId, kind: "defines" as const, provenance: "repository-index" as const, confidence: "extracted" as const, sourcePath: "src/auth.ts", sourceHash: "1".repeat(64) }],
      omissions: [], accounting: { indexedFiles: 1, nodes: 2, edges: 1, unresolvedImports: 0 },
    },
    memory: [], activeTasks: [], ownership: null,
  };
  const { files } = buildVaultProjection(snapshot);
  assert.match(files.get("Home.md") ?? "", /Derived file & symbol graph/);
  assert.match(files.get("Code/Index.md") ?? "", /Indexed files: 1/);
  const note = files.get(`Code/Files/${fileId}.md`) ?? "";
  assert.match(note, /authorize/);
  assert.doesNotMatch(note, /export const|function |class /i);
});

test("vault projection excludes unknown fields and never leaks redacted secrets", () => {
  const raw = {
    id: "fact-1",
    kind: "fact",
    content: 'API_KEY = "sk-abcdef0123456789abcdef"',
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    confidence: 0.9,
    status: "active",
    sourceReferences: [{ kind: "file", value: "a.ts" }],
    relatedFiles: [],
    relatedSymbols: [],
    tags: [],
    invalidationRules: [],
    secret: "sk-abcdef0123456789abcdef",
    apiKey: "TOPSECRET",
  };
  const snapshot = {
    schemaVersion: 1 as const,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: { generatedAt: "2026-01-01T00:00:00.000Z", nodes: [], edges: [], stats: { memoryEntries: 1, activeTasks: 0, ownedFiles: 0 } },
    memory: [raw],
    activeTasks: [],
    ownership: null,
  };
  // @ts-expect-error extra unknown fields by design
  const { files } = buildVaultProjection(snapshot);
  const rendered = [...files.values()].join("\n");
  assert.ok(!rendered.includes("sk-abcdef0123456789abcdef"), "raw secret never rendered");
  assert.ok(!rendered.includes("TOPSECRET"), "unknown field never rendered");
  assert.match(rendered, /\[REDACTED\]/);
});

test("vault projection skips malformed entries instead of rendering raw", () => {
  const snapshot = {
    schemaVersion: 1 as const,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: { generatedAt: "2026-01-01T00:00:00.000Z", nodes: [], edges: [], stats: { memoryEntries: 0, activeTasks: 0, ownedFiles: 0 } },
    memory: [{ id: "bad", kind: "nope", content: 42 }],
    activeTasks: [],
    ownership: null,
  };
  // @ts-expect-error malformed entry by design
  const { files } = buildVaultProjection(snapshot);
  assert.ok(![...files.keys()].some((k) => k.includes("bad")), "malformed entry skipped");
});

test("vault projection preserves trust states and never collapses to active", () => {
  const memory = ["stale", "candidate", "disputed", "forgotten", "superseded", "active", "retracted", "bogus"].map((status, i) => ({
    id: `mem-${i}`, kind: "fact" as const, content: `entry ${i}`, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", confidence: 0.5, status, sourceReferences: [],
    relatedFiles: [], relatedSymbols: [], tags: [], invalidationRules: [],
  }));
  const snapshot = {
    schemaVersion: 1 as const,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: { generatedAt: "2026-01-01T00:00:00.000Z", nodes: [], edges: [], stats: { memoryEntries: 8, activeTasks: 0, ownedFiles: 0 } },
    memory, activeTasks: [], ownership: null,
  };
  // @ts-expect-error legacy + unknown statuses by design
  const { files } = buildVaultProjection(snapshot);
  const expected = ["stale", "candidate", "disputed", "forgotten", "superseded", "active", "forgotten", "forgotten"];
  expected.forEach((status, i) => {
    const note = files.get(`Memory/Facts/mem-${i}.md`) ?? "";
    assert.match(note, new RegExp(`status: "${status}"`), `mem-${i} projects as ${status}`);
  });
  for (const i of [0, 1, 2, 3]) {
    assert.doesNotMatch(files.get(`Memory/Facts/mem-${i}.md`) ?? "", /status: "active"/, `mem-${i} never active`);
  }
});

test("vault projection retains commit/command/external evidence, drops url/note", () => {
  const raw = {
    id: "ev-1", kind: "fact", content: "evidence kinds", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", confidence: 0.7, status: "stale",
    sourceReferences: [
      { kind: "commit", value: "abc123" }, { kind: "command", value: "pnpm test" },
      { kind: "external", value: "https://example.com" }, { kind: "file", value: "a.ts" },
      { kind: "url", value: "https://legacy.example" }, { kind: "note", value: "legacy note" },
    ],
    relatedFiles: [], relatedSymbols: [], tags: [], invalidationRules: [],
  };
  const snapshot = {
    schemaVersion: 1 as const,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: { generatedAt: "2026-01-01T00:00:00.000Z", nodes: [], edges: [], stats: { memoryEntries: 1, activeTasks: 0, ownedFiles: 0 } },
    memory: [raw], activeTasks: [], ownership: null,
  };
  // @ts-expect-error legacy ref kinds by design
  const { files } = buildVaultProjection(snapshot);
  const note = files.get("Memory/Facts/ev-1.md") ?? "";
  assert.match(note, /status: "stale"/);
  for (const want of ["commit: abc123", "command: pnpm test", "external: https://example.com", "file: a.ts"]) {
    assert.ok(note.includes(want), `keeps ${want}`);
  }
  assert.ok(!note.includes("legacy.example") && !note.includes("legacy note"), "url/note refs dropped");
});
