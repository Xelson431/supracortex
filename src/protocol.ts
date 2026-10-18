import { z } from "zod";
import { createHash } from "node:crypto";
import { TOOLSET_API_VERSION } from "./version.ts";

/**
 * SupraCortex's operation contract. This is not the negotiated MCP protocol
 * version (the SDK/client negotiates that date-based value independently).
 */
export { TOOLSET_API_VERSION };
/** @deprecated Use TOOLSET_API_VERSION. */
export const MCP_PROTOCOL_VERSION = TOOLSET_API_VERSION;
export const MCP_TOOL_NAMES = ["cortex_context", "cortex_search", "cortex_record", "cortex_status", "cortex_timeline", "cortex_detail", "cortex_handoff", "cortex_resume", "cortex_review", "cortex_safety", "cortex_graph_status", "cortex_graph_rebuild", "cortex_graph_query", "cortex_graph_path", "cortex_graph_explain", "cortex_graph_impact", "cortex_jev_status", "cortex_jev_review", "cortex_capabilities"] as const;
export const MAX_MCP_INPUT_CHARS = 32_000;
export const MAX_MCP_OUTPUT_CHARS = 48_000;

// ---------------------------------------------------------------------------
// 6a: single vocabulary with thin aliases. Canonical names are the short MCP
// names; the longer OpenCode names are thin aliases to the same handler.
// No logic fork: aliases never contain business logic.
// ---------------------------------------------------------------------------

/** Imperative bootstrap: prepended to every core tool description. */
export const BOOTSTRAP_SENTENCE =
  "Call cortex_context first on any non-trivial task and verify its packet against source before using any other SupraCortex tool.";

/** The 5 core tools advertised by default; every description carries the bootstrap. */
export const CANONICAL_CORE_TOOLS = [
  "cortex_context",
  "cortex_search",
  "cortex_record",
  "cortex_status",
  "cortex_handoff",
] as const;
export type CanonicalCoreTool = (typeof CANONICAL_CORE_TOOLS)[number];

/** Thin alias -> canonical map. Aliases dispatch to the canonical handler. */
export const TOOL_ALIASES: Record<string, string> = {
  cortex_prepare_context: "cortex_context",
  cortex_search_memory: "cortex_search",
  cortex_record_memory: "cortex_record",
  cortex_record_outcome: "cortex_record",
};

// Fail closed on duplicate canonicals at module load.
{
  const seen = new Set<string>();
  for (const name of CANONICAL_CORE_TOOLS) {
    if (seen.has(name)) throw new Error(`duplicate canonical tool: ${name}`);
    seen.add(name);
  }
}

/**
 * Resolve any tool name to its canonical form. Returns the canonical name
 * for canonicals and known aliases, or null for unknown names (fail closed -
 * callers must list canonicals, never silently proceed).
 */
export function resolveCanonicalToolName(name: string): string | null {
  const all = new Set<string>(MCP_TOOL_NAMES as readonly string[]);
  if (all.has(name)) return name;
  const target = TOOL_ALIASES[name];
  if (target && all.has(target)) return target;
  return null;
}

/** Canonical name for telemetry: always log the canonical, never the alias. */
export function canonicalToolLog(name: string): string {
  return resolveCanonicalToolName(name) ?? name;
}

/** Human-readable canonical list for unknown-alias errors. */
export function canonicalToolList(): string {
  return [...MCP_TOOL_NAMES].join(", ");
}

/**
 * Alias -> canonical table for the 7b status view. Read-only snapshot.
 * Single source: packages/opencode/src/tools/index.ts and src/mcp.ts
 * re-export this; CORTEX_ALIAS_TABLE in cli-core is display-only (owned
 * by 7b — it should import this instead of maintaining its own copy).
 */
