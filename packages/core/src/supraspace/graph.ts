/**
 * Graph export: turn Cortex's structured state (memory + active tasks + file
 * ownership) into a typed nodes/edges graph that external visualizers — notably
 * the SupraSpace "galaxy" force-graph — can render directly.
 *
 * Structure: root → memory-kind grouping → entity nodes; plus task nodes and
 * file nodes with ownership/touch edges. Pure and deterministic.
 */

import type {
  ActiveTaskRecord,
  FileOwnership,
  GraphEdge,
  GraphExport,
  GraphNode,
  MemoryEntry,
  MemoryKind,
} from "../types.ts";

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: "Facts",
  decision: "Decisions",
  convention: "Conventions",
  failure: "Failures",
  constraint: "Constraints",
  "task-outcome": "Task Outcomes",
};

const MAX_LABEL = 64;

function trim(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
}

export interface GraphExportInput {
  memory: MemoryEntry[];
  activeTasks?: ActiveTaskRecord[];
  ownership?: FileOwnership | null;
  now?: number;
  /** Cap nodes to keep the visualizer responsive. */
  maxMemoryNodes?: number;
}

export function buildGraphExport(input: GraphExportInput): GraphExport {
  const now = input.now ?? Date.now();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let edgeSeq = 0;
  const edge = (source: string, target: string, relation?: string) => {
    const e: GraphEdge = { id: `e${edgeSeq++}`, source, target };
    if (relation) e.relation = relation;
    edges.push(e);
  };

  const rootId = "root";
  nodes.push({ id: rootId, label: "Project Intelligence", kind: "root", depth: 0 });

  // --- Memory grouped by kind ---
  const active = input.memory.filter((e) => e.status !== "superseded");
  const maxNodes = input.maxMemoryNodes ?? 500;
  const byKind = new Map<MemoryKind, MemoryEntry[]>();
  for (const e of active) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }

  let emitted = 0;
  const idById = new Map<string, string>(); // memory entry id -> graph node id
  for (const [kind, list] of byKind) {
    if (!list.length) continue;
    const groupId = `kind:${kind}`;
    nodes.push({
      id: groupId,
      label: `${KIND_LABEL[kind]} (${list.length})`,
      kind: "memory-kind",
      depth: 1,
    });
    edge(rootId, groupId);
    for (const e of list.sort((a, b) => b.confidence - a.confidence)) {
      if (emitted >= maxNodes) break;
      const nodeId = `mem:${e.id}`;
      idById.set(e.id, nodeId);
      nodes.push({
        id: nodeId,
        label: trim(e.content),
        kind: e.kind,
        depth: 2,
        weight: clamp01(e.confidence),
        status: e.status,
        meta: { tags: e.tags.slice(0, 5).join(",") },
      });
      edge(groupId, nodeId);
      // Link memory entries to the files they reference.
      for (const ref of e.relatedFiles.slice(0, 5)) {
        const fileId = ensureFileNode(nodes, ref);
        if (fileId) edge(nodeId, fileId, "references");
      }
      emitted++;
    }
  }

  // supersedes edges (entity -> entity).
  for (const e of active) {
    if (!e.supersedes) continue;
    const from = idById.get(e.id);
    if (!from) continue;
    for (const supId of e.supersedes) {
      const to = idById.get(supId);
      if (to) edge(from, to, "supersedes");
    }
  }

  // --- Active tasks + ownership ---
  const tasks = input.activeTasks ?? [];
  for (const t of tasks) {
    const taskId = `task:${t.taskId}`;
    nodes.push({
      id: taskId,
      label: trim(t.title ?? t.taskId),
      kind: "task",
      depth: 1,
      status: "active",
      meta: { startedAt: t.startedAt },
    });
    edge(rootId, taskId);
  }

  const ownership = input.ownership;
  let ownedFiles = 0;
  if (ownership) {
    for (const [path, claim] of Object.entries(ownership.claims)) {
      const fileId = ensureFileNode(nodes, path);
      const taskId = `task:${claim.taskId}`;
      // Only connect if the owning task node exists; otherwise add a light node.
      if (!nodes.some((n) => n.id === taskId)) {
        nodes.push({ id: taskId, label: trim(claim.taskId), kind: "task", depth: 1 });
        edge(rootId, taskId);
      }
      if (fileId) {
        edge(taskId, fileId, "owns");
        ownedFiles++;
      }
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    nodes,
    edges,
    stats: {
      memoryEntries: active.length,
      activeTasks: tasks.length,
      ownedFiles,
    },
  };

  function ensureFileNode(all: GraphNode[], path: string): string | null {
    if (!path) return null;
    const id = `file:${path}`;
    if (!all.some((n) => n.id === id)) {
      all.push({ id, label: trim(path), kind: "file", depth: 3 });
    }
    return id;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
