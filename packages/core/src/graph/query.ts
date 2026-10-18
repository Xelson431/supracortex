import type { CodeGraph, CodeGraphEdge, CodeGraphNode, CodeGraphQueryLimits, CodeGraphSelector } from "../types.ts";
import { CODE_GRAPH_LIMITS } from "./schema.ts";

export interface CodeGraphQueryResult {
  generationId: string;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  truncated: boolean;
  /** Machine-readable bound that fired when truncated; absent when complete. */
  reason?: string;
}

function limits(input: CodeGraphQueryLimits = {}) {
  // Default to two hops: a one-hop default returned only the selected file and
  // its immediate children, which made a single-file query look truncated and
  // hid the caller's direct dependents. Explicit maxDepth still wins.
  const bounded = (value: number | undefined, fallback: number, max: number) => Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
  return { depth: bounded(input.maxDepth, 2, CODE_GRAPH_LIMITS.maxQueryDepth), results: bounded(input.maxResults, CODE_GRAPH_LIMITS.maxQueryResults, CODE_GRAPH_LIMITS.maxQueryResults), fanout: bounded(input.maxFanout, CODE_GRAPH_LIMITS.maxQueryFanout, CODE_GRAPH_LIMITS.maxQueryFanout) };
}

interface GraphIndex {
  nodeById: Map<string, CodeGraphNode>;
  undirected: Map<string, CodeGraphEdge[]>;
  outgoing: Map<string, CodeGraphEdge[]>;
  incoming: Map<string, CodeGraphEdge[]>;
}

