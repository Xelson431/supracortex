/**
 * Obsidian-compatible, read-only projection of the SupraCortex snapshot.
 * JSONL/SQLite remains authoritative; these Markdown notes are regenerated
 * whenever an export runs so visualizers never need to infer memory state.
 */
import type { CodeGraph, CortexSnapshot, CortexVaultManifest, MemoryEntry } from "../types.ts";
import { redactSecrets } from "../memory/validation.ts";

const MAX_CODE_FILE_NOTES = 500;

const KIND_DIR: Record<MemoryEntry["kind"], string> = {
  fact: "Facts", decision: "Decisions", convention: "Conventions",
  failure: "Failures", constraint: "Constraints", "task-outcome": "Outcomes",
};
const KNOWN_ENTRY_KINDS: ReadonlySet<string> = new Set(Object.keys(KIND_DIR));
// Truthful trust mapping: every legal MemoryStatus projects as-is (never active).
// Legacy "retracted" maps to terminal "forgotten". Unknown statuses fail closed
// to "forgotten" — never "active" — so untrusted memory is never shown as trusted.
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "active", "superseded", "stale", "disputed", "candidate", "forgotten",
]);
// Evidence allowlist mirrors SourceReferenceKind: file/commit/command/external/session.
// Legacy "url"/"note" kinds are dropped (counted + warned, never silent).
const KNOWN_REF_KINDS: ReadonlySet<string> = new Set([
  "file", "commit", "command", "external", "session",
]);

/**
 * Allowlist projection of a memory entry. Only known, render-safe fields are
 * carried forward; any unknown/extra fields on the input (e.g. `secret`,
 * `apiKey`) are excluded by default so the vault can never leak them.
 * Content and reference values are defensively redacted (fail-closed) even if
 * the caller passed an unredacted snapshot.
 */
function sanitizeEntry(raw: unknown): MemoryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.kind !== "string" || !KNOWN_ENTRY_KINDS.has(r.kind)) return null;
  if (typeof r.content !== "string") return null;
  const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const refs = Array.isArray(r.sourceReferences) ? r.sourceReferences : [];
  return {
    id: r.id,
    kind: r.kind as MemoryEntry["kind"],
    // Fail-closed: redact on doubt, at render time, regardless of upstream.
    content: redactSecrets(r.content).text,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
    status: (r.status === "retracted"
      // Legacy alias with no MemoryStatus slot; nearest terminal state is forgotten.
      ? "forgotten"
      : KNOWN_STATUSES.has(r.status as string) ? r.status : "forgotten") as MemoryEntry["status"],
    sourceReferences: (() => {
      const kept: MemoryEntry["sourceReferences"] = [];
      let dropped = 0;
      for (const x of refs) {
        if (typeof x !== "object" || x === null) { dropped++; continue; }
        if (!KNOWN_REF_KINDS.has((x as Record<string, unknown>).kind as string)) { dropped++; continue; }
        const rx = x as Record<string, unknown>;
        kept.push({
          kind: rx.kind as MemoryEntry["sourceReferences"][number]["kind"],
          value: typeof rx.value === "string" ? redactSecrets(rx.value).text : "",
          ...(Array.isArray(rx.lines) && rx.lines.length === 2 ? { lines: [rx.lines[0], rx.lines[1]] as [number, number] } : {}),
          ...(typeof rx.hash === "string" ? { hash: rx.hash } : {}),
          ...(typeof rx.note === "string" ? { note: redactSecrets(rx.note).text } : {}),
        });
      }
      if (dropped > 0) console.warn(`[vault] dropped ${dropped} unknown sourceReference(s) for entry ${r.id}`);
      return kept;
    })(),
    relatedFiles: strArray(r.relatedFiles),
    relatedSymbols: strArray(r.relatedSymbols),
    tags: strArray(r.tags),
    invalidationRules: [],
  };
}

