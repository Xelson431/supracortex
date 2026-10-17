/**
 * Provider tool-schema safety. OpenAI/Anthropic reject array-form `items`
 * (zod turns z.tuple into that) and draft-2020 `prefixItems`; a single such
 * tool makes the whole session 400. These tests pin the sanitizer and prove
 * every advertised input/output schema is clean.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as P from "../../src/protocol.ts";

function advertise(schema: unknown): Record<string, unknown> {
  return P.flattenSchemaForProvider(zodToJsonSchema(schema as never, { $refStrategy: "none" }));
}

test("zod tuples never reach the wire as array-form items (cortex_record)", () => {
  const f = advertise(P.RecordInputSchema) as {
    properties: { sourceReferences: { items: { properties: { lines: { items: unknown; minItems?: number } } } } };
  };
  const linesSchema = f.properties.sourceReferences.items.properties.lines;
  assert.equal(Array.isArray(linesSchema.items), false, "items must be a single schema, not a tuple array");
  assert.deepEqual(linesSchema.items, { type: "integer", minimum: 0 });
  assert.equal(linesSchema.minItems, 2, "pair length still enforced");
  assert.equal(P.findProviderSchemaHazard(f), null);
});

test("sanitizer: uniform tuple merges, mixed tuple becomes nested anyOf, empty schema becomes true", () => {
  const uniformTuple = { type: "array", items: [{ type: "integer" }, { type: "integer" }], minItems: 2, maxItems: 2 };
  assert.deepEqual(P.sanitizeSchemaForProvider(uniformTuple), {
    type: "array",
    items: { type: "integer" },
    minItems: 2,
    maxItems: 2,
  });
  const mixedTuple = { type: "array", items: [{ type: "string" }, { type: "integer" }] };
  assert.deepEqual(P.sanitizeSchemaForProvider(mixedTuple), {
    type: "array",
    items: { anyOf: [{ type: "string" }, { type: "integer" }] },
  });
  // An empty schema stays an object: the MCP ListTools contract requires every
  // property to be an object, not a boolean.
  assert.deepEqual(P.sanitizeSchemaForProvider({}), {});
  assert.deepEqual(P.sanitizeSchemaForProvider({ additionalProperties: {} }), { additionalProperties: {} });
  assert.deepEqual(P.sanitizeSchemaForProvider({ prefixItems: [{ type: "string" }], items: { type: "string" } }), {
    items: { type: "string" },
  });
});

test("findProviderSchemaHazard reports nested array items and prefixItems", () => {
  assert.match(P.findProviderSchemaHazard({ properties: { a: { items: [{ type: "string" }] } } }) ?? "", /tuple array/);
  assert.match(P.findProviderSchemaHazard({ type: "object", properties: { a: { prefixItems: [] } } }) ?? "", /prefixItems/);
  assert.equal(P.findProviderSchemaHazard({ type: "object", properties: { a: { type: "array", items: { type: "string" } } } }), null);
});

test("every advertised cortex_* schema is provider-safe", () => {
  const offenders: string[] = [];
  for (const [name, schema] of Object.entries(P)) {
    if (!name.endsWith("InputSchema") && !name.endsWith("OutputSchema")) continue;
    if (!schema || typeof (schema as { safeParse?: unknown }).safeParse !== "function") continue;
    try {
      const advertised = P.flattenSchemaForProvider(zodToJsonSchema(schema as never, { $refStrategy: "none" }));
      const hazard = P.findProviderSchemaHazard(advertised);
      if (hazard) offenders.push(`${name}: ${hazard}`);
    } catch (err) {
      offenders.push(`${name}: threw ${(err as Error).message}`);
    }
  }
  assert.deepEqual(offenders, []);
});