export function toolAliasTable(): { canonical: string; aliases: string[] }[] {
  const byCanonical = new Map<string, string[]>();
  for (const c of CANONICAL_CORE_TOOLS) byCanonical.set(c, []);
  for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
    byCanonical.get(canonical)!.push(alias);
  }
  return [...byCanonical.entries()].map(([canonical, aliases]) => ({ canonical, aliases }));
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const ContextInputSchema = z.object({ query: z.string().min(1).max(8_000), hintFiles: z.array(z.string().max(500)).max(100).optional(), tags: z.array(z.string().max(100)).max(50).optional(), maxTokens: z.number().int().min(100).max(20_000).optional() }).strict();
export const SearchInputSchema = z.object({ query: z.string().min(1).max(8_000), tags: z.array(z.string().max(100)).max(50).optional(), hintFiles: z.array(z.string().max(500)).max(100).optional(), cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
// `lines` is a 2-element [start, end] pair. Kept as a z.tuple for the domain
// type ([number, number]); its JSON Schema form (`items: [ … ]`) is rewritten to
// a single `items` schema by sanitizeSchemaForProvider, because OpenAI/Anthropic
// reject array-form `items` ("…is not of types boolean, object").
const SourceReferenceSchema = z.object({ kind: z.enum(["file", "commit", "command", "external", "session"]), value: z.string().max(2_000), lines: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(), hash: z.string().max(500).optional(), note: z.string().max(2_000).optional() }).strict();
const InvalidationRuleSchema = z.object({ kind: z.enum(["file-hash-changed", "file-deleted", "time-elapsed", "manual"]), target: z.string().max(500).optional(), expiresAt: z.string().max(100).optional() }).strict();
/** The memory facet of cortex_record. Re-validated after the flat parse. */
const MemoryRecordSchema = z.object({ type: z.literal("memory"), kind: z.enum(["fact", "decision", "convention", "failure", "constraint", "task-outcome"]), content: z.string().min(1).max(8_000), confidence: z.number().min(0).max(1).optional(), status: z.enum(["active", "candidate"]).optional().describe("candidate = submit for review; active = default when evidence is present"), sourceReferences: z.array(SourceReferenceSchema).max(100).optional(), relatedFiles: z.array(z.string().max(500)).max(100).optional(), relatedSymbols: z.array(z.string().max(500)).max(100).optional(), tags: z.array(z.string().max(100)).max(50).optional(), invalidationRules: z.array(InvalidationRuleSchema).max(100).optional() }).strict();
/** The outcome facet of cortex_record. Re-validated after the flat parse. */
const OutcomeRecordSchema = z.object({ type: z.literal("outcome"), operationId: z.string().min(1).max(120).optional(), taskId: z.string().min(1).max(500), status: z.enum(["success", "failure", "partial"]), summary: z.string().max(8_000), touchedFiles: z.array(z.string().max(500)).max(100), learnings: z.array(z.string().max(8_000)).max(50).optional(), failureReason: z.string().max(8_000).optional() }).strict();

/**
 * cortex_record serves two facets under one tool name, advertised as ONE flat
 * object rather than a union.
 *
 * This is deliberate and load-bearing. Anthropic's Messages API rejects a tool
 * whose `input_schema` carries `anyOf`/`oneOf`/`allOf` at the top level:
 * `tools.N.custom.input_schema: input_schema does not support oneOf, allOf, or
 * anyOf at the top level`. A host ships its full tool list on every request, so
 * one offending tool makes the whole session unusable until restart. A zod
 * `discriminatedUnion` converts to exactly that root-level `anyOf`, and nothing
 * downstream removes it: OpenCode's schema sanitization has no Anthropic branch,
 * MCP tools never reach the `tool.definition` hook, and OmniRoute preserves root
 * combinators for Claude targets. The fix therefore has to be structural, here.
 *
 * Per-facet requirements (`kind`+`content` for memory; `taskId`+`status`+
 * `summary`+`touchedFiles` for outcome) and per-facet field exclusivity are not
 * lost: {@link parseRecordInput} parses this flat schema first, then re-parses
 * against the matching strict branch schema. Unknown fields are still rejected by
 * `.strict()` on both layers.
 */
export const RecordInputSchema = z.object({
  type: z.enum(["memory", "outcome"]),
  // Every field below is OPTIONAL. `type` alone selects the facet, and only the
  // matching branch schema decides which fields are actually required. Requiring
  // them here would demand outcome fields from a memory write (and vice versa).
  // memory facet
  kind: MemoryRecordSchema.shape.kind.optional(),
  content: MemoryRecordSchema.shape.content.optional(),
  confidence: MemoryRecordSchema.shape.confidence.optional(),
  // Shared by both facets but narrowed by the strict branch schema: memory
  // accepts active/candidate, outcome accepts success/failure/partial.
  status: z.enum(["success", "failure", "partial", "active", "candidate"]).optional().describe("Memory: candidate = submit for review; active = default when evidence is present. Outcome: success/failure/partial."),
  sourceReferences: MemoryRecordSchema.shape.sourceReferences.optional(),
  relatedFiles: MemoryRecordSchema.shape.relatedFiles.optional(),
  relatedSymbols: MemoryRecordSchema.shape.relatedSymbols.optional(),
  tags: MemoryRecordSchema.shape.tags.optional(),
  invalidationRules: MemoryRecordSchema.shape.invalidationRules.optional(),
  // outcome facet
  operationId: OutcomeRecordSchema.shape.operationId.optional(),
  taskId: OutcomeRecordSchema.shape.taskId.optional(),
  summary: OutcomeRecordSchema.shape.summary.optional(),
  touchedFiles: OutcomeRecordSchema.shape.touchedFiles.optional(),
  learnings: OutcomeRecordSchema.shape.learnings.optional(),
  failureReason: OutcomeRecordSchema.shape.failureReason.optional(),
}).strict();

/**
 * Parse a cortex_record payload into its strict facet.
 *
 * Two stages on purpose: the flat advertised schema validates types, bounds and
 * unknown keys uniformly; the branch schema then enforces the required fields
 * for `type` and rejects fields belonging to the *other* facet. Failures are
 * ordinary ZodErrors, so the MCP error path and its messages are unchanged.
 */
export function parseRecordInput(input: unknown): RecordInput {
  const flat = RecordInputSchema.parse(input);
  return flat.type === "memory" ? MemoryRecordSchema.parse(flat) : OutcomeRecordSchema.parse(flat);
}

// ---------------------------------------------------------------------------
// Provider-safe advertised schemas
// ---------------------------------------------------------------------------

/** JSON Schema composition keywords. Anthropic forbids these at the ROOT. */
export const ROOT_COMBINATOR_KEYS = ["anyOf", "oneOf", "allOf"] as const;

/** True when a generated schema carries a root-level composition keyword. */
export function hasRootCombinator(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const record = schema as Record<string, unknown>;
  return ROOT_COMBINATOR_KEYS.some((key) => key in record);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A branch that only means "null", produced by zod's `.nullable()`. */
function isNullBranch(branch: unknown): boolean {
  return isPlainObject(branch) && branch.type === "null";
}

export interface FlattenOptions {
  /**
   * Output schemas only. Drops `required` and opens `additionalProperties` so a
   * host validating structuredContent cannot reject a legitimate result shape.
   * Server-side validation still uses the strict zod schema — this only relaxes
   * what we advertise.
   */
  readonly permissive?: boolean;
}

const PERMISSIVE_FALLBACK: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

/**
 * Convert a generated JSON Schema into a form every provider in the chain
 * accepts, by removing root-level composition.
 *
 * zod expresses `A | B` and `A | null` as a root `anyOf`, which Anthropic
 * rejects outright. Rather than dropping the information (which leaves the model
 * guessing every argument), object branches are merged into a single object
 * schema: `properties` are unioned, `required` is unioned.
 *
 * A `null` branch is dropped rather than encoded. Encoding it as
 * `type: ["object","null"]` is not an option: the MCP SDK's own ListTools schema
 * requires `outputSchema.type` to be the literal string `"object"`, so a type
 * array is rejected by the protocol layer before it is ever sent. Dropping it is
 * also lossless on the wire, because `formatMcpResult` always converts a
 * non-object result (including `null`) into `{value: …}` for `structuredContent`
 * — a bare `null` never reaches a client. The nullable form is retained where it
 * actually matters: server-side validation still uses the strict zod schema.
 *
 * Only the ROOT is rewritten. Nested combinators are valid for Anthropic, so
 * rewriting them would add risk without fixing anything.
 *
 * Pure and total: any input yields a schema with no root combinator and an
 * `object` root. Callers rely on that.
 */
export function flattenSchemaForProvider(
  schema: unknown,
  options: FlattenOptions = {},
): Record<string, unknown> {
  if (!isPlainObject(schema)) return { ...PERMISSIVE_FALLBACK };

  const combinator = ROOT_COMBINATOR_KEYS.find((key) => key in schema);
  if (!combinator) {
    // No composition: keep the shape, minus the JSON Schema meta-key.
    const { $schema: _dropped, ...rest } = schema;
    const cleaned = options.permissive ? openOutputSchema(rest) : rest;
    return sanitizeSchemaForProvider(cleaned) as Record<string, unknown>;
  }

  const branches = Array.isArray(schema[combinator]) ? (schema[combinator] as unknown[]) : [];
  // Sibling keywords (properties/required/type) declared alongside the
  // combinator also constrain the schema, so treat the parent as a branch too.
  const siblings: Record<string, unknown> = { ...schema };
  delete siblings[combinator];
  delete siblings.$schema;

  // A null branch carries no properties, so excluding it merges to the same
  // object schema. See the doc comment for why null is not encoded.
  const objectBranches = [siblings, ...branches].filter(
    (b) => isPlainObject(b) && !isNullBranch(b) && "properties" in b,
  );

  if (!objectBranches.length) {
    // A union of primitives (or nothing usable). MCP tool payloads are objects;
    // fall back to a permissive object rather than re-emitting a combinator.
    return { ...PERMISSIVE_FALLBACK };
  }

  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  let allClosed = true;

  for (const branch of objectBranches) {
    const record = branch as Record<string, unknown>;
    if (isPlainObject(record.properties)) Object.assign(properties, record.properties);
    if (Array.isArray(record.required)) {
      for (const key of record.required) if (typeof key === "string") required.add(key);
    }
    if (record.additionalProperties !== false) allClosed = false;
  }

  const merged: Record<string, unknown> = {
    type: "object",
    properties,
    additionalProperties: !allClosed,
  };
  if (!options.permissive && required.size) merged.required = [...required];
  const cleaned = options.permissive ? openOutputSchema(merged) : merged;
  return sanitizeSchemaForProvider(cleaned) as Record<string, unknown>;
}

/** Relax an object schema for advertised OUTPUT contracts. */
function openOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { required: _dropped, ...rest } = schema;
  return { ...rest, additionalProperties: true };
}

/**
 * Recursively rewrite JSON Schema constructs that provider tool validators
 * reject, preserving validation intent. Runs on EVERY advertised schema
 * (input and output) inside {@link flattenSchemaForProvider}, so a future
 * schema edit cannot reintroduce the class of failure at a nested position.
 *
 * The construct that bit us in production: a zod `z.tuple(...)` serializes to
 * `items: [ … ]` (array form). OpenAI/Anthropic require `items` to be a single
 * schema object (or boolean) and reject the whole request otherwise —
 * `[{"type":"integer","minimum":0},…] is not of types "boolean", "object"`.
 * A uniform tuple's entries merge into one `items` schema; a mixed tuple
 * becomes a nested `anyOf` (allowed off-root). `minItems`/`maxItems` are kept,
 * so a length-2 pair still validates as a pair. `prefixItems` (draft 2020-12)
 * is dropped as unsupported.
 *
 * Deliberately conservative: an empty `{}` property schema (z.any/z.unknown)
 * is left untouched, because the MCP SDK's ListTools contract requires every
 * advertised property to be an object, not a boolean.
 *
 * Pure and total: returns a new structure, never mutates, never throws.
 */
export function sanitizeSchemaForProvider(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForProvider);
  if (!isPlainObject(schema)) return schema;
  if (Object.keys(schema).length === 0) return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "items") {
      out.items = Array.isArray(value) ? mergeTupleItems(value) : sanitizeSchemaForProvider(value);
    } else if (key === "prefixItems") {
      // Draft 2020-12 tuple form; the target validators only understand `items`.
    } else if (key === "additionalProperties") {
      out.additionalProperties = sanitizeSchemaForProvider(value);
    } else if (key === "properties" || key === "$defs" || key === "definitions") {
      if (isPlainObject(value)) {
        const mapped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) mapped[k] = sanitizeSchemaForProvider(v);
        out[key] = mapped;
      } else {
        out[key] = value;
      }
    } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      out[key] = Array.isArray(value) ? value.map(sanitizeSchemaForProvider) : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Collapse a JSON Schema tuple `items` array into one accepted schema. */
