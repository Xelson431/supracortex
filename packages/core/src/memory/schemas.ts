/**
 * Memory entry construction, normalization, and validation.
 *
 * No external schema library in core (keeps the package dependency-free). We
 * validate structurally and enforce policy: durable facts require evidence,
 * confidence is clamped, and content is redacted for likely secrets before it
 * is ever handed to storage.
 */

import { randomUUID } from "node:crypto";
import type {
  InvalidationRule,
  MemoryEntry,
  MemoryKind,
  MemoryStatus,
  SourceReference,
} from "../types.ts";
import { redactSecrets, containsLikelySecret, safeRelative } from "./validation.ts";

export interface NewMemoryInput {
  kind: MemoryKind;
  content: string;
  confidence?: number;
  sourceReferences?: SourceReference[];
  relatedFiles?: string[];
  relatedSymbols?: string[];
  tags?: string[];
  invalidationRules?: InvalidationRule[];
  supersedes?: string[];
  origin?: string;
  status?: MemoryStatus;
}

export interface BuildOptions {
  requireEvidenceForDurableFacts: boolean;
  redactLikelySecrets: boolean;
  minimumConfidence: number;
  /** When set, related-file and file source-reference paths are confined here. */
  projectRoot?: string;
  /** Injectable clock (ms). Defaults to Date.now(). */
  now?: number;
}

export interface BuildResult {
  entry?: MemoryEntry;
  rejected?: string;
  redacted: boolean;
}

const DURABLE_KINDS: MemoryKind[] = ["fact", "decision", "convention", "constraint"];

// Hard resource bounds to prevent unbounded growth / DoS via giant inputs.
export const MAX_CONTENT_CHARS = 8_000;
export const MAX_ARRAY_ITEMS = 200;
export const MAX_REF_ITEMS = 100;
const MEMORY_KINDS = new Set<MemoryKind>(["fact", "decision", "convention", "failure", "constraint", "task-outcome"]);
const MEMORY_STATUSES = new Set<MemoryStatus>(["active", "superseded", "stale", "disputed", "candidate", "forgotten"]);
const SOURCE_KINDS = new Set(["file", "commit", "command", "external", "session"]);
const INVALIDATION_KINDS = new Set(["file-hash-changed", "file-deleted", "time-elapsed", "manual"]);
const MAX_METADATA_CHARS = 4_096;

