import test from "node:test";
import assert from "node:assert";
import { normalizeImport, extractImports } from "../../packages/core/src/context/summaries.ts";
import { scoreMemory, buildQueryContext } from "../../packages/core/src/memory/ranking.ts";
import type { MemoryEntry } from "../../packages/core/src/index.ts";

test("normalizeImport resolves relative specifiers to project paths", () => {
  assert.equal(normalizeImport("./util", "src/auth.ts"), "src/util");
  assert.equal(normalizeImport("../lib/x", "src/auth/index.ts"), "src/lib/x");
  assert.equal(normalizeImport("./a/b", "src/f.ts"), "src/a/b");
});

test("normalizeImport keeps package specifiers verbatim", () => {
  assert.equal(normalizeImport("react", "src/app.ts"), "react");
  assert.equal(normalizeImport("@scope/pkg", "src/app.ts"), "@scope/pkg");
});

test("normalizeImport rejects specifiers escaping the project root", () => {
  assert.equal(normalizeImport("../../../etc/passwd", "src/f.ts"), "");
});

test("extractImports finds ts/js import and require specifiers", () => {
  const src = `import { a } from "./a";\nimport b from "../b";\nconst c = require("pkg");\n`;
  const out = extractImports(src, "typescript", "src/mod/f.ts");
  assert.ok(out.includes("src/mod/a"));
  assert.ok(out.includes("src/b"));
  assert.ok(out.includes("pkg"));
});

test("extractImports handles python from/import", () => {
  const out = extractImports("from os import path\nimport sys\n", "python", "app/main.py");
  assert.ok(out.includes("os"));
  assert.ok(out.includes("sys"));
});

test("extractImports caps output at 100", () => {
  const many = Array.from({ length: 300 }, (_, i) => `import x${i} from "p${i}";`).join("\n");
  const out = extractImports(many, "typescript", "src/f.ts");
  assert.ok(out.length <= 100);
});

function mem(over: Partial<MemoryEntry>): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: over.id ?? "m1",
    kind: over.kind ?? "decision",
    content: over.content ?? "content here",
    createdAt: now,
    updatedAt: now,
    confidence: over.confidence ?? 0.8,
    status: over.status ?? "active",
    sourceReferences: over.sourceReferences ?? [],
    relatedFiles: over.relatedFiles ?? [],
    relatedSymbols: over.relatedSymbols ?? [],
    tags: over.tags ?? [],
    invalidationRules: over.invalidationRules ?? [],
  };
}

test("scoreMemory boosts entries whose related symbols match query tokens", () => {
  const ctx = buildQueryContext("how does createorder work", [], [], []);
  const withSymbol = mem({ id: "a", content: "unrelated text", relatedSymbols: ["createOrder"] });
  const without = mem({ id: "b", content: "unrelated text", relatedSymbols: [] });
  const s1 = scoreMemory(withSymbol, ctx, Date.now());
  const s2 = scoreMemory(without, ctx, Date.now());
  assert.ok(s1 > s2, "symbol overlap increases score");
});

test("scoreMemory symbol boost is bounded (<= 0.6 before kind weight)", () => {
  const ctx = buildQueryContext("a b c d e f g h", [], [], []);
  const many = mem({ content: "zzz", relatedSymbols: ["a", "b", "c", "d", "e", "f", "g", "h"] });
  const none = mem({ content: "zzz", relatedSymbols: [] });
  const delta = scoreMemory(many, ctx, Date.now()) - scoreMemory(none, ctx, Date.now());
  // kind weight for decision is 1.15; boost is capped at 0.6 -> delta <= 0.6*1.15
  assert.ok(delta <= 0.6 * 1.15 + 1e-9, `delta ${delta} within bound`);
});

test("scoreMemory returns 0 for stale/candidate/forgotten", () => {
  const ctx = buildQueryContext("content here", [], [], []);
  for (const status of ["stale", "candidate", "forgotten", "superseded"] as const) {
    assert.equal(scoreMemory(mem({ status }), ctx, Date.now()), 0);
  }
});
