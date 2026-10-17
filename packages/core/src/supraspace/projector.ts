/**
 * SupraSpace projector + ingester — the unification bridge.
 *
 * PROJECT (Cortex -> SupraSpace): render Cortex's structured memory into the
 * six SupraSpace Markdown files inside a marker-fenced "managed block", grouped
 * by kind. Human/agent free-form text outside the block is preserved verbatim.
 *
 * INGEST (SupraSpace -> Cortex): parse the free-form (NON-managed) portion of
 * the files into candidate memory entries. The managed block is skipped so
 * Cortex never re-ingests its own output (loop-safe).
 *
 * Mapping (kind -> file):
 *   decision              -> decisions.md
 *   failure, task-outcome -> agent-notes.md
 *   fact, constraint      -> architecture.md
 *   convention            -> architecture.md
 * (project.md / tasks.md / review-notes.md remain human-authored; ingest reads
 *  them but Cortex does not overwrite them beyond an optional managed block.)
 */

import type {
  MemoryEntry,
  MemoryKind,
  SupraSpaceMemoryFile,
} from "../types.ts";
import type { NewMemoryInput } from "../memory/schemas.ts";

export const BLOCK_BEGIN = "<!-- cortex:managed:begin -->";
export const BLOCK_END = "<!-- cortex:managed:end -->";

const KIND_TO_FILE: Record<MemoryKind, SupraSpaceMemoryFile> = {
  decision: "decisions.md",
  failure: "agent-notes.md",
  "task-outcome": "agent-notes.md",
  fact: "architecture.md",
  constraint: "architecture.md",
  convention: "architecture.md",
};

const KIND_HEADING: Record<MemoryKind, string> = {
  decision: "Decisions",
  failure: "Known Failures",
  "task-outcome": "Task Outcomes",
  fact: "Facts",
  constraint: "Constraints",
  convention: "Conventions",
};

/** Files Cortex will write a managed block into. */
export const PROJECTED_FILES: SupraSpaceMemoryFile[] = ["decisions.md", "agent-notes.md", "architecture.md"];

/**
 * Strip the Cortex managed block from a file's content, returning the free-form
 * remainder (what a human/agent wrote). Loop-safety: ingest uses this so it
 * never reads back Cortex's own projected text.
 */
export function stripManagedBlock(content: string): string {
  const begin = content.indexOf(BLOCK_BEGIN);
  if (begin === -1) return content;
  const end = content.indexOf(BLOCK_END, begin);
  if (end === -1) return content.slice(0, begin).trimEnd() + "\n";
  const before = content.slice(0, begin);
  const after = content.slice(end + BLOCK_END.length);
  return (before.trimEnd() + "\n" + after.trimStart()).trim() + "\n";
}

/** Render the managed block for a set of entries assigned to one file. */
function renderBlock(entries: MemoryEntry[], _now: number): string {
  const byKind = new Map<MemoryKind, MemoryEntry[]>();
  for (const e of entries) {
    if (e.status !== "active") continue;
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }
  const parts: string[] = [BLOCK_BEGIN];
  // NOTE: no timestamp inside the block — the block must be a PURE function of
  // the entries so projection is idempotent (re-syncing unchanged memory is a
  // no-op write and file content converges). File mtime records "when".
  parts.push(
    "_Managed by Cortex (supracortex). Do not edit inside this block; it is regenerated on sync._",
  );
  for (const [kind, list] of byKind) {
    if (!list.length) continue;
    parts.push("", `### ${KIND_HEADING[kind]}`);
    for (const e of list.sort((a, b) => b.confidence - a.confidence)) {
      const refs = e.sourceReferences
        .filter((r) => r.kind === "file")
        .map((r) => r.value)
        .slice(0, 3);
      const suffix = refs.length ? `  _(${refs.join(", ")})_` : "";
      parts.push(`- ${e.content}${suffix}`);
    }
  }
  parts.push(BLOCK_END);
  return parts.join("\n") + "\n";
}

/**
 * Compose the new file content: preserved free-form text + a fresh managed
 * block appended at the end. Idempotent — replacing the old block if present.
 */
