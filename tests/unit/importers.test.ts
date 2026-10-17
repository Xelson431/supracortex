import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdown, parseJsonRecords, readImportSource } from "../../packages/core/src/importers/index.ts";

test("parseMarkdown classifies kinds by heading and keeps substantive lines", () => {
  const md = [
    "# Decisions",
    "- We chose JSONL storage for portability across machines.",
    "## Conventions",
    "- Always redact secrets before persisting any content.",
    "short",
    "```code fence should be skipped entirely```",
  ].join("\n");
  const out = parseMarkdown(md, "import:agents-md");
  assert.ok(out.some((c) => c.kind === "decision" && /JSONL storage/.test(c.content)));
  assert.ok(out.some((c) => c.kind === "convention" && /redact secrets/.test(c.content)));
  assert.ok(!out.some((c) => c.content === "short"), "short fragments dropped");
  assert.ok(out.every((c) => c.status === "candidate"), "all staged as candidate");
  assert.ok(out.every((c) => c.origin === "import:agents-md"), "provenance labelled");
});

test("parseJsonRecords reads arrays and defaults unknown kinds to fact", () => {
  const json = JSON.stringify([
    { kind: "constraint", content: "must never store transcripts" },
    { kind: "banana", content: "unknown kind becomes fact" },
    { content: "no kind field" },
    { kind: "fact" }, // no content -> skipped
  ]);
  const out = parseJsonRecords(json, "import:json", false);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.kind, "constraint");
  assert.equal(out[1]!.kind, "fact");
  assert.ok(out.every((c) => c.status === "candidate"));
});

test("parseJsonRecords reads JSONL and skips malformed lines", () => {
  const jsonl = [
    JSON.stringify({ content: "line one is valid" }),
    "{ not valid json",
    JSON.stringify({ content: "line three is valid" }),
  ].join("\n");
  const out = parseJsonRecords(jsonl, "import:jsonl", true);
  assert.equal(out.length, 2);
});

test("readImportSource rejects paths escaping the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-imp-"));
  const res = await readImportSource("agents-md", "../../../etc/passwd", root);
  assert.deepEqual(res.candidates, []);
  assert.ok(res.skipped[0]!.includes("escapes"));
});

test("readImportSource reports missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-imp-"));
  const res = await readImportSource("claude-md", "CLAUDE.md", root);
  assert.deepEqual(res.candidates, []);
  assert.ok(res.skipped[0]!.includes("not found"));
});

test("readImportSource enforces the size bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-imp-"));
  await writeFile(join(root, "big.md"), "x".repeat(2_000_001), "utf8");
  const res = await readImportSource("agents-md", "big.md", root);
  assert.deepEqual(res.candidates, []);
  assert.ok(res.skipped[0]!.includes("exceeds"));
});

test("readImportSource parses a real markdown file within the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-imp-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs", "CLAUDE.md"),
    "# Project\n- The API layer must validate every inbound request payload.\n",
    "utf8",
  );
  const res = await readImportSource("claude-md", "docs/CLAUDE.md", root);
  assert.ok(res.candidates.length >= 1);
  assert.ok(res.candidates[0]!.origin === "import:claude-md");
});
