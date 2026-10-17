import test from "node:test";
import assert from "node:assert";
import { buildMemoryEntry } from "../../packages/core/src/index.ts";
import { isValidMemoryEntry } from "../../packages/core/src/memory/schemas.ts";

const opts = {
  requireEvidenceForDurableFacts: true,
  redactLikelySecrets: true,
  minimumConfidence: 0.65,
};

test("durable fact without evidence is rejected", () => {
  const r = buildMemoryEntry({ kind: "fact", content: "The DB is Postgres", confidence: 0.9 }, opts);
  assert.equal(r.entry, undefined);
  assert.ok(r.rejected?.includes("evidence"));
});

test("durable fact with evidence is accepted", () => {
  const r = buildMemoryEntry(
    {
      kind: "fact",
      content: "The DB is Postgres",
      confidence: 0.9,
      sourceReferences: [{ kind: "file", value: "docker-compose.yml" }],
    },
    opts,
  );
  assert.ok(r.entry);
  assert.equal(r.entry?.kind, "fact");
});

test("a command, session, or external URL is held as a durable-memory candidate", () => {
  for (const kind of ["command", "session", "external"] as const) {
    const result = buildMemoryEntry(
      {
        kind: "fact",
        content: "unverified claim",
        confidence: 0.9,
        sourceReferences: [{ kind, value: kind === "external" ? "https://example.invalid" : "agent-supplied" }],
      },
      opts,
    );
    assert.equal(result.entry?.status, "candidate", `${kind} is not verifiable local evidence`);
  }
});

test("low-confidence entry is rejected", () => {
  const r = buildMemoryEntry(
    { kind: "convention", content: "use tabs", confidence: 0.1, sourceReferences: [{ kind: "file", value: "x" }] },
    opts,
  );
  assert.equal(r.entry, undefined);
});

test("failure kind does not require evidence policy path but respects confidence", () => {
  const r = buildMemoryEntry({ kind: "failure", content: "tests time out on CI", confidence: 0.7 }, opts);
  assert.ok(r.entry, "failure without evidence allowed");
});

test("secret content is redacted before storage", () => {
  const r = buildMemoryEntry(
    {
      kind: "decision",
      content: 'We set API_KEY = "sk-abcdef0123456789abcdef" in prod',
      confidence: 0.9,
      sourceReferences: [{ kind: "file", value: "notes.md" }],
    },
    opts,
  );
  assert.ok(r.entry);
  assert.equal(r.redacted, true);
  assert.ok(!r.entry!.content.includes("sk-abcdef0123456789"));
});

test("confidence is clamped to [0,1]", () => {
  const r = buildMemoryEntry(
    { kind: "failure", content: "x", confidence: 5 },
    { ...opts, minimumConfidence: 0 },
  );
  assert.ok(r.entry);
  assert.ok(r.entry!.confidence <= 1);
});

test("persisted memory decoder rejects malformed nested state before ranking can see it", () => {
  const valid = buildMemoryEntry(
    { kind: "fact", content: "A checked fact", confidence: 0.9, sourceReferences: [{ kind: "file", value: "src/a.ts" }] },
    opts,
  ).entry!;
  assert.equal(isValidMemoryEntry(valid), true);
  assert.equal(isValidMemoryEntry({ ...valid, sourceReferences: [{ kind: "file", value: "../escape", lines: [2, 1] }] }), false);
  assert.equal(isValidMemoryEntry({ ...valid, confidence: Number.NaN }), false);
  assert.equal(isValidMemoryEntry({ ...valid, createdAt: "not-a-date" }), false);
  assert.equal(isValidMemoryEntry({ ...valid, tags: Array(201).fill("x") }), false);
});

test("persisted memory decoder accepts bounded opaque supersedes ids", () => {
  const valid = buildMemoryEntry(
    { kind: "fact", content: "A checked fact", confidence: 0.9, sourceReferences: [{ kind: "file", value: "src/a.ts" }] },
    opts,
  ).entry!;
  // Memory ids are opaque (not UUID-only): legacy and short ids must validate.
  assert.equal(isValidMemoryEntry({ ...valid, supersedes: ["e-0001", "legacy-id"] }), true);
  // A UUID supersedes still validates (regression).
  assert.equal(
    isValidMemoryEntry({ ...valid, supersedes: ["123e4567-e89b-12d3-a456-426614174000"] }),
    true,
  );
  // Empty ids and ids over the 256-byte bound are rejected.
  assert.equal(isValidMemoryEntry({ ...valid, supersedes: [""] }), false);
  assert.equal(isValidMemoryEntry({ ...valid, supersedes: ["x".repeat(257)] }), false);
});