export function buildMemoryEntry(input: NewMemoryInput, opts: BuildOptions): BuildResult {
  const rawContent = (input.content ?? "").trim();
  if (!rawContent) return { rejected: "empty content", redacted: false };
  // Cap content length; do not silently truncate durable facts (reject instead
  // so the caller knows the evidence is incomplete), but truncate volatile kinds.
  let content = rawContent;
  if (rawContent.length > MAX_CONTENT_CHARS) {
    if (DURABLE_KINDS.includes(input.kind)) {
      return {
        rejected: `content exceeds ${MAX_CONTENT_CHARS} chars for a durable ${input.kind}; summarize it`,
        redacted: false,
      };
    }
    content = rawContent.slice(0, MAX_CONTENT_CHARS);
  }

  const confidence = clamp01(input.confidence ?? 0.7);
  const kind = input.kind;
  const sources = (input.sourceReferences ?? []).slice(0, MAX_REF_ITEMS);

  if (
    opts.requireEvidenceForDurableFacts &&
    DURABLE_KINDS.includes(kind) &&
    sources.length === 0
  ) {
    return {
      rejected: `durable ${kind} requires at least one sourceReference (evidence)`,
      redacted: false,
    };
  }

  if (confidence < opts.minimumConfidence) {
    return {
      rejected: `confidence ${confidence} below minimum ${opts.minimumConfidence}`,
      redacted: false,
    };
  }

  let redacted = false;
  let finalContent = content;
  if (opts.redactLikelySecrets) {
    const r = redactSecrets(content);
    finalContent = r.text;
    redacted = r.redactedCount > 0;
  } else if (containsLikelySecret(content)) {
    // Even with redaction off, refuse to persist raw obvious secrets.
    return { rejected: "content appears to contain a secret; refusing to store", redacted: false };
  }

  // Redact string metadata too (notes, external URLs, command strings, origin).
  const scrub = (s: string): string => {
    if (!opts.redactLikelySecrets) {
      if (containsLikelySecret(s)) return "[REDACTED]";
      return s;
    }
    const r = redactSecrets(s);
    if (r.redactedCount > 0) redacted = true;
    return r.text;
  };

  // Confine file-kind source references and relatedFiles to the project root.
  const confinePath = (p: string): string | null => {
    if (!opts.projectRoot) return p;
    const rel = safeRelative(opts.projectRoot, p);
    if (rel === null) return null;
    return rel;
  };

  const cleanSources: SourceReference[] = [];
  for (const ref of sources) {
    const out: SourceReference = { kind: ref.kind, value: ref.value };
    if (ref.kind === "file") {
      const confined = confinePath(ref.value);
      if (confined === null) continue; // drop out-of-project file reference
      out.value = confined;
    } else {
      out.value = scrub(ref.value);
    }
    if (ref.lines) out.lines = ref.lines;
    if (ref.hash) out.hash = ref.hash;
    if (ref.note) out.note = scrub(ref.note);
    cleanSources.push(out);
  }

  // Re-check evidence policy after dropping any out-of-project file refs.
  const lacksVerifiableLocalEvidence =
    opts.requireEvidenceForDurableFacts &&
    DURABLE_KINDS.includes(kind) &&
    !cleanSources.some((source) => source.kind === "file");

  const cleanRelatedFiles = dedupe(
    (input.relatedFiles ?? [])
      .map((f) => confinePath(f))
      .filter((f): f is string => f !== null),
  );

  const now = new Date(opts.now ?? Date.now()).toISOString();
  const entry: MemoryEntry = {
    id: randomUUID(),
    kind,
    content: finalContent,
    createdAt: now,
    updatedAt: now,
    confidence,
    // Preserve externally/agent-supplied assertions for review, but never let
    // an unverifiable source activate a durable claim automatically.
    status: lacksVerifiableLocalEvidence ? "candidate" : (input.status ?? "active"),
    sourceReferences: cleanSources,
    relatedFiles: cleanRelatedFiles,
    relatedSymbols: dedupe(input.relatedSymbols ?? []),
    tags: dedupe((input.tags ?? []).map(scrub)),
    invalidationRules: input.invalidationRules ?? [],
  };
  if (input.supersedes && input.supersedes.length) entry.supersedes = input.supersedes;
  if (input.origin) entry.origin = scrub(input.origin);

  return { entry, redacted };
}

/**
 * Record classification after schema validation (3a).
 *
 * Deterministic rules now; LLM hook point for a future classifier:
 *   // LLM hook: replace `classifyRecord` internals with an ADD/UPDATE/DELETE/
 *   // NOOP model call here once a provider is wired. Keep these deterministic
 *   // rules as the fallback and never let the model rewrite history directly.
 *
 * - "noop": normalized content exactly duplicates an active same-kind entry.
 * - "update": high token overlap with an active same-kind entry (caller may set
 *   `supersedes` to the matched id; contradictions still become candidates).
 * - "add": otherwise.
 */
export type RecordClassification = "add" | "update" | "noop";

export function classifyRecord(
  content: string,
  kind: MemoryKind,
  existing: MemoryEntry[],
): { classification: RecordClassification; matchId?: string } {
  const norm = content.trim().toLowerCase().replace(/\s+/g, " ");
  if (!norm) return { classification: "noop" };
  const cTokens = new Set(norm.split(/[^a-z0-9_]+/).filter((t) => t.length >= 3));
  let bestId: string | undefined;
  let bestRatio = 0;
  for (const e of existing) {
    if (e.status !== "active" || e.kind !== kind) continue;
    const eNorm = e.content.trim().toLowerCase().replace(/\s+/g, " ");
    if (eNorm === norm) return { classification: "noop", matchId: e.id };
    const eTokens = new Set(
      eNorm.split(/[^a-z0-9_]+/).filter((t) => t.length >= 3),
    );
    const denom = Math.min(cTokens.size, eTokens.size) || 1;
    let overlap = 0;
    for (const t of cTokens) if (eTokens.has(t)) overlap++;
    const ratio = overlap / denom;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestId = e.id;
    }
  }
  if (bestRatio >= 0.6 && bestId) return { classification: "update", matchId: bestId };
  return { classification: "add" };
}