/** Index nodes/edges by id once per query; adjacency lists pre-sorted. */
function indexGraph(graph: CodeGraph): GraphIndex {
  const nodeById = new Map<string, CodeGraphNode>();
  for (const node of graph.nodes) nodeById.set(node.id, node);
  const undirected = new Map<string, CodeGraphEdge[]>();
  const outgoing = new Map<string, CodeGraphEdge[]>();
  const incoming = new Map<string, CodeGraphEdge[]>();
  const push = (map: Map<string, CodeGraphEdge[]>, key: string, edge: CodeGraphEdge) => {
    let list = map.get(key);
    if (!list) { list = []; map.set(key, list); }
    list.push(edge);
  };
  for (const edge of graph.edges) {
    push(undirected, edge.from, edge);
    if (edge.to !== edge.from) push(undirected, edge.to, edge);
    push(outgoing, edge.from, edge);
    push(incoming, edge.to, edge);
  }
  for (const list of undirected.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  for (const list of outgoing.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  for (const list of incoming.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return { nodeById, undirected, outgoing, incoming };
}

function truncationReason(flags: Set<string>): string | undefined {
  if (!flags.size) return undefined;
  return `truncated: ${[...flags].sort().join("; ")}`;
}

export function resolveCodeGraphSelector(graph: CodeGraph, selector: CodeGraphSelector): CodeGraphNode {
  if (typeof selector !== "string") throw new Error("Graph selector must be a string");
  const separator = selector.indexOf(":");
  const kind = selector.slice(0, separator);
  const value = selector.slice(separator + 1);
  if (!value) throw new Error("Graph selector cannot be empty");
  const node = kind === "node" ? graph.nodes.find((candidate) => candidate.id === value)
    : kind === "path" ? graph.nodes.find((candidate) => candidate.path === value && candidate.kind === "file")
    : kind === "symbol" ? graph.nodes.find((candidate) => candidate.kind === "symbol" && candidate.path === value.split("#")[0] && candidate.symbol === value.split("#").slice(1).join("#"))
    : undefined;
  if (!node) throw new Error("Graph selector did not resolve to an exact node");
  return node;
}

export function graphNeighbors(graph: CodeGraph, selector: CodeGraphSelector, input: CodeGraphQueryLimits = {}): CodeGraphQueryResult {
  const root = resolveCodeGraphSelector(graph, selector);
  const l = limits(input);
  const idx = indexGraph(graph);
  const nodes = new Map([[root.id, root]]);
  const edges: CodeGraphEdge[] = [];
  const visited = new Set([root.id]);
  const flags = new Set<string>();
  let frontier = [root.id];
  for (let depth = 0; depth < l.depth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier.sort()) {
      const adjacent = idx.undirected.get(id) ?? [];
      if (adjacent.length > l.fanout) flags.add(`fanout limit ${l.fanout} hit at ${id}`);
      for (const edge of adjacent.slice(0, l.fanout)) {
        if (edges.length >= l.results) { flags.add(`result limit ${l.results} hit`); break; }
        edges.push(edge);
        const other = edge.from === id ? edge.to : edge.from;
        const node = idx.nodeById.get(other);
        if (node) nodes.set(node.id, node);
        if (!visited.has(other)) { visited.add(other); next.push(other); }
      }
      if (edges.length >= l.results) flags.add(`result limit ${l.results} hit`);
    }
    frontier = next;
  }
  if (frontier.length) flags.add(`depth limit ${l.depth} hit`);
  const hit = flags.size > 0;
  return { generationId: graph.generationId, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges, truncated: hit, reason: truncationReason(flags) };
}

export function graphExplain(graph: CodeGraph, selector: CodeGraphSelector): CodeGraphQueryResult {
  const node = resolveCodeGraphSelector(graph, selector);
  return { generationId: graph.generationId, nodes: [node], edges: [], truncated: false };
}

/** Shortest deterministic undirected path; graph relations remain directional in output. */
export function graphPath(graph: CodeGraph, fromSelector: CodeGraphSelector, toSelector: CodeGraphSelector, input: CodeGraphQueryLimits = {}): CodeGraphQueryResult {
  const from = resolveCodeGraphSelector(graph, fromSelector);
  const to = resolveCodeGraphSelector(graph, toSelector);
  if (from.id === to.id) return { generationId: graph.generationId, nodes: [from], edges: [], truncated: false };
  const l = limits(input);
  const idx = indexGraph(graph);
  const parent = new Map<string, { previous: string; edge: CodeGraphEdge }>();
  const queue: Array<{ id: string; depth: number }> = [{ id: from.id, depth: 0 }];
  const seen = new Set([from.id]);
  const flags = new Set<string>();
  while (queue.length) {
    const current = queue.shift() as { id: string; depth: number };
    if (current.depth >= l.depth) { flags.add(`depth limit ${l.depth} hit`); continue; }
    const adjacent = idx.undirected.get(current.id) ?? [];
    if (adjacent.length > l.fanout) flags.add(`fanout limit ${l.fanout} hit at ${current.id}`);
    for (const edge of adjacent.slice(0, l.fanout)) {
      const next = edge.from === current.id ? edge.to : edge.from;
      if (seen.has(next)) continue;
      parent.set(next, { previous: current.id, edge });
      if (parent.size > l.results) { flags.add(`result limit ${l.results} hit`); continue; }
      if (next === to.id) {
        const edges: CodeGraphEdge[] = [];
        const ids = new Set<string>([to.id]);
        let cursor = to.id;
        while (cursor !== from.id) {
          const step = parent.get(cursor) as { previous: string; edge: CodeGraphEdge };
          edges.push(step.edge); ids.add(step.previous); cursor = step.previous;
        }
        const nodes = [...ids].map((id) => idx.nodeById.get(id)).filter((n): n is CodeGraphNode => !!n).sort((a, b) => a.id.localeCompare(b.id));
        return { generationId: graph.generationId, nodes, edges: edges.reverse(), truncated: flags.size > 0, reason: truncationReason(flags) };
      }
      seen.add(next); queue.push({ id: next, depth: current.depth + 1 });
    }
  }
  return { generationId: graph.generationId, nodes: [from], edges: [], truncated: flags.size > 0, reason: truncationReason(flags) };
}

/** Directed impact traversal. `outgoing` answers dependencies; `incoming` answers dependents. */
export function graphImpact(graph: CodeGraph, selector: CodeGraphSelector, direction: "incoming" | "outgoing", input: CodeGraphQueryLimits = {}): CodeGraphQueryResult {
  const root = resolveCodeGraphSelector(graph, selector);
  const l = limits(input);
  const idx = indexGraph(graph);
  const nodes = new Map([[root.id, root]]);
  const edges: CodeGraphEdge[] = [];
  const seen = new Set([root.id]);
  const flags = new Set<string>();
  let frontier = [root.id];
  for (let depth = 0; depth < l.depth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier.sort()) {
      const candidates = (direction === "outgoing" ? idx.outgoing.get(id) : idx.incoming.get(id)) ?? [];
      if (candidates.length > l.fanout) flags.add(`fanout limit ${l.fanout} hit at ${id}`);
      for (const edge of candidates.slice(0, l.fanout)) {
        if (edges.length >= l.results) { flags.add(`result limit ${l.results} hit`); break; }
        edges.push(edge);
        const other = direction === "outgoing" ? edge.to : edge.from;
        const node = idx.nodeById.get(other);
        if (node) nodes.set(node.id, node);
        if (!seen.has(other)) { seen.add(other); next.push(other); }
      }
      if (edges.length >= l.results) flags.add(`result limit ${l.results} hit`);
    }
    frontier = next;
  }
  if (frontier.length) flags.add(`depth limit ${l.depth} hit`);
  const hit = flags.size > 0;
  return { generationId: graph.generationId, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), edges, truncated: hit, reason: truncationReason(flags) };
}
