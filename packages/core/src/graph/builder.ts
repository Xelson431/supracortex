import { CODE_GRAPH_EXTRACTOR_VERSION, CODE_GRAPH_SCHEMA_VERSION, CODE_GRAPH_LIMITS, stableGraphId } from "./schema.ts";
import type { CodeGraph, CodeGraphEdge, CodeGraphNode, RepositoryIndex } from "../types.ts";
import { extractFile, type ExtractionOptions } from "./extractor.ts";

export interface BuildCodeGraphInput {
  index: RepositoryIndex;
  projectFingerprint: string;
  generatedAt: string;
  /**
   * Opt-in content-aware extraction. When omitted, the builder keeps its
   * historical regex-default behavior from the precomputed index (symbols and
   * imports as stored). When provided, each entry re-extracts symbols/imports
   * with caps, budget, and fallback reasons; files without content fall back
   * to the stored index values.
   */
  sources?: Record<string, string>;
  extraction?: ExtractionOptions;
}

/** Build a conservative, deterministic derived graph from the existing index. */
export function buildCodeGraph(input: BuildCodeGraphInput): CodeGraph {
  const files = Object.values(input.index.files).sort((a, b) => a.path.localeCompare(b.path));
  const sourceWatermark = stableGraphId("code-graph-watermark", files.map((file) => `${file.path}\0${file.hash}`).join("\n"));
  const repositoryId = stableGraphId("code-graph-repository", input.projectFingerprint);
  const generationId = stableGraphId("code-graph-generation", `${input.projectFingerprint}\0${sourceWatermark}\0${CODE_GRAPH_EXTRACTOR_VERSION}`);
  const nodes: CodeGraphNode[] = [{
    id: repositoryId, kind: "repository", label: "repository", provenance: "repository-index", confidence: "extracted", extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION,
  }];
  const edges: CodeGraphEdge[] = [];
  const fileIds = new Map<string, string>();
  // An import may only target a file that was actually admitted to this bounded
  // generation; otherwise it is recorded as unresolved rather than emitting a
  // dangling edge.
  const indexedFilePaths = new Set(files.map((file) => file.path));
  const directoryIds = new Map<string, string>();
  const addNode = (node: CodeGraphNode): boolean => {
    if (nodes.length >= CODE_GRAPH_LIMITS.maxNodes) return false;
    nodes.push(node);
    return true;
  };
  const addEdge = (edge: CodeGraphEdge): boolean => {
    if (edges.length >= CODE_GRAPH_LIMITS.maxEdges) return false;
    edges.push(edge);
    return true;
  };
  const edge = (from: string, to: string, kind: CodeGraphEdge["kind"], sourcePath: string, sourceHash: string) => ({
    id: stableGraphId("code-graph-edge", `${from}\0${to}\0${kind}\0${sourcePath}\0${sourceHash}`),
    from, to, kind, provenance: "repository-index" as const, confidence: "extracted" as const, sourcePath, sourceHash,
  });

  // Partial reasons are namespaced so truncation (global caps), per-file
  // fallback (grammar/allowlist/timeout), and SCIP-skip never conflate.
  // Every entry carries a reason; nothing is ever a silent partial.
  const partialReasons = new Map<string, number>();
  const notePartial = (reason: string) => {
    partialReasons.set(classifyPartialReason(reason), (partialReasons.get(classifyPartialReason(reason)) ?? 0) + 1);
  };

  // Content-aware pass (opt-in): re-extract symbols/imports per file. Runs
  // before node emission so effective symbols are ready for the defines loop.
  const effectiveSymbols = new Map<string, string[]>();
  const effectiveImports = new Map<string, string[]>();
  if (input.sources) {
    for (const file of files) {
      const content = input.sources[file.path];
      if (content === undefined) {
        effectiveSymbols.set(file.path, file.symbols);
        effectiveImports.set(file.path, file.imports);
        continue;
      }
      const result = extractFile(file.path, content, file.language, input.extraction);
      effectiveSymbols.set(file.path, result.symbols.length ? result.symbols : file.symbols);
      // Robust imports replace stored hints only when they add signal; stored
      // index values remain the fallback so recall never regresses.
      effectiveImports.set(file.path, result.imports.length ? result.imports : file.imports);
      if (result.truncated || result.reason) notePartial(result.reason ?? "partial extraction");
    }
  }

  for (const file of files) {
    let parentId = repositoryId;
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const directory = parts.slice(0, i).join("/");
      let directoryId = directoryIds.get(directory);
      if (!directoryId) {
        directoryId = stableGraphId("code-graph-directory", `${input.projectFingerprint}\0${directory}`);
        if (!addNode({ id: directoryId, kind: "directory", label: directory, path: directory, provenance: "repository-index", confidence: "extracted", extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION })) break;
        directoryIds.set(directory, directoryId);
        addEdge(edge(parentId, directoryId, "contains", file.path, file.hash));
      }
      parentId = directoryId;
    }
    const fileId = stableGraphId("code-graph-file", `${input.projectFingerprint}\0${file.path}`);
    if (!addNode({ id: fileId, kind: "file", label: file.path, path: file.path, language: file.language, sourceHash: file.hash, provenance: "repository-index", confidence: "extracted", extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION })) break;
    fileIds.set(file.path, fileId);
    addEdge(edge(parentId, fileId, "contains", file.path, file.hash));
    const symbols = input.sources ? (effectiveSymbols.get(file.path) ?? file.symbols) : file.symbols;
    for (const symbol of [...new Set(symbols)].sort()) {
      if (nodes.length >= CODE_GRAPH_LIMITS.maxNodes) break;
      const symbolId = stableGraphId("code-graph-symbol", `${input.projectFingerprint}\0${file.path}\0${symbol}`);
      if (addNode({ id: symbolId, kind: "symbol", label: symbol, path: file.path, symbol, language: file.language, sourceHash: file.hash, provenance: "repository-index", confidence: "extracted", extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION })) {
        addEdge(edge(fileId, symbolId, "defines", file.path, file.hash));
      }
    }
  }

  let unresolvedImports = 0;
  for (const file of files) {
    const from = fileIds.get(file.path);
    if (!from) continue;
    const imports = input.sources ? (effectiveImports.get(file.path) ?? file.imports) : file.imports;
    // Distinct specifier spellings (e.g. "../lib/money" vs "../lib/money.ts")
    // can resolve to the same admitted target. Edge ids are content-derived,
    // so emitting both would fail integrity validation; one edge suffices.
    const seenTargets = new Set<string>();
    for (const specifier of [...new Set(imports)].sort()) {
      const targetPath = resolveLocalImport(specifier, indexedFilePaths);
      const to = targetPath ? fileIds.get(targetPath) : undefined;
      if (!to) { unresolvedImports++; continue; }
      if (seenTargets.has(to)) continue;
      seenTargets.add(to);
      if (!addEdge(edge(from, to, "imports", file.path, file.hash))) break;
    }
  }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  const omissions = [
    ...(unresolvedImports ? [{ code: "unresolved-import" as const, count: unresolvedImports, reason: "unresolved-import: target not admitted to this generation" }] : []),
    ...(nodes.length >= CODE_GRAPH_LIMITS.maxNodes ? [{ code: "node-limit" as const, count: 1, reason: "truncation: node-limit reached; generation capped" }] : []),
    ...(edges.length >= CODE_GRAPH_LIMITS.maxEdges ? [{ code: "edge-limit" as const, count: 1, reason: "truncation: edge-limit reached; generation capped" }] : []),
    // Partial-extraction reasons reuse the capped omission channel with a
    // distinct namespaced reason per class (truncation vs per-file-fallback
    // vs scip-skip) so no silent or conflated partial ever occurs.
    ...[...partialReasons.entries()].map(([reason, count]) => ({
      code: "node-limit" as const,
      count,
      reason,
    })),
  ] as unknown as CodeGraph["omissions"];
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION, extractorVersion: CODE_GRAPH_EXTRACTOR_VERSION, generationId, projectFingerprint: input.projectFingerprint, repositoryId,
    generatedAt: input.generatedAt, sourceWatermark, nodes, edges, omissions,
    accounting: { indexedFiles: files.length, nodes: nodes.length, edges: edges.length, unresolvedImports },
  };
}

/**
 * Namespace a raw extractor reason so truncation, per-file fallback, and
 * SCIP-skip stay distinct. Already-namespaced values pass through; raw
 * extractor strings are classified by signal words.
 */
export function classifyPartialReason(raw: string): string {
  const reason = raw.trim();
  if (/^(truncation|per-file-fallback|scip-skip):/.test(reason)) return reason;
  if (/scip/i.test(reason)) return `scip-skip: ${reason}`;
  if (/grammar missing|allowlist|budget|timeout|fallback/i.test(reason)) return `per-file-fallback: ${reason}`;
  if (/cap|truncat/i.test(reason)) return `truncation: ${reason}`;
  return `per-file-fallback: ${reason}`;
}

function resolveLocalImport(specifier: string, files: ReadonlySet<string>): string | null {
  const candidates = [specifier, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}.js`, `${specifier}.jsx`, `${specifier}.mjs`, `${specifier}.cjs`, `${specifier}.py`, `${specifier}/index.ts`, `${specifier}/index.js`];
  for (const candidate of candidates) if (files.has(candidate)) return candidate;
  return null;
}