function clean(value: string): string { return value.replace(/[\\/:*?"<>|]/g, "_"); }
function yaml(value: unknown): string { return JSON.stringify(value); }
function title(entry: MemoryEntry): string {
  const compact = entry.content.replace(/\s+/g, " ").trim();
  return compact.length > 88 ? `${compact.slice(0, 87)}…` : compact || entry.id;
}

function note(entry: MemoryEntry): string {
  const refs = entry.sourceReferences.map((r) => `- ${r.kind}: ${r.value}${r.lines ? `:${r.lines[0]}-${r.lines[1]}` : ""}`).join("\n") || "- none";
  const files = entry.relatedFiles.map((file) => `- [[Files/${clean(file)}]]`).join("\n") || "- none";
  return [
    "---", `id: ${yaml(entry.id)}`, `kind: ${yaml(entry.kind)}`, `status: ${yaml(entry.status)}`,
    `confidence: ${entry.confidence}`, `createdAt: ${yaml(entry.createdAt)}`, `updatedAt: ${yaml(entry.updatedAt)}`,
    `tags: ${yaml(entry.tags)}`, `relatedFiles: ${yaml(entry.relatedFiles)}`, "generatedBy: supracortex", "---", "",
    `# ${title(entry)}`, "", entry.content, "", "## Evidence", refs, "", "## Related files", files, "",
  ].join("\n");
}

function codeFileNote(graph: CodeGraph, fileId: string): string | null {
  const file = graph.nodes.find((node) => node.id === fileId && node.kind === "file");
  if (!file?.path) return null;
  const symbols = graph.edges
    .filter((edge) => edge.kind === "defines" && edge.from === file.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.to)?.symbol)
    .filter((symbol): symbol is string => typeof symbol === "string")
    .sort();
  const imports = graph.edges
    .filter((edge) => edge.kind === "imports" && edge.from === file.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.to)?.path)
    .filter((path): path is string => typeof path === "string")
    .sort();
  return [
    "---", `id: ${yaml(file.id)}`, "kind: code-file", `path: ${yaml(file.path)}`,
    `language: ${yaml(file.language ?? "unknown")}`, `sourceHash: ${yaml(file.sourceHash ?? "")}`,
    "generatedBy: supracortex", "---", "", `# ${file.path}`, "",
    "## Symbols", ...(symbols.length ? symbols.map((symbol) => `- ${symbol}`) : ["- none extracted"]), "",
    "## Resolved local imports", ...(imports.length ? imports.map((path) => `- ${path}`) : ["- none extracted"]), "",
    "This is derived, deterministic repository metadata—not source content or instructions.", "",
  ].join("\n");
}

/** Build every vault file from one snapshot. Pure and deterministic. */
export function buildVaultProjection(snapshot: CortexSnapshot): { files: Map<string, string>; manifest: CortexVaultManifest } {
  const files = new Map<string, string>();
  const manifestFiles: CortexVaultManifest["files"] = [];
  const byKind = new Map<MemoryEntry["kind"], MemoryEntry[]>();
  // Allowlist gate: unknown/extra fields excluded, redacted content enforced.
  // Malformed entries are skipped, never rendered raw.
  const entries: MemoryEntry[] = [];
  for (const raw of snapshot.memory) {
    const clean_entry = sanitizeEntry(raw);
    if (clean_entry) entries.push(clean_entry);
  }
  for (const entry of entries) {
    const list = byKind.get(entry.kind) ?? [];
    list.push(entry); byKind.set(entry.kind, list);
    const path = `Memory/${KIND_DIR[entry.kind]}/${clean(entry.id)}.md`;
    files.set(path, note(entry));
    manifestFiles.push({ path, entityId: entry.id, kind: entry.kind });
  }
  const home = [
    "---", "generatedBy: supracortex", `generatedAt: ${yaml(snapshot.generatedAt)}`, "---", "",
    "# SupraCortex Vault", "", "This vault is generated from `.supracortex/snapshot.json`. Edit memory through SupraCortex or SupraSpace, not these notes.", "",
    "## Memory", ...[...byKind.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, entries]) => `- [[Memory/${KIND_DIR[kind]}/Index|${KIND_DIR[kind]}]] (${entries.length})`), "",
    `## Active tasks\n${snapshot.activeTasks.length}`,
    ...(snapshot.codeGraph ? ["", "## Code graph", "- [[Code/Index|Derived file & symbol graph]]"] : []),
    "",
  ].join("\n");
  files.set("Home.md", home); manifestFiles.push({ path: "Home.md", kind: "index" });
  for (const [kind, entries] of byKind) {
    const path = `Memory/${KIND_DIR[kind]}/Index.md`;
    const body = ["---", "generatedBy: supracortex", `kind: ${yaml(kind)}`, "---", "", `# ${KIND_DIR[kind]}`, "",
      ...entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((entry) => `- [[${clean(entry.id)}|${title(entry)}]] — ${entry.status} (${entry.confidence})`), ""].join("\n");
    files.set(path, body); manifestFiles.push({ path, kind: "index" });
  }
  for (const task of snapshot.activeTasks) {
    const path = `Tasks/Active/${clean(task.taskId)}.md`;
    files.set(path, ["---", `id: ${yaml(task.taskId)}`, "kind: task", "status: active", "generatedBy: supracortex", "---", "", `# ${task.title ?? task.taskId}`, "", `Started: ${task.startedAt}`, `Last seen: ${task.lastSeenAt}`, ""].join("\n"));
    manifestFiles.push({ path, entityId: task.taskId, kind: "task" });
  }
  if (snapshot.codeGraph) {
    const graph = snapshot.codeGraph;
    const fileNodes = graph.nodes.filter((node) => node.kind === "file").sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));
    const rendered = fileNodes.slice(0, MAX_CODE_FILE_NOTES);
    const index = [
      "---", "kind: code-graph", `generationId: ${yaml(graph.generationId)}`,
      `sourceWatermark: ${yaml(graph.sourceWatermark)}`, `generatedAt: ${yaml(graph.generatedAt)}`,
      "generatedBy: supracortex", "---", "", "# Derived Code Graph", "",
      "This section is a bounded, derived read model. It contains no source bodies and is not durable memory.", "",
      `- Indexed files: ${graph.accounting.indexedFiles}`,
      `- Nodes: ${graph.accounting.nodes}`,
      `- Edges: ${graph.accounting.edges}`,
      `- Unresolved imports: ${graph.accounting.unresolvedImports}`,
      `- Vault file notes: ${rendered.length}${fileNodes.length > rendered.length ? ` of ${fileNodes.length} (bounded)` : ""}`,
      "", "## Files",
      ...rendered.map((file) => `- [[Files/${file.id}|${file.path ?? file.label}]]`), "",
    ].join("\n");
    files.set("Code/Index.md", index);
    manifestFiles.push({ path: "Code/Index.md", kind: "code-graph-index" });
    for (const file of rendered) {
      const body = codeFileNote(graph, file.id);
      if (!body) continue;
      const path = `Code/Files/${file.id}.md`;
      files.set(path, body);
      manifestFiles.push({ path, entityId: file.id, kind: "code-file" });
    }
  }
  return { files, manifest: { schemaVersion: 1, generatedAt: snapshot.generatedAt, snapshotGeneratedAt: snapshot.generatedAt, files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)) } };
}
