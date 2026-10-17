import { createHash } from "node:crypto";
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from "../../../../src/version.ts";
import type {
  CodeGraph,
  CodeGraphEdge,
  CodeGraphManifest,
  CodeGraphNode,
} from "../types.ts";

export { CODE_GRAPH_EXTRACTOR_VERSION, CODE_GRAPH_SCHEMA_VERSION };

export const CODE_GRAPH_LIMITS = {
  maxNodes: 50_000,
  maxEdges: 200_000,
  maxPathLength: 500,
  maxLabelLength: 300,
  maxSymbolLength: 200,
  maxQueryResults: 50,
  maxQueryDepth: 5,
  maxQueryFanout: 200,
} as const;

export class CodeGraphIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeGraphIntegrityError";
  }
}

export function stableGraphId(domain: string, value: string): string {
  return createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex");
}

export function isProjectRelativePath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 && value.length <= CODE_GRAPH_LIMITS.maxPathLength &&
    !value.startsWith("/") && !value.startsWith("\\") &&
    !value.split("/").includes("..") && !value.includes("\0");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNode(value: unknown): value is CodeGraphNode {
  if (!isRecord(value)) return false;
  if (!isDigest(value.id) || !["repository", "directory", "file", "symbol"].includes(String(value.kind))) return false;
  if (typeof value.label !== "string" || value.label.length > CODE_GRAPH_LIMITS.maxLabelLength) return false;
  if (value.path !== undefined && !isProjectRelativePath(value.path)) return false;
  if (value.symbol !== undefined && (typeof value.symbol !== "string" || value.symbol.length > CODE_GRAPH_LIMITS.maxSymbolLength)) return false;
  if (value.language !== undefined && (typeof value.language !== "string" || value.language.length > 64)) return false;
  return isDigest(value.sourceHash ?? stableGraphId("empty", "source")) &&
    value.provenance === "repository-index" && value.confidence === "extracted" &&
    value.extractorVersion === CODE_GRAPH_EXTRACTOR_VERSION;
}

function isEdge(value: unknown, nodeIds: Set<string>): value is CodeGraphEdge {
  if (!isRecord(value)) return false;
  return isDigest(value.id) && typeof value.from === "string" && nodeIds.has(value.from) &&
    typeof value.to === "string" && nodeIds.has(value.to) &&
    ["contains", "defines", "imports"].includes(String(value.kind)) &&
    value.provenance === "repository-index" && value.confidence === "extracted" &&
    isProjectRelativePath(value.sourcePath) && isDigest(value.sourceHash);
}

export function decodeCodeGraph(value: unknown): CodeGraph {
  if (!isRecord(value)) throw new CodeGraphIntegrityError("Graph must be an object");
  if (value.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION || value.extractorVersion !== CODE_GRAPH_EXTRACTOR_VERSION) {
    throw new CodeGraphIntegrityError("Unsupported graph schema or extractor version");
  }
  if (!isDigest(value.generationId) || !isDigest(value.projectFingerprint) || !isDigest(value.repositoryId) || !isDigest(value.sourceWatermark)) {
    throw new CodeGraphIntegrityError("Graph identifiers are invalid");
  }
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) throw new CodeGraphIntegrityError("Graph timestamp is invalid");
  if (!Array.isArray(value.nodes) || value.nodes.length > CODE_GRAPH_LIMITS.maxNodes) throw new CodeGraphIntegrityError("Graph node limit exceeded");
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!isNode(node) || nodeIds.has(node.id)) throw new CodeGraphIntegrityError("Graph node is invalid or duplicated");
    nodeIds.add(node.id);
  }
  if (!Array.isArray(value.edges) || value.edges.length > CODE_GRAPH_LIMITS.maxEdges) throw new CodeGraphIntegrityError("Graph edge limit exceeded");
  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (!isEdge(edge, nodeIds) || edgeIds.has(edge.id)) throw new CodeGraphIntegrityError("Graph edge is invalid or duplicated");
    edgeIds.add(edge.id);
  }
  if (!Array.isArray(value.omissions) || value.omissions.some((omission) => !isRecord(omission) || !["unresolved-import", "node-limit", "edge-limit"].includes(String(omission.code)) || !Number.isSafeInteger(omission.count) || (omission.count as number) < 1) || !isRecord(value.accounting)) {
    throw new CodeGraphIntegrityError("Graph accounting is invalid");
  }
  const accounting = value.accounting;
  if (!["indexedFiles", "nodes", "edges", "unresolvedImports"].every((key) => Number.isSafeInteger(accounting[key]) && (accounting[key] as number) >= 0)) {
    throw new CodeGraphIntegrityError("Graph accounting values are invalid");
  }
  if (accounting.nodes !== value.nodes.length || accounting.edges !== value.edges.length) throw new CodeGraphIntegrityError("Graph accounting does not match content");
  return value as unknown as CodeGraph;
}

export function decodeCodeGraphManifest(value: unknown): CodeGraphManifest {
  if (!isRecord(value) || value.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION || !isDigest(value.generationId) || !isDigest(value.sourceWatermark) ||
    !Number.isSafeInteger(value.nodeCount) || (value.nodeCount as number) < 0 || !Number.isSafeInteger(value.edgeCount) || (value.edgeCount as number) < 0 ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new CodeGraphIntegrityError("Graph manifest is invalid");
  }
  return value as unknown as CodeGraphManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