function mergeTupleItems(entries: unknown[]): unknown {
  const items = entries.map(sanitizeSchemaForProvider);
  if (!items.length) return true;
  const first = JSON.stringify(items[0]);
  return items.every((item) => JSON.stringify(item) === first) ? items[0] : { anyOf: items };
}

/**
 * Deep provider-safety check: the ROOT rules (enforced by
 * {@link assertProviderSafeSchema}) plus the nested constructs
 * {@link sanitizeSchemaForProvider} exists to remove. Runs after sanitization
 * at server construction, so a regression fails loudly instead of 400-ing.
 */
export function findProviderSchemaHazard(schema: unknown, path = "$"): string | null {
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i++) {
      const hit = findProviderSchemaHazard(schema[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!isPlainObject(schema)) return null;
  if (Array.isArray(schema.items)) return `${path}.items is a tuple array (items must be a single schema)`;
  if ("prefixItems" in schema) return `${path}.prefixItems is unsupported`;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "prefixItems") continue;
    const hit = findProviderSchemaHazard(value, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Assert a schema is safe to advertise. Called at server construction so a
 * future schema change fails loudly and immediately, naming the offending tool,
 * instead of turning into an unrecoverable 400 on some provider months later.
 *
 * `type` must be the literal `"object"` (or absent): the MCP SDK's ListTools
 * schema rejects a type array, and Anthropic rejects root combinators.
 */
export function assertProviderSafeSchema(
  name: string,
  schema: unknown,
  kind: "inputSchema" | "outputSchema",
): Record<string, unknown> {
  if (!isPlainObject(schema)) {
    throw new Error(`${name}.${kind} is not a JSON object`);
  }
  const found = ROOT_COMBINATOR_KEYS.filter((key) => key in schema);
  if (found.length) {
    throw new Error(
      `${name}.${kind} has root-level ${found.join("/")}; ` +
        "Anthropic rejects tool schemas with top-level combinators (400). " +
        "Wrap it with flattenSchemaForProvider().",
    );
  }
  if (schema.type !== undefined && schema.type !== "object") {
    throw new Error(
      `${name}.${kind} must declare type "object" (or omit it), got ${JSON.stringify(schema.type)}`,
    );
  }
  if ("$schema" in schema) {
    throw new Error(`${name}.${kind} must not advertise the $schema meta-key`);
  }
  const hazard = findProviderSchemaHazard(schema);
  if (hazard) {
    throw new Error(
      `${name}.${kind} has a provider-unsafe nested schema at ${hazard}. ` +
        "OpenAI/Anthropic reject array-form `items` (zod tuples) and prefixItems; " +
        "declare a plain array (.length(n)) or fix sanitizeSchemaForProvider().",
    );
  }
  return schema;
}
export type ContextInput = z.infer<typeof ContextInputSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
export type RecordInput = z.infer<typeof MemoryRecordSchema> | z.infer<typeof OutcomeRecordSchema>;
export const TimelineInputSchema = z.object({ since: z.string().optional(), until: z.string().optional(), kinds: z.array(z.string()).max(11).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(200).optional() }).strict();
export const DetailInputSchema = z.object({ id: z.string().min(1).max(120) }).strict();
export const HandoffInputSchema = z.object({ goal: z.string().min(1).max(2000), completedWork: z.array(z.string()).max(50).optional(), testsPassed: z.number().int().nonnegative().optional(), testsFailed: z.number().int().nonnegative().optional(), testsSkipped: z.number().int().nonnegative().optional(), failures: z.array(z.string()).max(20).optional(), openRisks: z.array(z.string()).max(20).optional(), nextActions: z.array(z.string()).max(20).optional(), evidenceIds: z.array(z.string()).max(100).optional(), sessionId: z.string().optional() }).strict();
export const ResumeInputSchema = z.object({ id: z.string().min(1).max(120) }).strict();
export const ReviewInputSchema = z.object({ action: z.enum(["list", "approve", "edit", "dispute", "invalidate", "pin", "suppress", "purge", "refresh-evidence"]), id: z.string().max(120).optional(), statuses: z.array(z.string().max(30)).max(10).optional(), limit: z.number().int().min(1).max(1000).optional(), content: z.string().max(8_000).optional(), confidence: z.number().min(0).max(1).optional(), tags: z.array(z.string().max(100)).max(50).optional(), cursor: z.string().max(200).optional() }).strict();
export const SafetyInputSchema = z.object({ changedFiles: z.array(z.string().max(500)).max(500).optional(), staged: z.array(z.string().max(500)).max(500).optional(), untracked: z.array(z.string().max(500)).max(500).optional(), branch: z.string().max(200).optional() }).strict();
function isSafeGraphSelector(value: string): boolean {
  if (/^node:[a-f0-9]{64}$/i.test(value)) return true;
  const match = /^(?:path:([^\\\0\r\n]+)|symbol:([^#\\\0\r\n]+)#[^\\\0\r\n]+)$/i.exec(value);
  if (!match) return false;
  const path = match[1] ?? match[2] ?? "";
  return !path.startsWith("/") && !path.startsWith("\\") && !/^[a-z]:/i.test(path) && !path.split("/").includes("..");
}
const GraphSelectorSchema = z.string().min(6).max(600).refine(
  isSafeGraphSelector,
  "selector must be node:<sha256>, path:<project-relative-file>, or symbol:<path>#<symbol>",
);
const GraphLimitsSchema = {
  maxDepth: z.number().int().min(1).max(5).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
  maxFanout: z.number().int().min(1).max(200).optional(),
};
export const GraphStatusInputSchema = z.object({}).strict();
export const GraphRebuildInputSchema = z.object({ forceIndex: z.boolean().optional() }).strict();
export const GraphQueryInputSchema = z.object({ selector: GraphSelectorSchema, ...GraphLimitsSchema }).strict();
export const GraphPathInputSchema = z.object({ from: GraphSelectorSchema, to: GraphSelectorSchema, ...GraphLimitsSchema }).strict();
export const GraphExplainInputSchema = z.object({ selector: GraphSelectorSchema }).strict();
export const GraphImpactInputSchema = z.object({ selector: GraphSelectorSchema, direction: z.enum(["incoming", "outgoing"]), ...GraphLimitsSchema }).strict();

// ---------------------------------------------------------------------------
// Output schemas — mirror engine return types from packages/core/src/types.ts
// Top-level fields declared; passthrough on nested dynamic maps.
// ---------------------------------------------------------------------------

export const SourceReferenceOutputSchema = z.object({
  kind: z.enum(["file", "commit", "command", "external", "session"]),
  value: z.string(),
  lines: z.tuple([z.number(), z.number()]).optional(),
  hash: z.string().optional(),
  note: z.string().optional(),
}).passthrough();

export const InvalidationRuleOutputSchema = z.object({
  kind: z.enum(["file-hash-changed", "file-deleted", "time-elapsed", "manual"]),
  target: z.string().optional(),
  expiresAt: z.string().optional(),
}).passthrough();

export const MemoryEntryOutputSchema = z.object({
  id: z.string(),
  kind: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastVerifiedAt: z.string().optional(),
  confidence: z.number(),
  status: z.string(),
  sourceReferences: z.array(SourceReferenceOutputSchema),
  relatedFiles: z.array(z.string()),
  relatedSymbols: z.array(z.string()),
  tags: z.array(z.string()),
  invalidationRules: z.array(InvalidationRuleOutputSchema),
  supersedes: z.array(z.string()).optional(),
  origin: z.string().optional(),
}).passthrough();

export const MemorySelectionOutputSchema = z.object({
  entry: MemoryEntryOutputSchema,
  score: z.number(),
  reason: z.string(),
  estimatedTokens: z.number(),
}).passthrough();

export const FileSelectionOutputSchema = z.object({
  path: z.string(),
  mode: z.enum(["full", "summary", "reference"]),
  estimatedTokens: z.number(),
  estimatedSourceTokens: z.number().optional(),
  score: z.number(),
  reason: z.string(),
  hash: z.string().optional(),
}).passthrough();

export const SummarySelectionOutputSchema = z.object({
  path: z.string(),
  summary: z.string(),
  sourceHash: z.string(),
  verified: z.boolean(),
  estimatedTokens: z.number(),
  reason: z.string(),
}).passthrough();

export const ContextBudgetOutputSchema = z.object({
  maxTokens: z.number(),
  usedTokens: z.number(),
  remainingTokens: z.number(),
});

export const CacheReportOutputSchema = z.object({
  hits: z.number(),
  misses: z.number(),
  stale: z.number(),
  entries: z.number(),
});

export const ContextOmissionOutputSchema = z.object({
  path: z.string(),
  reason: z.string(),
  detail: z.string().optional(),
}).passthrough();

export const GitChangeSummaryOutputSchema = z.object({
  branch: z.string().optional(),
  changedFiles: z.array(z.string()),
  staged: z.array(z.string()),
  untracked: z.array(z.string()),
  ahead: z.number().optional(),
  behind: z.number().optional(),
}).passthrough();

export const SkillRecommendationOutputSchema = z.object({
  name: z.string(),
  reason: z.string(),
  priority: z.number(),
  intendedAgent: z.string().optional(),
  needsLoad: z.boolean(),
}).passthrough();

export const SkillExclusionOutputSchema = z.object({
  name: z.string(),
  reason: z.string(),
});

export const McpToolRecommendationOutputSchema = z.object({
  server: z.string(),
  tool: z.string().optional(),
  purpose: z.string(),
  mutating: z.boolean(),
  requiresApproval: z.boolean(),
  estimatedSchemaTokens: z.number().optional(),
}).passthrough();

export const McpExclusionOutputSchema = z.object({
  server: z.string(),
  reason: z.string(),
});

export const ContextPacketOutputSchema = z.object({
  taskId: z.string(),
  taskSummary: z.string(),
  selectedMemory: z.array(MemorySelectionOutputSchema),
  selectedFiles: z.array(FileSelectionOutputSchema),
  selectedSummaries: z.array(SummarySelectionOutputSchema),
  currentGitChanges: GitChangeSummaryOutputSchema.optional(),
  constraints: z.array(z.string()),
  knownFailures: z.array(z.string()),
  estimatedTokens: z.number(),
  budget: ContextBudgetOutputSchema,
  cacheReport: CacheReportOutputSchema,
  omissions: z.array(ContextOmissionOutputSchema),
  recommendedSkills: z.array(SkillRecommendationOutputSchema),
  excludedSkills: z.array(SkillExclusionOutputSchema),
  recommendedMcpTools: z.array(McpToolRecommendationOutputSchema),
  excludedMcpServers: z.array(McpExclusionOutputSchema),
  generatedAt: z.string(),
}).passthrough();

export const StructuralEventOutputSchema = z.object({
  id: z.string(),
  kind: z.string(),
  at: z.string(),
  sessionId: z.string().optional(),
  paths: z.array(z.string()).optional(),
  toolCategory: z.string().optional(),
  toolName: z.string().optional(),
  status: z.string().optional(),
  durationMs: z.number().optional(),
  testsPassed: z.number().optional(),
  testsFailed: z.number().optional(),
  testsSkipped: z.number().optional(),
  errorClass: z.string().optional(),
  memoryId: z.string().optional(),
  note: z.string().optional(),
}).passthrough();

export const HandoffCapsuleOutputSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  projectFingerprint: z.string(),
  eventWatermark: z.string().nullable(),
  goal: z.string(),
  completedWork: z.array(z.string()),
  changedFiles: z.array(z.object({ path: z.string(), hash: z.string().nullable() })),
  testsPassed: z.number(),
  testsFailed: z.number(),
  testsSkipped: z.number(),
  failures: z.array(z.string()),
  openRisks: z.array(z.string()),
  nextActions: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  sessionId: z.string().optional(),
}).passthrough();

export const SafetyBriefOutputSchema = z.object({
  generatedAt: z.string(),
  changedFiles: z.array(z.string()),
  dependencyManifestChanges: z.array(z.string()),
  secretRiskFiles: z.array(z.string()),
  unresolvedFailures: z.array(z.object({ id: z.string(), content: z.string() })),
  staleEvidence: z.array(z.object({ id: z.string(), content: z.string() })),
  openTasks: z.array(z.string()),
  testsObserved: z.boolean(),
}).passthrough();

export const SweepReportOutputSchema = z.object({
  ranAt: z.string(),
  reason: z.string(),
  abandonedTasks: z.array(z.string()),
  releasedOwnership: z.array(z.string()),
  expiredSessions: z.array(z.string()),
  prunedCacheEntries: z.number(),
  memoryFlaggedForReverify: z.array(z.string()),
  prunedCompletedTasks: z.number(),
  collectedLocks: z.array(z.string()),
  clean: z.boolean(),
}).passthrough();

/** Shape returned by engine.review dispatch (union of all action results). */
export const ReviewOutputSchema = z.object({
  entries: z.array(MemoryEntryOutputSchema).optional(),
  nextCursor: z.string().optional(),
  disabled: z.literal(true).optional(),
  purged: z.boolean().optional(),
  // Actions return lifecycle statuses ("stale", "active", ...) besides the
  // edit/dispute editor outcomes. Keep it string-bounded rather than a narrow
  // enum so commitment-then-validation cannot fail with RESULT_SCHEMA_MISMATCH.
  status: z.string().max(30).optional(),
  reason: z.string().optional(),
  entry: MemoryEntryOutputSchema.optional(),
  error: z.string().optional(),
  id: z.string().optional(),
  invalidRefs: z.array(z.any()).optional(),
  // refresh-evidence result fields.
  refreshed: z.boolean().optional(),
  verified: z.boolean().optional(),
  entryId: z.string().max(120).optional(),
  refs: z.array(z.object({
    file: z.string().max(500),
    oldHash: z.string().max(128),
    newHash: z.string().max(128),
  }).passthrough()).optional(),
  missing: z.array(z.string().max(500)).optional(),
  resultingStatus: z.string().max(30).optional(),
}).passthrough();

/** Paginated search result envelope. */
export const SearchOutputSchema = z.object({
  items: z.array(MemorySelectionOutputSchema),
  nextCursor: z.string().optional(),
}).passthrough();

/** Paginated timeline result envelope. */
export const TimelineOutputSchema = z.object({
  entries: z.array(StructuralEventOutputSchema),
  nextCursor: z.string().optional(),
}).passthrough();

/** Status result (handles both enabled and disabled shapes). */
export const StatusOutputSchema = z.object({
  protocolVersion: z.string().optional(),
  toolsetApiVersion: z.string().optional(),
  packageVersion: z.string().optional(),
  integration: z.string().optional(),
  capabilities: z.any().optional(),
  enabled: z.boolean(),
  health: z.any().optional(),
  disabled: z.literal(true).optional(),
  noop: z.literal(true).optional(),
}).passthrough();

/** engine.recordMemory return. */
export const RecordMemoryOutputSchema = z.object({
  status: z.enum(["recorded", "rejected"]),
  reason: z.string().optional(),
  redacted: z.boolean(),
  entry: MemoryEntryOutputSchema.optional(),
}).passthrough();

/** engine.recordOutcome return. */
export const RecordOutcomeOutputSchema = z.object({
  recorded: z.boolean(),
  operationId: z.string(),
}).nullable();

/**
 * cortex_record serves two facets (memory + outcome) under one tool name.
 * Strict MCP hosts validate structuredContent against the single advertised
 * output schema, so it must accept both result shapes — otherwise the outcome
 * facet (which has no status/redacted) fails host-side with -32602 even
 * though the mutation was committed.
 *
 * The third branch is the server's own error envelope ({error, code}).
 * Without it, any input rejection or pre-commit failure is masked: the host
 * validates the envelope against the result shapes and reports a confusing
 * -32602 about missing status/redacted instead of the real message
 * (e.g. "kind: Required"). With it, failures stay model-visible.
 */
export const RecordErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
});
export const RecordOutputSchema = z.union([
  RecordMemoryOutputSchema,
  RecordOutcomeOutputSchema,
  RecordErrorSchema,
]);

/** engine.resumeHandoff return (always wrapped in extra result object). */
export const ResumeOutputSchema = z.object({
  capsule: HandoffCapsuleOutputSchema,
  staleFiles: z.array(z.string()),
  evidence: z.array(MemoryEntryOutputSchema),
  brief: z.string(),
}).passthrough().nullable();

const CodeGraphNodeOutputSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["repository", "directory", "file", "symbol"]),
  label: z.string().max(300),
  path: z.string().max(500).optional(),
  symbol: z.string().max(200).optional(),
  language: z.string().max(64).optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  provenance: z.literal("repository-index"),
  confidence: z.literal("extracted"),
  extractorVersion: z.number().int().positive(),
}).strict();

const CodeGraphEdgeOutputSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  from: z.string().regex(/^[a-f0-9]{64}$/),
  to: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["contains", "defines", "imports"]),
  provenance: z.literal("repository-index"),
  confidence: z.literal("extracted"),
  sourcePath: z.string().max(500),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const GraphStatusOutputSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  generationId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceWatermark: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().optional(),
  nodeCount: z.number().int().nonnegative().optional(),
  edgeCount: z.number().int().nonnegative().optional(),
  automaticContext: z.boolean().describe(
    "True only when an active graph generation exists AND graph.automaticContext is enabled.",
  ),
}).strict();

export const GraphRebuildOutputSchema = z.object({
  rebuilt: z.boolean(),
  graph: GraphStatusOutputSchema,
}).strict();

const GraphQueryOutputSchema = z.object({
  generationId: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(CodeGraphNodeOutputSchema).max(51),
  edges: z.array(CodeGraphEdgeOutputSchema).max(50),
  truncated: z.boolean(),
  reason: z.string().max(2000).optional(),
}).strict();

/** Mapping from tool name to output Zod schema. */
export const JevStatusOutputSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  coolingDown: z.boolean(),
  /** Active decision-provider preset id (jev, laya-local, laya-hosted, custom). */
  provider: z.string().max(100),
  /** Model the provider is called with. */
  model: z.string().max(300),
  /** Health-gated state: decisions are used only when "active". */
  state: z.enum(["disabled", "no-key", "checking", "active", "unreachable"]),
  reason: z.string().max(500).optional(),
  latencyMs: z.number().int().nonnegative().optional(),
}).strict();
export const JevReviewInputSchema = z.object({
  evidence: z.record(z.string(), z.unknown()),
  taskQuery: z.string().max(2_000).optional(),
}).strict();
export const JevReviewOutputSchema = z.object({
  recommendReview: z.boolean(),
  confidence: z.number(),
  fromJev: z.boolean(),
}).strict();
export const CapabilitiesOutputSchema = z.object({
  servers: z.record(
    z.string(),
    z.object({
      availability: z.string(),
      consecutiveFailures: z.number(),
      successes: z.number(),
      lastOkAt: z.string().optional(),
      lastErrorAt: z.string().optional(),
      lastError: z.string().optional(),
    }),
  ),
  testedTools: z.array(z.string()),
  web: z.object({
    searchServers: z.array(z.string()),
    fetchServers: z.array(z.string()),
  }),
}).strict();
export const OutputSchemas: Record<string, z.ZodTypeAny> = {
  cortex_context: ContextPacketOutputSchema.nullable(),
  cortex_search: SearchOutputSchema,
  cortex_record: RecordOutputSchema,
  cortex_status: StatusOutputSchema,
  cortex_timeline: TimelineOutputSchema,
  cortex_detail: StructuralEventOutputSchema.nullable(),
  cortex_handoff: HandoffCapsuleOutputSchema.nullable(),
  cortex_resume: ResumeOutputSchema,
  cortex_review: ReviewOutputSchema,
  cortex_safety: SafetyBriefOutputSchema.nullable(),
  cortex_graph_status: GraphStatusOutputSchema,
  cortex_graph_rebuild: GraphRebuildOutputSchema,
  cortex_graph_query: GraphQueryOutputSchema.nullable(),
  cortex_graph_path: GraphQueryOutputSchema.nullable(),
  cortex_graph_explain: GraphQueryOutputSchema.nullable(),
  cortex_graph_impact: GraphQueryOutputSchema.nullable(),
  cortex_jev_status: JevStatusOutputSchema,
  cortex_jev_review: JevReviewOutputSchema,
  cortex_capabilities: CapabilitiesOutputSchema,
};

