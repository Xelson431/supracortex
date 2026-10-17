import test from "node:test";
import assert from "node:assert";
import { formatMcpResult } from "../../src/mcp.ts";

test("MCP result bounds both output channels without returning malformed JSON", () => {
  const result = formatMcpResult({ records: ["x".repeat(60_000)] });
  const text = JSON.parse(result.content[0].text) as { truncated?: boolean };
  assert.equal(text.truncated, true);
  assert.equal(result.structuredContent.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8") < 1_000);
});

test("MCP result refuses cyclic values without making the transport throw", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const result = formatMcpResult(cyclic);
  const text = JSON.parse(result.content[0].text) as { code?: string };
  assert.equal(text.code, "RESULT_SERIALIZATION_FAILED");
  assert.equal(result.structuredContent.code, "RESULT_SERIALIZATION_FAILED");
});