export function composeFileContent(
  currentContent: string,
  entriesForFile: MemoryEntry[],
  now: number,
): string {
  const freeform = stripManagedBlock(currentContent).trimEnd();
  if (entriesForFile.length === 0) {
    // No managed content: leave only the free-form text (removes a stale block).
    return freeform.length ? freeform + "\n" : "";
  }
  const block = renderBlock(entriesForFile, now);
  return (freeform.length ? freeform + "\n\n" : "") + block;
}

export interface ProjectionPlan {
  /** file -> new full content to write. */
  writes: Map<SupraSpaceMemoryFile, string>;
  projectedEntries: number;
}

/**
 * Plan the projection: which files to rewrite and with what content. Pure — the
 * caller performs the IO. `currentContents` supplies existing file text so
 * free-form portions are preserved.
 */
export function planProjection(
  entries: MemoryEntry[],
  currentContents: Record<SupraSpaceMemoryFile, string>,
  now: number,
): ProjectionPlan {
  const byFile = new Map<SupraSpaceMemoryFile, MemoryEntry[]>();
  for (const f of PROJECTED_FILES) byFile.set(f, []);
  let projected = 0;
  for (const e of entries) {
    if (e.status !== "active") continue;
    const file = KIND_TO_FILE[e.kind];
    if (!PROJECTED_FILES.includes(file)) continue;
    byFile.get(file)!.push(e);
    projected++;
  }
  const writes = new Map<SupraSpaceMemoryFile, string>();
  for (const [file, list] of byFile) {
    const current = currentContents[file] ?? "";
    const next = composeFileContent(current, list, now);
    // Only schedule a write if content actually changed (idempotent).
    if (next !== current) writes.set(file, next);
  }
  return { writes, projectedEntries: projected };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** A candidate memory entry parsed from free-form SupraSpace notes. */
export interface IngestCandidate extends NewMemoryInput {
  /** Stable-ish fingerprint used for dedup against existing memory. */
  fingerprint: string;
}

/** Map a SupraSpace file to the most likely Cortex kind for its notes. */
const FILE_TO_KIND: Partial<Record<SupraSpaceMemoryFile, MemoryKind>> = {
  "decisions.md": "decision",
  "agent-notes.md": "task-outcome",
  "review-notes.md": "failure",
  "architecture.md": "fact",
};

/**
 * Parse free-form bullet/numbered items (outside the managed block) into
 * candidate memory. Only bullet lines with enough substance are considered.
 * Non-durable by default (task-outcome/failure) so they don't require evidence.
 */
export function ingestFromFiles(
  contents: Record<SupraSpaceMemoryFile, string>,
  ingestConfidence: number,
): IngestCandidate[] {
  const candidates: IngestCandidate[] = [];
  const seen = new Set<string>();
  for (const [file, raw] of Object.entries(contents) as Array<[SupraSpaceMemoryFile, string]>) {
    const kind = FILE_TO_KIND[file];
    if (!kind) continue;
    const freeform = stripManagedBlock(raw);
    for (const line of freeform.split("\n")) {
      const m = /^\s*(?:[-*+]|\d+\.)\s+(.*\S)\s*$/.exec(line);
      if (!m || !m[1]) continue;
      const text = m[1].replace(/\s+/g, " ").trim();
      if (text.length < 12) continue; // skip trivial bullets
      if (text.startsWith("_") || text.startsWith("<!--")) continue; // skip managed remnants/italics
      const fingerprint = normalizeFingerprint(text);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      candidates.push({
        kind,
        content: text,
        confidence: ingestConfidence,
        status: "candidate",
        tags: ["supraspace", file.replace(".md", "")],
        origin: `supraspace:${file}`,
        fingerprint,
      });
    }
  }
  return candidates;
}

export function normalizeFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** True if a candidate duplicates an existing memory entry's content. */
export function isDuplicate(candidate: IngestCandidate, existing: MemoryEntry[]): boolean {
  const fp = candidate.fingerprint;
  return existing.some((e) => normalizeFingerprint(e.content) === fp);
}
