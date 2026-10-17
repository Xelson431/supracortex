import type { StorageAdapter } from "../storage/storage-adapter.ts";
import type { CodeGraph, CodeGraphManifest } from "../types.ts";
import { CODE_GRAPH_SCHEMA_VERSION, decodeCodeGraph, decodeCodeGraphManifest, CodeGraphIntegrityError } from "./schema.ts";

const MANIFEST_PATH = "graph/manifest.json";
const generationPath = (generationId: string) => `graph/generations/${generationId}.json`;

/**
 * Atomic activation for both supported storage adapters: write and validate an
 * immutable generation first, then atomically replace the small manifest.
 */
export class CodeGraphStore {
  private readonly store: StorageAdapter;

  constructor(store: StorageAdapter) {
    this.store = store;
  }

  async activate(graph: CodeGraph): Promise<CodeGraphManifest> {
    const decoded = decodeCodeGraph(graph);
    const release = await this.store.acquireLock("code-graph", { timeoutMs: 5_000 });
    try {
      await this.store.ensureDir("graph/generations");
      const previous = await this.readManifestUnsafe();
      const graphPath = generationPath(decoded.generationId);
      const existing = await this.store.readJson<unknown>(graphPath);
      if (existing !== null) {
        const existingGraph = decodeCodeGraph(existing);
        if (existingGraph.sourceWatermark !== decoded.sourceWatermark || existingGraph.projectFingerprint !== decoded.projectFingerprint) {
          throw new CodeGraphIntegrityError("Generation ID collision");
        }
      } else {
        await this.store.writeJson(graphPath, decoded);
        // Re-read before activation; a backend must never activate an unreadable write.
        decodeCodeGraph(await this.store.readJson<unknown>(graphPath));
      }
      const manifest: CodeGraphManifest = {
        schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
        generationId: decoded.generationId,
        sourceWatermark: decoded.sourceWatermark,
        nodeCount: decoded.nodes.length,
        edgeCount: decoded.edges.length,
        createdAt: decoded.generatedAt,
      };
      await this.store.writeJson(MANIFEST_PATH, manifest);
      const activated = decodeCodeGraphManifest(await this.store.readJson<unknown>(MANIFEST_PATH));
      // Keep only the active graph during healthy operation. The shared lock
      // ensures readers cannot observe a manifest that points at a generation
      // removed by this cleanup. A crash before cleanup leaves at most one
      // orphan, never a partial active graph.
      if (previous && previous.generationId !== activated.generationId) {
        try { await this.store.remove(generationPath(previous.generationId)); } catch { /* derived cleanup is best-effort */ }
      }
      return activated;
    } finally {
      await release();
    }
  }

  async readActive(): Promise<CodeGraph | null> {
    const release = await this.store.acquireLock("code-graph", { timeoutMs: 5_000 });
    try {
      return await this.readActiveUnsafe();
    } finally {
      await release();
    }
  }

  private async readActiveUnsafe(): Promise<CodeGraph | null> {
    const rawManifest = await this.store.readJson<unknown>(MANIFEST_PATH);
    if (rawManifest === null) return null;
    const manifest = decodeCodeGraphManifest(rawManifest);
    const rawGraph = await this.store.readJson<unknown>(generationPath(manifest.generationId));
    if (rawGraph === null) throw new CodeGraphIntegrityError("Active graph generation is missing");
    const graph = decodeCodeGraph(rawGraph);
    if (graph.generationId !== manifest.generationId || graph.sourceWatermark !== manifest.sourceWatermark || graph.nodes.length !== manifest.nodeCount || graph.edges.length !== manifest.edgeCount) {
      throw new CodeGraphIntegrityError("Active graph does not match its manifest");
    }
    return graph;
  }

  async readManifest(): Promise<CodeGraphManifest | null> {
    const release = await this.store.acquireLock("code-graph", { timeoutMs: 5_000 });
    try {
      return await this.readManifestUnsafe();
    } finally {
      await release();
    }
  }

  private async readManifestUnsafe(): Promise<CodeGraphManifest | null> {
    const raw = await this.store.readJson<unknown>(MANIFEST_PATH);
    return raw === null ? null : decodeCodeGraphManifest(raw);
  }
}