export function isValidMemoryEntry(v: unknown): v is MemoryEntry {
  if (!isRecord(v)) return false;
  const e = v as Record<string, unknown>;
  // Older stores used non-UUID identifiers. Accept bounded opaque IDs here so
  // the read-only v1 compatibility path can classify them instead of silently
  // erasing durable memory; new writes still generate UUIDs.
  if (!boundedString(e.id, 1, 256) || !isMemoryKind(e.kind) || !boundedString(e.content, 1, MAX_CONTENT_CHARS) || !finiteUnit(e.confidence) || !isMemoryStatus(e.status)) return false;
  if (!iso(e.createdAt) || !iso(e.updatedAt) || Date.parse(e.updatedAt) < Date.parse(e.createdAt)) return false;
  if (e.lastVerifiedAt !== undefined && (!iso(e.lastVerifiedAt) || Date.parse(e.lastVerifiedAt) < Date.parse(e.createdAt))) return false;
  if (e.needsReverifyAt !== undefined && (!iso(e.needsReverifyAt) || Date.parse(e.needsReverifyAt) < Date.parse(e.createdAt))) return false;
  if (!arrayOf(e.sourceReferences, MAX_REF_ITEMS, validSourceReference)) return false;
  if (!arrayOf(e.relatedFiles, MAX_ARRAY_ITEMS, validRelativePath)) return false;
  if (!arrayOf(e.relatedSymbols, MAX_ARRAY_ITEMS, (x) => boundedString(x, 1, MAX_METADATA_CHARS))) return false;
  if (!arrayOf(e.tags, MAX_ARRAY_ITEMS, (x) => boundedString(x, 1, 256))) return false;
  if (!arrayOf(e.invalidationRules, MAX_ARRAY_ITEMS, validInvalidationRule)) return false;
  // Memory ids are opaque identifiers (older stores and imported corpora use
  // bounded non-UUID ids), so `supersedes` must accept whatever `id` accepts.
  if (e.supersedes !== undefined && !arrayOf(e.supersedes, MAX_ARRAY_ITEMS, (x) => boundedString(x, 1, 256))) return false;
  return e.origin === undefined || boundedString(e.origin, 1, MAX_METADATA_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedString(value: unknown, min: number, max: number): value is string { return typeof value === "string" && Buffer.byteLength(value, "utf8") >= min && Buffer.byteLength(value, "utf8") <= max; }
function finiteUnit(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function iso(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function isMemoryKind(value: unknown): value is MemoryKind { return typeof value === "string" && MEMORY_KINDS.has(value as MemoryKind); }
function isMemoryStatus(value: unknown): value is MemoryStatus { return typeof value === "string" && MEMORY_STATUSES.has(value as MemoryStatus); }
function validRelativePath(value: unknown): value is string { return boundedString(value, 1, MAX_METADATA_CHARS) && !value.includes("\\") && !value.startsWith("/") && !/^[a-z]:/i.test(value) && value.split("/").every((part) => part !== ".." && part.length > 0); }
function arrayOf(value: unknown, max: number, predicate: (item: unknown) => boolean): boolean { return Array.isArray(value) && value.length <= max && value.every(predicate); }
function validSourceReference(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string" || !SOURCE_KINDS.has(value.kind) || !boundedString(value.value, 1, MAX_METADATA_CHARS)) return false;
  if (value.kind === "file" && !validRelativePath(value.value)) return false;
  if (value.lines !== undefined && (!Array.isArray(value.lines) || value.lines.length !== 2 || !Number.isInteger(value.lines[0]) || !Number.isInteger(value.lines[1]) || value.lines[0] < 1 || value.lines[1] < value.lines[0])) return false;
  if (value.hash !== undefined && (!boundedString(value.hash, 8, 128) || !/^[a-f0-9]+$/i.test(value.hash))) return false;
  return value.note === undefined || boundedString(value.note, 1, MAX_METADATA_CHARS);
}
function validInvalidationRule(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string" || !INVALIDATION_KINDS.has(value.kind)) return false;
  if (value.target !== undefined && !boundedString(value.target, 1, MAX_METADATA_CHARS)) return false;
  if (value.kind.startsWith("file-") && value.target !== undefined && !validRelativePath(value.target)) return false;
  return value.expiresAt === undefined || iso(value.expiresAt);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean))).slice(0, MAX_ARRAY_ITEMS);
}
