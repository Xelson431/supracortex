/**
 * Preview-first importers (Phase 4). Pure parsers that turn third-party context
 * files into candidate memory inputs. They are path-confined, size-bounded, and
 * NEVER produce active memory: the caller records results as `candidate` status
 * for explicit human review. Redaction is applied downstream by the record path.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, relative } from "node:path";
import type { NewMemoryInput } from "../memory/schemas.ts";
import type { MemoryKind } from "../types.ts";

export type ImportSource = "agents-md" | "claude-md" | "cline" | "serena" | "json" | "jsonl";

export interface ImportResult {
  candidates: NewMemoryInput[];
  skipped: string[];
}

const MAX_BYTES = 2_000_000;
const MAX_CANDIDATES = 300;

/** Resolve + confine a path to the project root. Returns null if it escapes. */
function confine(projectRoot: string, path: string): string | null {
  const abs = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  const rel = relative(resolve(projectRoot), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

function classifyKind(heading: string): MemoryKind {
  const h = heading.toLowerCase();
  if (/decision|adr|chose|choice/.test(h)) return "decision";
  if (/convention|style|standard|rule|guideline/.test(h)) return "convention";
  if (/constraint|must|require|limit/.test(h)) return "constraint";
  if (/fail|bug|gotcha|pitfall|avoid/.test(h)) return "failure";
  return "fact";
}

/** Parse a markdown doc into candidate inputs by heading + substantive lines. */
export function parseMarkdown(text: string, origin: string): NewMemoryInput[] {
  const out: NewMemoryInput[] = [];
  const lines = text.split("\n");
  let kind: MemoryKind = "fact";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) { kind = classifyKind(heading[1] ?? ""); continue; }
    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    const content = (bullet ? (bullet[1] ?? "") : line).trim();
    // Only substantive lines (skip code fences, tables, short fragments).
    if (content.length < 12 || content.startsWith("```") || content.startsWith("|")) continue;
    out.push({ kind, content, confidence: 0.6, tags: ["imported"], origin, status: "candidate" });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** Parse JSON (array) or JSONL of { kind?, content } records into candidates. */
export function parseJsonRecords(text: string, origin: string, jsonl: boolean): NewMemoryInput[] {
  const out: NewMemoryInput[] = [];
  const push = (rec: unknown) => {
    if (out.length >= MAX_CANDIDATES) return;
    if (!rec || typeof rec !== "object") return;
    const r = rec as { kind?: unknown; content?: unknown; tags?: unknown };
    if (typeof r.content !== "string" || !r.content.trim()) return;
    const kind = typeof r.kind === "string" && ["fact", "decision", "convention", "failure", "constraint", "task-outcome"].includes(r.kind)
      ? (r.kind as MemoryKind)
      : "fact";
    const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string").slice(0, 20) : [];
    out.push({ kind, content: r.content.trim(), confidence: 0.6, tags: [...tags, "imported"], origin, status: "candidate" });
  };
  if (jsonl) {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { push(JSON.parse(t)); } catch { /* skip bad line */ }
    }
  } else {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) for (const rec of parsed) push(rec);
      else push(parsed);
    } catch { /* skip bad file */ }
  }
  return out;
}

export async function readImportSource(
  source: string,
  path: string,
  projectRoot: string,
): Promise<ImportResult> {
  const abs = confine(projectRoot, path);
  if (!abs) return { candidates: [], skipped: ["path escapes project root"] };
  let size: number;
  try { size = (await stat(abs)).size; } catch { return { candidates: [], skipped: ["file not found"] }; }
  if (size > MAX_BYTES) return { candidates: [], skipped: [`file exceeds ${MAX_BYTES} bytes`] };
  let text: string;
  try { text = await readFile(abs, "utf8"); } catch { return { candidates: [], skipped: ["read failed"] }; }
  const origin = `import:${source}`;
  switch (source as ImportSource) {
    case "agents-md":
    case "claude-md":
    case "cline":
    case "serena":
      return { candidates: parseMarkdown(text, origin), skipped: [] };
    case "json":
      return { candidates: parseJsonRecords(text, origin, false), skipped: [] };
    case "jsonl":
      return { candidates: parseJsonRecords(text, origin, true), skipped: [] };
    default:
      return { candidates: [], skipped: [`unknown source: ${source}`] };
  }
}
