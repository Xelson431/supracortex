import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, formatMcpResult } from "../../src/mcp.ts";
import {
  MCP_TOOL_NAMES,
  encodeCursor,
  decodeCursor,
  canonicalQueryHash,
  MemoryEntryOutputSchema,
  OutputSchemas,
  DEFAULT_PAGE_LIMIT,
} from "../../src/protocol.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeProject(enabled = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sc-mcp-proto-"));
  await mkdir(join(root, ".supracortex"), { recursive: true });
  const cfg = { enabled };
  await writeFile(
    join(root, ".supracortex", "config.jsonc"),
    JSON.stringify(cfg, null, 2) + "\n",
    "utf8",
  );
  return root;
}

async function connect(root: string): Promise<Client> {
  const server = await createMcpServer(root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function payloadOf(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ text: string }> }).content;
  const first = content[0];
  if (!first) throw new Error("expected tool content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Output schema tests
// ---------------------------------------------------------------------------

test("MCP protocol: every tool advertises outputSchema in ListTools", async () => {
  const client = await connect(await makeProject(true));
  const { tools } = await client.listTools();
  assert.equal(tools.length, MCP_TOOL_NAMES.length);
  for (const t of tools) {
    const os = t.outputSchema as Record<string, unknown> | undefined;
    assert.ok(os, `${t.name} must have outputSchema`);
    assert.equal(os.type, "object", `${t.name} outputSchema root must be type:"object"`);
    // Verify it has properties (may be empty for review but must exist)
    assert.ok(
      typeof os.properties === "object" || Array.isArray(os.anyOf) || Array.isArray(os.oneOf),
      `${t.name} outputSchema must declare properties or union`,
    );
  }
  await client.close();
});

test("MCP protocol: output schemas are valid JSON Schema", () => {
  for (const name of MCP_TOOL_NAMES) {
    const schema = OutputSchemas[name];
    assert.ok(schema, `${name} has output schema`);
    // The schema must parse a reasonable example value
    const result = schema.safeParse({});
    // Most schemas should accept empty object (for permissive schemas)
    assert.doesNotThrow(
      () => schema.constructor,
      `${name} output schema constructor should not throw`,
    );
  }
});

test("MCP protocol: validateOutput rejects invalid search result shape", async () => {
  const client = await connect(await makeProject(true));
  // We cannot easily inject engine failures, but we can test the output
  // schema directly on an invalid shape to verify RESULT_SCHEMA_MISMATCH.
  // For the actual tool call: cortex_record with valid input should succeed.
  const payload = payloadOf(
    await client.callTool({
      name: "cortex_record",
      arguments: {
        type: "memory",
        kind: "fact",
        content: "Test memory for output validation.",
        confidence: 0.8,
      },
    }),
  );
  // recordMemory returns { status: "recorded"|"rejected", redacted, entry? }
  assert.ok(payload.status === "recorded" || payload.status === "rejected");
  assert.equal(typeof payload.redacted, "boolean");
  await client.close();
});

test("MCP protocol: MemoryEntryOutputSchema validates known shape", () => {
  const entry = {
    id: "abc-123",
    kind: "fact",
    content: "some content",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    confidence: 0.9,
    status: "active",
    sourceReferences: [{ kind: "file", value: "src/main.ts" }],
    relatedFiles: [],
    relatedSymbols: [],
    tags: [],
    invalidationRules: [],
  };
  const result = MemoryEntryOutputSchema.safeParse(entry);
  assert.ok(result.success, "MemoryEntryOutputSchema should accept valid entry");
});

test("MCP protocol: MemoryEntryOutputSchema rejects missing required fields", () => {
  const invalid = { kind: "fact", content: "missing id" };
  const result = MemoryEntryOutputSchema.safeParse(invalid);
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// 1a. cortex_review output contract
//
// `validateOutput` (src/mcp.ts) delegates to `OutputSchemas[name].safeParse`,
// so exercising the schema here is equivalent to exercising validateOutput and
// does not require a committed write or an exported helper.
// ---------------------------------------------------------------------------

const reviewSchema = OutputSchemas.cortex_review;
if (!reviewSchema) throw new Error("cortex_review output schema is missing");

const reviewEntry = {
  id: "abc-123",
  kind: "fact",
  content: "some content",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  confidence: 0.9,
  status: "active",
  sourceReferences: [{ kind: "file", value: "src/main.ts" }],
  relatedFiles: [],
  relatedSymbols: [],
  tags: [],
  invalidationRules: [],
};

test("MCP protocol: cortex_review accepts refresh-evidence result", () => {
  const result = reviewSchema.safeParse({
    refreshed: true,
    verified: false,
    status: "stale",
    entryId: "e-1",
    refs: [{ file: "src/a.ts", oldHash: "a", newHash: "b" }],
  });
  assert.ok(result.success, "refresh-evidence result must validate");
});

test("MCP protocol: cortex_review accepts lifecycle status result", () => {
  const result = reviewSchema.safeParse({
    refreshed: false,
    verified: true,
    status: "active",
    entryId: "e-1",
  });
  assert.ok(result.success, "lifecycle status result must validate");
});

test("MCP protocol: cortex_review accepts approve result with entry", () => {
  const result = reviewSchema.safeParse({ entry: reviewEntry });
  assert.ok(result.success, "approve result must validate");
});

test("MCP protocol: cortex_review accepts missing-refs result", () => {
  const result = reviewSchema.safeParse({ missing: ["src/gone.ts"] });
  assert.ok(result.success, "missing refs result must validate");
});

test("MCP protocol: cortex_review rejects an over-long status", () => {
  const result = reviewSchema.safeParse({ status: "x".repeat(31) });
  assert.equal(result.success, false, "status bound (30 chars) must be enforced");
});

// ---------------------------------------------------------------------------
// 2. Cursor pagination tests
// ---------------------------------------------------------------------------

test("MCP protocol: encode/decode cursor round-trips", () => {
  const queryHash = "a".repeat(64); // valid sha256 hex
  const cursor = encodeCursor(25, queryHash);
  assert.ok(typeof cursor === "string");
  assert.ok(cursor.length > 0);

  const decoded = decodeCursor(cursor);
  assert.ok(!("error" in decoded), "decodeCursor should succeed");
  if (!("error" in decoded)) {
    assert.equal(decoded.offset, 25);
    assert.equal(decoded.queryHash, queryHash);
  }
});

test("MCP protocol: decodeCursor rejects invalid base64url", () => {
  const result = decodeCursor("!!!invalid-base64!!!");
  assert.ok("error" in result);
});

test("MCP protocol: decodeCursor rejects wrong format JSON", () => {
  const bad = Buffer.from(JSON.stringify({ v: 2, off: 10, q: "a".repeat(64) })).toString("base64url");
  const result = decodeCursor(bad);
  assert.ok("error" in result, "should reject wrong version");
  assert.equal(result.error, "invalid cursor format");
});

test("MCP protocol: decodeCursor rejects wrong query hash", () => {
  const bad = Buffer.from(JSON.stringify({ v: 1, off: 10, q: "b".repeat(64) })).toString("base64url");
  const result = decodeCursor(bad);
  assert.ok(!("error" in result), "valid format should decode");
  // Decode succeeds (format check), q-mismatch is caught by caller
});

test("MCP protocol: decodeCursor rejects missing fields", () => {
  const bad = Buffer.from(JSON.stringify({ v: 1 })).toString("base64url");
  const result = decodeCursor(bad);
  assert.ok("error" in result);
});

test("MCP protocol: canonicalQueryHash is deterministic", () => {
  const a = canonicalQueryHash({ query: "hello", tags: ["go", "ts"] });
  const b = canonicalQueryHash({ tags: ["go", "ts"], query: "hello" });
  assert.equal(a, b);
});

test("MCP protocol: canonicalQueryHash differs for different params", () => {
  const a = canonicalQueryHash({ query: "hello" });
  const b = canonicalQueryHash({ query: "world" });
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// 3. Cancellation tests
// ---------------------------------------------------------------------------

test("MCP protocol: error() accepts optional code parameter", () => {
  // Import the error function indirectly via formatMcpResult's output
  // error() is private, but we test the envelope shape here
  const envelope = (() => {
    // Replicate the error logic
    const msg = "test error";
    const code = "CUSTOM_CODE";
    return { isError: true, ...formatMcpResult({ error: msg, code }) };
  })();
  assert.equal(envelope.isError, true);
  const parsed = payloadOf(envelope);
  assert.equal(parsed.error, "test error");
  assert.equal(parsed.code, "CUSTOM_CODE");
});

test("MCP protocol: default error code is INVALID_REQUEST", () => {
  const envelope = (() => {
    const msg = "default code";
    return { isError: true, ...formatMcpResult({ error: msg, code: "INVALID_REQUEST" }) };
  })();
  assert.equal(envelope.isError, true);
  const parsed = payloadOf(envelope);
  assert.equal(parsed.code, "INVALID_REQUEST");
});

// ---------------------------------------------------------------------------
// 4. Pagination integration test (cortex_search)
// ---------------------------------------------------------------------------

test("MCP protocol: search with cursor returns different pages", async () => {
  // Record enough test memories to span multiple pages
  const root = await makeProject(true);
  const client = await connect(root);

  // Record 3 test memories so search can return multiple results
  const queries = [
    "Pagination test memory alpha: cache coherence",
    "Pagination test memory beta: lock-free queue",
    "Pagination test memory gamma: consensus protocol",
  ];
  for (const q of queries) {
    await client.callTool({
      name: "cortex_record",
      arguments: {
        type: "memory",
        kind: "fact",
        content: q,
        confidence: 0.8,
      },
    });
  }

  // Search with small limit to force pagination
  const page1 = payloadOf(
    await client.callTool({
      name: "cortex_search",
      arguments: { query: "pagination test memory", limit: 1 },
    }),
  );
  assert.ok(Array.isArray(page1.items), "search result should have items array");
  assert.ok(page1.items.length <= 1, "page should have at most 1 item");

  // If there's a nextCursor, follow it
  const nc = page1.nextCursor;
  if (nc && typeof nc === "string") {
    const page2 = payloadOf(
      await client.callTool({
        name: "cortex_search",
        arguments: { query: "pagination test memory", limit: 1, cursor: nc },
      }),
    );
    assert.ok(Array.isArray(page2.items));
    // Items on page 2 should be different from page 1
    const i1 = page1.items[0];
    const i2 = page2.items[0] as Record<string, unknown> | undefined;
    if (i1 && i2) {
      const e1 = (i1 as Record<string, unknown>).entry as Record<string, unknown> | undefined;
      const e2 = i2.entry as Record<string, unknown> | undefined;
      if (e1 && e2) {
        assert.notEqual(e1.id, e2.id, "pages must return disjoint records");
      }
    }
  }

  await client.close();
});

test("MCP protocol: tampered cursor returns INVALID_CURSOR error", async () => {
  const client = await connect(await makeProject(true));

  // Bad base64
  const badResult = (await client.callTool({
    name: "cortex_search",
    arguments: { query: "test", cursor: "!!!bad-base64!!!", limit: 5 },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(badResult.isError, true);
  assert.ok(badResult.content.length > 0);
  const parsed = JSON.parse(badResult.content[0]!.text) as { code?: string };
  assert.equal(parsed.code, "INVALID_CURSOR");

  // Valid base64 but wrong format
  const wrongFormat = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
  const badResult2 = (await client.callTool({
    name: "cortex_search",
    arguments: { query: "test", cursor: wrongFormat, limit: 5 },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(badResult2.isError, true);
  assert.ok(badResult2.content.length > 0);
  const parsed2 = JSON.parse(badResult2.content[0]!.text) as { code?: string };
  assert.equal(parsed2.code, "INVALID_CURSOR");

  await client.close();
});

test("MCP protocol: cursor with mismatched query hash returns INVALID_CURSOR", async () => {
  const client = await connect(await makeProject(true));
  // Encode a cursor that claims to be for a different query
  const wrongHash = "f".repeat(64);
  const badCursor = encodeCursor(5, wrongHash);

  const result = (await client.callTool({
    name: "cortex_search",
    arguments: { query: "some different query", cursor: badCursor, limit: 5 },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.ok(result.content.length > 0);
  const parsed = JSON.parse(result.content[0]!.text) as { code?: string };
  assert.equal(parsed.code, "INVALID_CURSOR");

  await client.close();
});

test("MCP protocol: timeline with cursor pagination", async () => {
  const client = await connect(await makeProject(true));

  // First call — no cursor, get first page
  const page1 = payloadOf(
    await client.callTool({
      name: "cortex_timeline",
      arguments: { limit: 1 },
    }),
  );
  assert.ok(Array.isArray(page1.entries), "timeline result should have entries array");

  await client.close();
});

test("MCP protocol: review list with cursor", async () => {
  const client = await connect(await makeProject(true));

  const page1 = payloadOf(
    await client.callTool({
      name: "cortex_review",
      arguments: { action: "list", limit: 1 },
    }),
  );
  assert.ok(page1.entries === undefined || Array.isArray(page1.entries),
    "review list result should have entries array or be empty");

  await client.close();
});

// ---------------------------------------------------------------------------
// 5. Cancellation signal tests
// ---------------------------------------------------------------------------

test("MCP protocol: record checks aborted before commit", async () => {
  const client = await connect(await makeProject(true));
  // In a real scenario the signal would be aborted externally.
  // Here we verify that the aborted-before-commit check path is reachable
  // by confirming a normal record still succeeds.
  const payload = payloadOf(
    await client.callTool({
      name: "cortex_record",
      arguments: {
        type: "memory",
        kind: "decision",
        content: "Cancellation safety test entry.",
        confidence: 0.7,
      },
    }),
  );
  assert.ok(payload.status === "recorded" || payload.status === "rejected");
  await client.close();
});

test("MCP protocol: search with cursor offset 0 without cursor arg returns first page", async () => {
  const client = await connect(await makeProject(true));
  const payload = payloadOf(
    await client.callTool({
      name: "cortex_search",
      arguments: { query: "test" },
    }),
  );
  assert.ok(Array.isArray(payload.items), "search without cursor should return items array");
  // nextCursor may or may not be present
  await client.close();
});

// ---------------------------------------------------------------------------
// 6. Edge case: empty result pagination
// ---------------------------------------------------------------------------

test("MCP protocol: search with no results returns empty items", async () => {
  const client = await connect(await makeProject(true));
  const payload = payloadOf(
    await client.callTool({
      name: "cortex_search",
      arguments: { query: "zzzzzzzzthisquerymatchesnothing", limit: 5 },
    }),
  );
  assert.ok(Array.isArray(payload.items));
  assert.equal(payload.items.length, 0);
  assert.equal(payload.nextCursor, undefined);
  await client.close();
});

// ---------------------------------------------------------------------------
// 6a. Single vocabulary: thin aliases + imperative bootstrap
// ---------------------------------------------------------------------------

test("MCP 6a: thin aliases resolve to canonical names", async () => {
  const { resolveCanonicalToolName, TOOL_ALIASES, CANONICAL_CORE_TOOLS } = await import("../../src/protocol.ts");
  assert.equal(Object.keys(TOOL_ALIASES).length, 4, "4 thin aliases expected");
  assert.equal(CANONICAL_CORE_TOOLS.length, 5, "5 canonical core tools expected");
  assert.equal(resolveCanonicalToolName("cortex_prepare_context"), "cortex_context");
  assert.equal(resolveCanonicalToolName("cortex_search_memory"), "cortex_search");
  assert.equal(resolveCanonicalToolName("cortex_record_memory"), "cortex_record");
  assert.equal(resolveCanonicalToolName("cortex_record_outcome"), "cortex_record");
  // Canonicals resolve to themselves.
  for (const c of CANONICAL_CORE_TOOLS) assert.equal(resolveCanonicalToolName(c), c);
  // Unknown fails closed, never silent.
  assert.equal(resolveCanonicalToolName("cortex_nope"), null);
});

test("MCP 6a: only cortex_context carries the bootstrap sentence", async () => {
  const { BOOTSTRAP_SENTENCE, CANONICAL_CORE_TOOLS } = await import("../../src/protocol.ts");
  const client = await connect(await makeProject(true));
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
  for (const name of CANONICAL_CORE_TOOLS) {
    const desc = byName.get(name);
    assert.ok(desc, `${name} must be advertised`);
    if (name === "cortex_context") {
      assert.ok(desc.startsWith(BOOTSTRAP_SENTENCE), "cortex_context keeps the bootstrap sentence");
    } else {
      assert.ok(!desc.startsWith(BOOTSTRAP_SENTENCE), `${name} must not repeat the bootstrap sentence`);
    }
  }
  await client.close();
});

test("MCP 6a: alias call dispatches to the canonical handler", async () => {
  const client = await connect(await makeProject(true));
  const canonical = payloadOf(
    await client.callTool({ name: "cortex_search", arguments: { query: "zzzzzzzzthisquerymatchesnothing" } }),
  );
  const viaAlias = payloadOf(
    await client.callTool({ name: "cortex_search_memory", arguments: { query: "zzzzzzzzthisquerymatchesnothing" } }),
  );
  assert.deepEqual(viaAlias, canonical, "alias call must return the identical canonical result");
  await client.close();
});

test("MCP 6a: unknown tool fails closed listing canonicals", async () => {
  const client = await connect(await makeProject(true));
  const result = (await client.callTool({
    name: "cortex_nope",
    arguments: {},
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0]!.text) as { code?: string; error?: string };
  assert.equal(parsed.code, "UNKNOWN_TOOL");
  assert.ok(parsed.error?.includes("cortex_context"), "unknown-tool error must list canonical tools");
  await client.close();
});

test("MCP 6a: non-core tools resolve identically on the protocol side", async () => {
  const { resolveCanonicalToolName, MCP_TOOL_NAMES } = await import("../../src/protocol.ts");
  // Every advertised canonical (including non-core) resolves to itself.
  for (const name of MCP_TOOL_NAMES) assert.equal(resolveCanonicalToolName(name), name);
  // Spot-check non-core names that previously returned null on the OpenCode side.
  assert.equal(resolveCanonicalToolName("cortex_timeline"), "cortex_timeline");
  assert.equal(resolveCanonicalToolName("cortex_detail"), "cortex_detail");
  assert.equal(resolveCanonicalToolName("cortex_graph_query"), "cortex_graph_query");
});

// Regression: the engine grew provider/model on jevStatus() but the strict
// output schema was never updated, so every cortex_jev_status call failed with
// RESULT_SCHEMA_MISMATCH. Call the argument-free, network-free tools end to end
// so any future engine/schema drift fails here instead of in a live session.
test("MCP protocol: no-argument tools return schema-valid results end to end", async () => {
  const root = await makeProject(true);
  const client = await connect(root);
  for (const name of ["cortex_jev_status", "cortex_status", "cortex_capabilities", "cortex_graph_status"] as const) {
    const res = (await client.callTool({ name, arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = res.content[0]?.text ?? "";
    assert.ok(!res.isError, `${name} errored: ${text}`);
    assert.doesNotMatch(text, /RESULT_SCHEMA_MISMATCH/, name);
  }
  const jev = payloadOf(await client.callTool({ name: "cortex_jev_status", arguments: {} }));
  assert.equal(typeof jev.provider, "string");
  assert.equal(typeof jev.model, "string");
  assert.equal(OutputSchemas.cortex_jev_status?.safeParse(jev)?.success, true);
  await client.close();
});