// ---------------------------------------------------------------------------
// Cursor pagination helpers
// ---------------------------------------------------------------------------

export interface CursorData {
  v: 1;
  off: number;
  q: string;
}

/** Encode a pagination cursor: base64url-encoded JSON {v:1, off, q}. */
export function encodeCursor(offset: number, queryHash: string): string {
  const data: CursorData = { v: 1, off: offset, q: queryHash };
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

/**
 * Decode a pagination cursor. Returns {offset, queryHash} on success, or
 * {error} on failure (bad encoding, wrong format, truncated q).
 */
export function decodeCursor(
  cursor: string,
): { offset: number; queryHash: string } | { error: string } {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const data = JSON.parse(json) as Record<string, unknown>;
    if (
      data?.v === 1 &&
      typeof data.off === "number" &&
      Number.isInteger(data.off) &&
      data.off >= 0 &&
      typeof data.q === "string" &&
      /^[a-f0-9]{64}$/i.test(data.q)
    ) {
      return { offset: data.off, queryHash: data.q };
    }
    return { error: "invalid cursor format" };
  } catch {
    return { error: "invalid cursor encoding" };
  }
}

/**
 * Compute a canonical SHA-256 hash of the given query parameters (sorted keys).
 * Used to bind a cursor to a specific query so replaying a cursor on a
 * different query is detected.
 */
export function canonicalQueryHash(params: Record<string, unknown>): string {
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Default page size when limit is not specified.
 */
export const DEFAULT_PAGE_LIMIT = 25;
