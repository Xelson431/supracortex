/**
 * Engine: the single entry point to the core. It wires storage, memory, index,
 * cache, context building, orchestration, skills/MCP selection and metrics.
 *
 * The engine performs IO (through the StorageAdapter and the filesystem indexer)
 * but has NO knowledge of OpenCode. The adapter injects a
 * StorageAdapter and provides git/skill/mcp data via GatherInputs.
 *
 * Lazy initialization: nothing scans the repo until a method that needs the
 * index is called. `enabled === false` short-circuits every public method.
 */

import type {
  ContextPacket,
  FileSummary,
  GitChangeSummary,
  HealthState,
  IndexedFile,
  MemorySelection,
  MetricsSnapshot,
  AnnotatedMetrics,
  RepositoryIndex,
  SkillMetadata,
  McpServerMetadata,
  TaskDescriptor,
  TaskInput,
  TaskOutcome,
  TaskPlan,
  GraphExport,
  CortexSnapshot,
  CortexVaultManifest,
  SupraSpaceSyncReport,
  HostUsageObservation,
  ProviderUsageEvent,
  CodeGraph,
  CodeGraphQueryLimits,
  CodeGraphSelector,
  OutcomeStatus,
} from "./types.ts";
import type { Config } from "./config.ts";
import type { StorageAdapter } from "./storage/storage-adapter.ts";
import { MemoryManager } from "./memory/manager.ts";
import type { NewMemoryInput } from "./memory/schemas.ts";
import { redactSecrets, safeRelative } from "./memory/validation.ts";
import { ContextCache } from "./cache/context-cache.ts";
import { validateCache } from "./cache/invalidation.ts";
import { buildIndex, INDEX_VERSION } from "./context/repository-indexer.ts";
import { summarizeFile } from "./context/summaries.ts";
import { buildContextPacket } from "./context/builder.ts";
import { planTasks } from "./orchestration/scheduler.ts";
import { OwnershipManager } from "./orchestration/ownership.ts";
import { Reconciler } from "./orchestration/reconciler.ts";
import { Sweeper } from "./orchestration/sweeper.ts";
import { recommendSkills } from "./skills/registry.ts";
import { selectMcpTools } from "./mcp/selector.ts";
import { MetricsCollector } from "./metrics/collector.ts";
import { tokenize } from "./memory/ranking.ts";
import { runMigrations } from "./storage/migrations.ts";
import { ensureRuntimeGitignore } from "./storage/runtime-gitignore.ts";
import { SupraSpaceStore } from "./supraspace/store.ts";
import {
  planProjection,
  ingestFromFiles,
  isDuplicate,
  PROJECTED_FILES,
} from "./supraspace/projector.ts";
import { buildGraphExport } from "./supraspace/graph.ts";
import { EventStore } from "./events/store.ts";
import type { StructuralEvent } from "./events/types.ts";
import type { HandoffCapsule } from "./types.ts";
import { ValueMetricsStore } from "./metrics/value/store.ts";
import { buildValueReport, VALUE_CORRELATION_LABEL } from "./metrics/value/report.ts";
import type { ValueEvent, ContextInjectionEvent, ToolExecutionEvent, TaskOutcomeEvent, ProviderUsageLinkEvent } from "./metrics/value/types.ts";
import type { ValueReport } from "./metrics/value/report.ts";
import { sessionFileDate } from "./metrics/session-prune.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildVaultProjection } from "./vault/projector.ts";
import { buildCodeGraph } from "./graph/builder.ts";
import { CodeGraphStore } from "./graph/store.ts";
import { graphExplain, graphImpact, graphNeighbors, graphPath, type CodeGraphQueryResult } from "./graph/query.ts";
import { DecisionBudget } from "./jev/budget.ts";
import { JevClient, type JevCallResult } from "./jev/client.ts";
import { DecisionHealth, PROBE_TIMEOUT_MS, type DecisionState, type HealthSnapshot } from "./jev/health.ts";
import { effectiveDecisionTiming, resolveDecisionProvider } from "./jev/providers.ts";
import { resolveCredential } from "./jev/credentials.ts";
import { enrichContext } from "./jev/enrich.ts";
import { CapabilityHealth, type CapabilityHealthSnapshot } from "./capabilities/health.ts";
import { detectWebCapabilities, type WebCapabilities } from "./capabilities/web.ts";
import { jevJudgeMemory } from "./jev/router.ts";

const INDEX_FILE = "index/repository.json";
const HEALTH_FILE = "state/health.json";
/** In-memory index TTL: repeat turns within this window reuse the cached index. */
const INDEX_CACHE_TTL_MS = 30_000;

/** Clamp an optional TTL override to a finite, non-negative millisecond value. */
function normalizeIndexCacheTtlMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : INDEX_CACHE_TTL_MS;
}

function isProviderUsageEvent(value: unknown): value is ProviderUsageEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<ProviderUsageEvent>;
  const validTotals = (candidate: unknown) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
    const totals = candidate as Record<string, unknown>;
    return [
      "reportedCost",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ].every((key) => typeof totals[key] === "number" && Number.isFinite(totals[key]) && (totals[key] as number) >= 0);
  };
  return event.schemaVersion === 2 &&
    event.source === "opencode-host" &&
    typeof event.eventKey === "string" && /^[a-f0-9]{64}$/.test(event.eventKey) &&
    typeof event.messageId === "string" &&
    typeof event.sessionId === "string" &&
    typeof event.provider === "string" &&
    typeof event.model === "string" &&
    typeof event.observedAt === "string" && Number.isFinite(Date.parse(event.observedAt)) &&
    event.currency === null &&
    validTotals(event.cumulative) &&
    validTotals(event.delta);
}

/** Build reverse import hints (path -> paths that import it) by inverting the
 * per-file `imports` lists. Bounded; deterministic. */
function withReverseImports(index: RepositoryIndex): RepositoryIndex {
  const reverse: Record<string, string[]> = {};
  for (const file of Object.values(index.files)) {
    for (const target of file.imports ?? []) {
      const list = reverse[target] ?? (reverse[target] = []);
      if (list.length < 200 && !list.includes(file.path)) list.push(file.path);
    }
  }
  return { ...index, reverseImports: reverse };
}

export interface GatherInputs {
  git?: GitChangeSummary;
  skills?: SkillMetadata[];
  mcpServers?: McpServerMetadata[];
  /** Skills already present in the target agent context (avoid reload). */
  loadedSkills?: string[];
  targetAgent?: string;
}

export interface EngineOptions {
  config: Config;
  store: StorageAdapter;
  pluginVersion: string;
  /** Absolute project root for indexing. */
  projectRoot: string;
  /** Optional gitignore predicate (adapter-provided). */
  isGitIgnored?: (relPath: string) => boolean;
  now?: () => number;
  /**
   * In-memory index TTL in milliseconds. Repeat context requests within this
   * window reuse the cached index; 0 disables reuse so every request re-walks.
   * Defaults to INDEX_CACHE_TTL_MS (native plugin hosts also invalidate on a
   * file-mutating tool hook). Hosts with no file-mutation hook (MCP) pass 0.
   */
  indexCacheTtlMs?: number;
}

export class Engine {
  readonly config: Config;
  private store: StorageAdapter;
  private memory: MemoryManager;
  private cache: ContextCache;
  private ownership: OwnershipManager;
  private reconciler: Reconciler;
  private sweeper: Sweeper;
  private metrics = new MetricsCollector();
  private pluginVersion: string;
  private projectRoot: string;
  private isGitIgnored?: (relPath: string) => boolean;
  private now: () => number;
  private indexCache: RepositoryIndex | null = null;
  private indexRefresh: Promise<RepositoryIndex> | null = null;
  /** `this.now()` timestamp of the last indexCache assignment (TTL anchor). */
  private indexCachedAt = 0;
  /** In-memory index TTL (ms). 0 re-walks on every request. See EngineOptions. */
  private indexCacheTtlMs: number;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private events: EventStore;
  private lastSweepMs = 0;
  private codeGraph: CodeGraphStore;
  private valueMetrics: ValueMetricsStore;
  /**
   * Jev decision client (preview). Lazily created per project root; null when
   * Jev is disabled or no API key is present (zero network in that case).
   * Per-session/subtask isolation is enforced via per-call task keys, not by
   * sharing parent context: each prepareContext call builds its own shortlist
   * and evidence key from its own query/candidates.
   */
  private jevClient: JevClient | null = null;
  private jevHealth: DecisionHealth | null = null;
  private lastDecision: {
    at: number;
    ok: boolean;
    reason?: string;
    questions: number;
    inputChars: number;
    memoryReordered: boolean;
    summariesReordered: boolean;
    dropped: number;
    skill: string | null;
    mcpTool: string | null;
  } | null = null;
  /**
   * Capability health memory (see capabilities/health.ts). Hosts report real
   * tool outcomes via recordCapabilityOutcome; selectors read cooldowns so a
   * failing MCP server stops being recommended until it recovers.
   */
  private readonly capabilityHealth: CapabilityHealth;
  /** MCP server names from the most recent gather (for outcome attribution). */
  private lastMcpServerNames: string[] = [];
  /** Latest MCP metadata (bounded, operational only — the type holds no secrets). */
  private lastMcpServers: McpServerMetadata[] = [];
  /**
   * Bounded in-memory memo of the most recent (taskId, incarnationId) resolved
   * for a session. A completed task is removed from the active table when its
   * outcome is recorded, but the provider-usage link for that same turn is
   * emitted afterwards — the memo lets the link still correlate to the task
   * that just finished (best-effort, per-session, strictly bounded).
   */
  private sessionTaskHints = new Map<string, { taskId: string; incarnationId?: string; atMs: number }>();

  constructor(opts: EngineOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.pluginVersion = opts.pluginVersion;
    this.projectRoot = opts.projectRoot;
    this.isGitIgnored = opts.isGitIgnored;
    this.now = opts.now ?? (() => Date.now());
    this.indexCacheTtlMs = normalizeIndexCacheTtlMs(opts.indexCacheTtlMs);
    this.capabilityHealth = new CapabilityHealth({ now: this.now });
    this.memory = new MemoryManager(this.store, this.now);
    this.cache = new ContextCache(this.store, this.now);
    this.ownership = new OwnershipManager(this.store);
    this.reconciler = new Reconciler(this.store);
    this.sweeper = new Sweeper(this.store, this.now);
    this.events = new EventStore(this.store, this.config.events, this.now);
    this.codeGraph = new CodeGraphStore(this.store);
    this.valueMetrics = new ValueMetricsStore({
      storage: this.store,
      config: () => this.config.telemetry.valueMeasurement,
      now: this.now,
    });
    // Session start: verify the decision provider in the background so the
    // first real turn already knows whether to use it. Never awaited — engine
    // construction stays instant — and a no-op without a key. Tests inject
    // their own clock/fetch paths and opt out via SUPRACORTEX_NO_DECISION_WARMUP.
    if (this.config.enabled && process.env.SUPRACORTEX_NO_DECISION_WARMUP !== "1") {
      void this.warmDecisions().catch(() => undefined);
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Flush-independent resource shutdown for hosts with a lifecycle hook. */
  async close(): Promise<void> {
    await this.store.close();
  }

  /** Idempotent lazy init: create dirs + run migrations. Safe to call often. */
  async init(): Promise<void> {
    if (!this.enabled || this.initialized) return;
    if (this.initialization) return this.initialization;
    const pending = this.initialize();
    this.initialization = pending;
    try { await pending; }
    finally { this.initialization = null; }
  }

  private async initialize(): Promise<void> {
    for (const dir of [
      "state",
      "memory/sessions",
      "index",
      "summaries",
      "cache",
      "tasks",
      "metrics",
      "logs",
      "graph/generations",
    ]) {
      await this.store.ensureDir(dir);
    }
    // Every host passes through here, including MCP-only hosts that never run
    // the installer, so guard runtime state from being committed. Best-effort:
    // a read-only or otherwise unwritable root must never block init. The
    // helper itself never throws (and never follows symlinks), but keep the
    // call guarded so a future change can't turn this into a hard failure.
    try {
      await ensureRuntimeGitignore(this.store.root);
    } catch {
      /* best-effort */
    }
    await runMigrations(this.store, this.pluginVersion);
    this.initialized = true;
    await this.capture({ kind: "session.started", sessionId: this.pluginVersion });
    // Opportunistic staleness sweep on first init of a session. Failures here
    // must never block init.
    try {
      await this.sweep("engine-init");
    } catch {
      /* best-effort */
    }
  }

  // -------------------------------------------------------------------------
  // Staleness sweep (time-based GC). OpenCode has no timer hook, so this runs
  // opportunistically: engine init, session.idle, session.deleted, or on demand.
  // -------------------------------------------------------------------------

  /**
   * Run the staleness sweep. Debounced so rapid successive events don't thrash
   * storage; pass force=true (or a distinct reason after enough time) to bypass.
   */
  async sweep(
    reason: string,
    opts: { liveSessionIds?: Set<string> | null; terminalSessionId?: string; censusComplete?: boolean; force?: boolean } = {},
  ): Promise<import("./types.ts").SweepReport | null> {
    if (!this.enabled) return null;
    const now = this.now();
    const MIN_INTERVAL_MS = 5_000;
    if (!opts.force && this.lastSweepMs && now - this.lastSweepMs < MIN_INTERVAL_MS) {
      return null; // debounce
    }
    this.lastSweepMs = now;
    const report = await this.sweeper.sweep({
      config: this.config,
      now,
      reason,
      liveSessionIds: opts.liveSessionIds ?? null,
      // A session.deleted sweep is the host's explicit complete census path;
      // idle/live-session snapshots are intentionally non-authoritative.
      censusComplete: opts.censusComplete ?? reason === "session.deleted",
      terminalSessionId: opts.terminalSessionId,
    });
    // A clean sweep still ran: record it so status does not claim maintenance
    // has never happened when there was simply nothing to prune.
    await this.writeHealth({ lastSweepAt: report.ranAt });
    // Opportunistically unify with SupraSpace memory during the sweep. Failures
    // must never break the sweep.
    if (this.config.supraspace.enabled && this.config.supraspace.syncOnSweep) {
      try {
        await this.syncSupraSpace();
      } catch {
        /* best-effort */
      }
    }
    return report;
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  async ensureIndex(force = false): Promise<RepositoryIndex> {
    await this.init();
    // F4.2: repeat turns in the same process are served from the in-memory
    // index while it is within the TTL — no tree walk and no disk read. An
    // explicit force always bypasses the cache and rebuilds (with verification).
    if (!force && this.indexCache && (this.now() - this.indexCachedAt) < this.indexCacheTtlMs) {
      return this.indexCache;
    }
    if (this.indexRefresh) {
      const inFlight = this.indexRefresh;
      const current = await inFlight;
      if (!force) return current;
      // The existing refresh is complete. Run the explicit rebuild directly;
      // do not recurse through the still-clearing promise field.
      return this.refreshIndex(true);
    }
    const pending = this.refreshIndex(force);
    this.indexRefresh = pending;
    try { return await pending; }
    finally { this.indexRefresh = null; }
  }

  /**
   * Drop the in-memory index so the next `ensureIndex()` re-walks. The on-disk
   * INDEX_FILE is left intact as the mtime+size comparison baseline for the
   * next (possibly fast-path) walk. Used when a file-mutating tool completes.
   */
  invalidateIndexCache(): void {
    this.indexCache = null;
    this.indexCachedAt = 0;
  }

  /**
   * Override the in-memory index TTL at runtime (ms); 0 re-walks on every
   * request. Provided for hosts whose engine factory cannot thread
   * EngineOptions (e.g. the MCP server) so they can opt into deterministic
   * context without a file-mutation hook. An invalid value restores the
   * default TTL.
   */
  setIndexCacheTtlMs(ttlMs: number): void {
    this.indexCacheTtlMs = normalizeIndexCacheTtlMs(ttlMs);
  }

  private async refreshIndex(force: boolean): Promise<RepositoryIndex> {
    const stored = this.indexCache ?? await this.store.readJson<RepositoryIndex>(INDEX_FILE);
    const previous = stored && stored.version === INDEX_VERSION && stored.root === this.projectRoot ? stored : null;
    // A cached generation is a comparison baseline, never proof of current
    // source bytes. Rehash even equal-size/mtime files before verification.
    const outcome = await buildIndex({
      root: this.projectRoot,
      previous,
      extraIgnore: await this.readSupraCortexIgnore(),
      ...(this.isGitIgnored ? { isGitIgnored: this.isGitIgnored } : {}),
      allowOutside: false,
      // An explicit force demands full byte verification ("bytes are the
      // truth"); a routine refresh uses the fast mtime+size reuse path.
      verify: force,
    });
    const current = withReverseImports(outcome.index);
    this.metrics.add({
      // `scanned` counts every byte-verified file; `reused` is the subset whose
      // symbol analysis was reused because its hash was unchanged.
      filesConsidered: outcome.scanned,
      unchangedFilesSkipped: outcome.reused,
    });
    const oldFiles = previous?.files ?? {};
    const changed = [...new Set([...Object.keys(oldFiles), ...Object.keys(current.files)])].filter((p) => oldFiles[p]?.hash !== current.files[p]?.hash);
    if (changed.length) await this.capture({ kind: "file.changed", paths: changed });
    if (!previous || changed.length || force) {
      await this.store.writeJson(INDEX_FILE, current);
      await this.writeHealth({ lastIndexedAt: current.generatedAt });
    }
    // Invalidate memory whose file evidence changed/vanished (non-destructive).
    if (this.config.memory.enabled) {
      // Do not return allegedly verified context if invalidation failed.
      await this.evaluateEvidence(current);
    }
    this.indexCache = current;
    this.indexCachedAt = this.now();
    return current;
  }

  // -------------------------------------------------------------------------
  // Derived code graph (explicit experimental operations only)
  // -------------------------------------------------------------------------

  /** Build and atomically activate a graph from the same confined index used by context. */
  async rebuildCodeGraph(forceIndex = false): Promise<CodeGraph | null> {
    if (!this.enabled || !this.config.graph.enabled) return null;
    const index = await this.ensureIndex(forceIndex);
    const graph = buildCodeGraph({
      index,
      projectFingerprint: createHash("sha256").update(this.projectRoot).digest("hex"),
      generatedAt: new Date(this.now()).toISOString(),
    });
    if (graph.nodes.length > this.config.graph.maxNodes || graph.edges.length > this.config.graph.maxEdges) {
      throw new Error("Code graph exceeds configured limits; increase limits only after reviewing repository size");
    }
    await this.codeGraph.activate(graph);
    // Keep SupraSpace and the generated vault on the same validated graph
    // generation. The graph is already active even if a derived projection
    // cannot be refreshed; a later snapshot/export will retry safely.
    try { await this.exportSnapshot(); } catch { /* best-effort derived projection */ }
    return graph;
  }

  async getCodeGraph(): Promise<CodeGraph | null> {
    if (!this.enabled || !this.config.graph.enabled) return null;
    await this.init();
    return this.codeGraph.readActive();
  }

  /** Small, safe status surface shared by CLI, MCP, and host adapters. */
  async codeGraphStatus(): Promise<{
    enabled: boolean;
    available: boolean;
    generationId?: string;
    sourceWatermark?: string;
    createdAt?: string;
    nodeCount?: number;
    edgeCount?: number;
    automaticContext: boolean;
  }> {
    if (!this.enabled || !this.config.graph.enabled) {
      return { enabled: false, available: false, automaticContext: false };
    }
    await this.init();
    const manifest = await this.codeGraph.readManifest();
    if (!manifest) return { enabled: true, available: false, automaticContext: false };
    return {
      enabled: true,
      available: true,
      generationId: manifest.generationId,
      sourceWatermark: manifest.sourceWatermark,
      createdAt: manifest.createdAt,
      nodeCount: manifest.nodeCount,
      edgeCount: manifest.edgeCount,
      automaticContext: this.config.graph.automaticContext,
    };
  }

  async queryCodeGraphNeighbors(selector: CodeGraphSelector, limits: CodeGraphQueryLimits = {}): Promise<CodeGraphQueryResult | null> {
    const graph = await this.getCodeGraph();
    if (!graph) return null;
    return graphNeighbors(graph, selector, { ...limits, maxResults: Math.min(limits.maxResults ?? this.config.graph.maxQueryResults, this.config.graph.maxQueryResults) });
  }

  async explainCodeGraphNode(selector: CodeGraphSelector): Promise<CodeGraphQueryResult | null> {
    const graph = await this.getCodeGraph();
    return graph ? graphExplain(graph, selector) : null;
  }

  async queryCodeGraphPath(from: CodeGraphSelector, to: CodeGraphSelector, limits: CodeGraphQueryLimits = {}): Promise<CodeGraphQueryResult | null> {
    const graph = await this.getCodeGraph();
    if (!graph) return null;
    return graphPath(graph, from, to, { ...limits, maxResults: Math.min(limits.maxResults ?? this.config.graph.maxQueryResults, this.config.graph.maxQueryResults) });
  }

  async queryCodeGraphImpact(selector: CodeGraphSelector, direction: "incoming" | "outgoing", limits: CodeGraphQueryLimits = {}): Promise<CodeGraphQueryResult | null> {
    const graph = await this.getCodeGraph();
    if (!graph) return null;
    return graphImpact(graph, selector, direction, { ...limits, maxResults: Math.min(limits.maxResults ?? this.config.graph.maxQueryResults, this.config.graph.maxQueryResults) });
  }

  /**
   * Return a tiny, deterministic set of graph-derived file hints for a natural
   * language task. This never serializes graph labels into a prompt: it only
   * lets the existing budgeted context selector rank current indexed files.
   */
  async recommendCodeGraphFilesForTask(query: string, maxFiles = 3): Promise<string[]> {
    if (!this.enabled || !this.config.graph.enabled || !this.config.graph.automaticContext) return [];
    const graph = await this.getCodeGraph();
    if (!graph) return [];
    const terms = [...new Set(tokenize(query).map((term) => term.toLowerCase()).filter((term) => term.length >= 2))].slice(0, 32);
    if (!terms.length) return [];
    const scoreByPath = new Map<string, number>();
    const add = (path: string | undefined, score: number) => {
      if (!path || score <= 0) return;
      scoreByPath.set(path, (scoreByPath.get(path) ?? 0) + score);
    };
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const node of graph.nodes) {
      const haystack = `${node.path ?? ""}\n${node.symbol ?? ""}\n${node.label}`.toLowerCase();
      const matches = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
      if (!matches) continue;
      if (node.kind === "file") add(node.path, matches * 3);
      if (node.kind === "symbol") add(node.path, matches * 4);
    }
    // A direct symbol/file hit earns one bounded import-hop to avoid missing
    // the immediately coupled local module, never a graph dump.
    const direct = [...scoreByPath.entries()].sort(([a, as], [b, bs]) => bs - as || a.localeCompare(b)).slice(0, maxFiles);
    const directPaths = new Set(direct.map(([path]) => path));
    for (const edge of graph.edges) {
      if (edge.kind !== "imports") continue;
      const from = nodeById.get(edge.from)?.path;
      const to = nodeById.get(edge.to)?.path;
      if (from && to && directPaths.has(from)) add(to, 1);
    }
    return [...scoreByPath.entries()]
      .sort(([a, as], [b, bs]) => bs - as || a.localeCompare(b))
      .slice(0, Math.min(maxFiles, this.config.context.maxRecommendedReads))
      .map(([path]) => path);
  }

  /** A project-local deny layer independent of Git's sharing semantics. */
  private async readSupraCortexIgnore(): Promise<string[]> {
    try {
      const raw = await readFile(join(this.projectRoot, ".supracortexignore"), "utf8");
      return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Summaries + cache
  // -------------------------------------------------------------------------

  private async summariesForSelection(index: RepositoryIndex): Promise<{ summaries: Record<string, FileSummary>; cacheReport: { hits: number; misses: number; stale: number; entries: number } }> {
    if (!this.config.cache.enabled) return { summaries: {}, cacheReport: { hits: 0, misses: Object.keys(index.files).length, stale: 0, entries: 0 } };
    const cached = await this.cache.all();
    // Report validity against current index (drops stale).
    const report = validateCache(cached, index.files);
    this.metrics.add({ staleSummariesRejected: report.stale.length });
    const valid: Record<string, FileSummary> = {};
    for (const p of report.valid) {
      const c = cached[p];
      if (c) valid[p] = c;
    }
    const stale = report.stale.length + report.missing.length;
    const hits = report.valid.length;
    return { summaries: valid, cacheReport: { hits, misses: Math.max(0, Object.keys(index.files).length - hits), stale, entries: Object.keys(cached).length } };
  }

  // -------------------------------------------------------------------------
  // Context preparation
  // -------------------------------------------------------------------------

  /**
   * Lazily create the decision client. Null unless enabled with a usable
   * provider: the endpoint/model/credential all resolve from the configured
   * decision provider (Jev by default; Laya or custom via `jev.provider`).
   */
  private jev(): JevClient | null {
    const client = this.jevClientIfConfigured();
    if (!client) return null;
    // Health gate: decisions are used only after a real health request has
    // succeeded. Until then (and while unreachable) callers get null and take
    // the deterministic path immediately — no turn waits on the provider.
    return this.jevHealth!.usable() ? client : null;
  }

  /** The client when enabled + credentialed, regardless of health. */
  private jevClientIfConfigured(): JevClient | null {
    if (!this.config.jev.enabled) return null;
    if (this.jevClient) return this.jevClient;
    const provider = resolveDecisionProvider(this.config.jev);
    if (!provider.endpoint || !provider.model) return null;
    const apiKey = this.decisionApiKey(provider.apiKeyEnv);
    if (provider.requireAuth && !apiKey.trim()) return null;
    const client = new JevClient({
      config: {
        enabled: true,
        deadlineMs: effectiveDecisionTiming(this.config.jev).deadlineMs,
        model: provider.model,
        endpoint: provider.endpoint,
        apiKeyEnv: provider.apiKeyEnv,
        requireAuth: provider.requireAuth,
        modelMatch: provider.modelMatch,
        projectKey: createHash("sha256").update(this.projectRoot).digest("hex").slice(0, 16),
      },
      apiKey: apiKey || null,
    });
    this.jevClient = client;
    client.onResult = (result) => this.observeDecision(result);
    this.jevHealth = new DecisionHealth(() => client.decide({
      state: { probe: "supracortex health check" },
      questions: { ready: { type: "noul", instructions: "Is this request a health check?", criteria: { true: "It is a health check.", false: "It is not a health check." } } },
      timeoutMs: PROBE_TIMEOUT_MS,
      taskKey: `health-${Date.now()}`,
      policyKey: "health",
      configKey: "health",
      evidenceKey: `health-${Date.now()}`,
    }));
    return client;
  }

  /** Report a real decision outcome to the health gate. */
  private observeDecision(result: JevCallResult): void {
    this.jevHealth?.observe(result);
  }

  /**
   * Start the decision-provider health check now (no-op when disabled or no
   * key). Hosts call this at session start so the first real turn already
   * knows whether decisions are usable. Resolves when the check settles.
   */
  async warmDecisions(): Promise<HealthSnapshot> {
    if (!this.jevClientIfConfigured()) return this.decisionHealth();
    await this.jevHealth!.kick();
    return this.decisionHealth();
  }

  /** Current decision-provider state (never makes a network call). */
  decisionHealth(): HealthSnapshot {
    if (!this.config.jev.enabled) return { state: "disabled" };
    if (!this.jevClientIfConfigured()) return { state: "no-key", reason: `no credential for ${resolveDecisionProvider(this.config.jev).apiKeyEnv || "provider"}` };
    return this.jevHealth!.snapshot();
  }

  /**
   * Decision credential: process env first, then env-style credential files
   * (parsed, never executed). Memoized per engine so status/decide agree and
   * files are read at most once.
   */
  private decisionKeyCache: { name: string; value: string } | null = null;
  private decisionApiKey(name: string): string {
    if (!name) return "";
    if (this.decisionKeyCache?.name === name) return this.decisionKeyCache.value;
    const found = resolveCredential(name, { credentialsFile: this.config.jev.credentialsFile });
    this.decisionKeyCache = { name, value: found?.value ?? "" };
    return this.decisionKeyCache.value;
  }

  /** Per-call Jev key material: task/agent + config + evidence hashes. Never the parent context. */
  private jevKeys(task: TaskInput, gather: GatherInputs, evidenceParts: string[]): {
    taskKey: string;
    configKey: string;
    evidenceKey: string;
  } {
    const taskKey = createHash("sha256")
      .update(`${task.taskId ?? ""}\0${gather.targetAgent ?? ""}\0${task.query.slice(0, 500)}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    // Cache keys discriminate decision providers so switching provider (or
    // endpoint/model) never reuses another provider's cached answers.
    const decisionProvider = resolveDecisionProvider(this.config.jev);
    const configKey = createHash("sha256")
      .update(
        JSON.stringify({
          provider: decisionProvider.id,
          endpoint: decisionProvider.endpoint,
          jevModel: decisionProvider.model,
          minConfidence: this.config.jev.minConfidence,
          enrichmentBudgetMs: effectiveDecisionTiming(this.config.jev).enrichmentBudgetMs,
          maxTokens: this.config.context.maxTokens,
          maxEntries: this.config.memory.maxRetrievedEntries,
          maxReads: this.config.context.maxRecommendedReads,
        }),
        "utf8",
      )
      .digest("hex")
      .slice(0, 16);
    const evidenceKey = createHash("sha256").update(evidenceParts.join("\0"), "utf8").digest("hex").slice(0, 16);
    return { taskKey, configKey, evidenceKey };
  }

  private jevMetricsPatch(fallback: boolean, applied: boolean): {
    jevFallbacks: number;
    jevDecisionsApplied: number;
  } {
    return {
      jevFallbacks: fallback ? 1 : 0,
      jevDecisionsApplied: applied && !fallback ? 1 : 0,
    };
  }

  /**
   * Drain validated Jev usage from the client after a decide() call and
   * attribute it to metrics: calls (HTTP issued), cacheHits, input/output
   * tokens, and consecutive failures. Never throws.
   */
  private drainJevUsage(client: JevClient): void {
    try {
      const usage = client.takeLastUsage();
      if (!usage) return;
      this.metrics.add({
        jevCalls: usage.issuedCall ? 1 : 0,
        jevCacheHits: usage.fromCache ? 1 : 0,
        jevInputTokens: usage.inputTokens,
        jevOutputTokens: usage.outputTokens,
      });
    } catch {
      // Metrics attribution is best-effort.
    }
  }

  async prepareContext(task: TaskInput, gather: GatherInputs = {}): Promise<ContextPacket | null> {
    if (!this.enabled || !this.config.context.enabled) return null;
    const jevClient = this.jev();
    // Wall-clock budget for this request's decision enrichment (one call).
    // Started here so deterministic work below counts against it too: the
    // decision layer may never extend a turn beyond enrichmentBudgetMs.
    const budget = new DecisionBudget(effectiveDecisionTiming(this.config.jev).enrichmentBudgetMs);

    // Deterministic graph hints (when the local code graph is enabled).
    const graphHints = await this.recommendCodeGraphFilesForTask(task.query);
    const effectiveTask: TaskInput = graphHints.length
      ? { ...task, hintFiles: [...new Set([...(task.hintFiles ?? []), ...graphHints])].slice(0, 100) }
      : task;
    const index = await this.ensureIndex();
    const summaryState = await this.summariesForSelection(index);
    const summaries = summaryState.summaries;
    const memory = this.config.memory.enabled ? await this.memory.loadAll() : [];
    const queryTokens = Array.from(new Set(tokenize(effectiveTask.query)));

    // Skills + MCP recommendations (metadata-only, pure). Deterministic first;
    // the decision provider may narrow to one confident selection later.
    const skillRes = recommendSkills({
      skills: gather.skills ?? [],
      queryTokens,
      alreadyLoaded: gather.loadedSkills ?? [],
      targetAgent: gather.targetAgent,
    });
    // Refresh capability health from host discovery, then let cooldowns and
    // live-connection state shape the recommendation.
    this.lastMcpServerNames = (gather.mcpServers ?? []).map((s) => s.name);
    this.lastMcpServers = (gather.mcpServers ?? []).slice(0, 50);
    for (const server of gather.mcpServers ?? []) {
      if (server.availability === "connected" || server.availability === "tested" || server.connected) {
        this.capabilityHealth.markConnected(server.name);
      }
    }
    const mcpRes = selectMcpTools({
      servers: gather.mcpServers ?? [],
      queryTokens,
      targetAgent: gather.targetAgent,
      health: { isCoolingDown: (server) => this.capabilityHealth.isCoolingDown(server) },
    });
    const recommendedSkills = skillRes.recommended;
    const recommendedMcpTools = mcpRes.recommended;
    const excludedMcpServers = mcpRes.excludedServers;
    const cacheReport = summaryState.cacheReport;

    const built = buildContextPacket({
      task: effectiveTask,
      config: {
        maxTokens: this.config.context.maxTokens,
        maxRetrievedEntries: this.config.memory.maxRetrievedEntries,
        maxRetrievedTokens: this.config.memory.maxRetrievedTokens,
        maxRecommendedReads: this.config.context.maxRecommendedReads,
        summaryThresholdTokens: this.config.context.summaryThresholdTokens,
        preferChangedFiles: this.config.context.preferChangedFiles,
      },
      index: index.files,
      summaries,
      memory,
      git: this.config.context.includeGitDiff ? gather.git : undefined,
      cacheReport,
      recommendedSkills,
      excludedSkills: skillRes.excluded,
      recommendedMcpTools,
      excludedMcpServers,
      now: this.now(),
    });

    // Decision enrichment: ONE request per turn (skills/MCP choice + per-
    // candidate relevance for memory and summaries). It operates on the built,
    // already-budgeted packet: it reorders and drops confident rejects, never
    // adds, so token totals can only shrink. Any failure keeps the
    // deterministic packet exactly as built.
    let decisionsApplied = false;
    if (jevClient && !budget.exhausted()) {
      try {
        decisionsApplied = await this.applyDecisionEnrichment(built.packet, effectiveTask, gather, budget.remainingMs());
        this.drainJevUsage(jevClient);
      } catch {
        // Deterministic packet stands.
      }
    }

    this.metrics.add({
      memoryEntriesConsidered: built.stats.memoryConsidered,
      memoryEntriesSelected: built.stats.memorySelected,
      // A selection is a recommendation. Only an explicit host read event may
      // increment filesOpened, which this adapter cannot currently observe.
      filesOpened: 0,
      cacheHits: cacheReport.hits,
      cacheMisses: cacheReport.misses,
      estimatedTokensSelected: built.stats.tokensSelected,
      estimatedTokensExcluded: built.stats.tokensExcluded,
      staleSummariesRejected: built.stats.staleSummariesRejected,
      contextPacketTokens: built.packet.estimatedTokens,
      skillsConsidered: skillRes.considered,
      skillsRecommended: skillRes.recommended.length,
      duplicateSkillLoadsAvoided: skillRes.duplicateLoadsAvoided,
      mcpServersConsidered: mcpRes.serversConsidered,
      mcpServersSelected: mcpRes.serversSelected,
      mcpToolsSelected: mcpRes.toolsSelected,
      ...this.jevMetricsPatch(!jevClient, decisionsApplied),
    });

    // Opportunistically warm the summary cache for full files we selected.
    if (this.config.cache.enabled) {
      await this.warmSummaries(built.packet, index.files);
    }

    return built.packet;
  }

  /**
   * Upper bound on serialized decision-request characters. Jev accepts large
   * requests; Laya's encoder silently truncates past ~512 tokens (≈1 800
   * chars of JSON), which corrupts answers without an error. Providers with a
   * small window get a small cap; the planner then judges fewer tail
   * candidates rather than sending a request the model cannot fully read.
   */
  private decisionInputCap(): number {
    return effectiveDecisionTiming(this.config.jev).maxInputChars;
  }


  /**
   * One decision request per turn. Mutates the built packet in place:
   * reorders memory/summaries by per-candidate relevance, drops confident
   * rejects (never below two per group), and narrows the skill/MCP
   * recommendation to a confident single choice. Returns true when anything
   * changed. Token totals only ever go down, and are recomputed.
   */
  private async applyDecisionEnrichment(
    packet: ContextPacket,
    task: TaskInput,
    gather: GatherInputs,
    timeoutMs: number,
  ): Promise<boolean> {
    const client = this.jev();
    if (!client || timeoutMs <= 0) return false;
    const keys = this.jevKeys(task, gather, [
      task.query,
      ...packet.selectedMemory.map((m) => m.entry.id),
      ...packet.selectedSummaries.map((s) => `${s.path}@${s.sourceHash}`),
      ...packet.recommendedSkills.map((s) => s.name),
    ]);
    const toolId = (t: { server: string; tool?: string }) => `${t.server}:${t.tool ?? "server"}`;
    const result = await enrichContext(client, {
      query: task.query,
      memory: packet.selectedMemory.map((m) => ({ id: m.entry.id, text: `${m.entry.kind}: ${m.entry.content}` })),
      summaries: packet.selectedSummaries.map((s) => ({ id: s.path, text: `${s.path} — ${s.summary}` })),
      // Only offer a choice when there is something to narrow.
      skills: packet.recommendedSkills.length > 1
        ? packet.recommendedSkills.map((s) => ({ name: s.name, description: s.reason }))
        : [],
      mcpTools: packet.recommendedMcpTools.length > 1
        ? packet.recommendedMcpTools.map((t) => ({ id: toolId(t), description: t.purpose || t.server }))
        : [],
      maxInputChars: this.decisionInputCap(),
      maxQuestions: effectiveDecisionTiming(this.config.jev).maxQuestions,
      snippetChars: effectiveDecisionTiming(this.config.jev).snippetChars,
      timeoutMs,
      keys,
    });
    this.lastDecision = {
      at: this.now(),
      ok: result.ok,
      ...(result.reason ? { reason: result.reason } : {}),
      questions: result.questions,
      inputChars: result.inputChars,
      memoryReordered: !!result.memory,
      summariesReordered: !!result.summaries,
      dropped: (result.memory?.dropped.length ?? 0) + (result.summaries?.dropped.length ?? 0),
      skill: result.skill,
      mcpTool: result.mcpTool,
    };
    if (!result.ok) return false;
    let applied = false;
    let freedTokens = 0;
    if (result.memory) {
      const byId = new Map(packet.selectedMemory.map((m) => [m.entry.id, m]));
      const next = result.memory.order.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
      if (next.length >= Math.min(2, packet.selectedMemory.length)) {
        for (const id of result.memory.dropped) {
          freedTokens += byId.get(id)?.estimatedTokens ?? 0;
          packet.omissions.push({ path: `memory:${id}`, reason: "low-relevance", detail: "decision provider: not relevant to this task" });
        }
        packet.selectedMemory = next;
        packet.constraints = next.filter((m) => m.entry.kind === "constraint").map((m) => m.entry.content);
        packet.knownFailures = next.filter((m) => m.entry.kind === "failure").map((m) => m.entry.content);
        applied = true;
      }
    }
    if (result.summaries) {
      const byPath = new Map(packet.selectedSummaries.map((s) => [s.path, s]));
      const next = result.summaries.order.map((p) => byPath.get(p)).filter((s): s is NonNullable<typeof s> => !!s);
      if (next.length >= Math.min(2, packet.selectedSummaries.length)) {
        for (const path of result.summaries.dropped) {
          freedTokens += byPath.get(path)?.estimatedTokens ?? 0;
          packet.omissions.push({ path, reason: "low-relevance", detail: "decision provider: not relevant to this task" });
        }
        packet.selectedSummaries = next;
        applied = true;
      }
    }
    if (result.skill) {
      const kept = packet.recommendedSkills.filter((s) => s.name === result.skill);
      if (kept.length) {
        packet.recommendedSkills = kept;
        applied = true;
      }
    }
    if (result.mcpTool) {
      const kept = packet.recommendedMcpTools.filter((t) => toolId(t) === result.mcpTool);
      if (kept.length) {
        packet.recommendedMcpTools = kept;
        applied = true;
      }
    }
    if (freedTokens > 0) {
      // Dropped candidates free budget; keep the packet's accounting exact.
      const used = Math.max(0, packet.estimatedTokens - freedTokens);
      packet.estimatedTokens = used;
      packet.budget = { ...packet.budget, usedTokens: used, remainingTokens: Math.max(0, packet.budget.maxTokens - used) };
    }
    return applied;
  }

  /** Observability: what the last decision enrichment did (no content). */
  lastDecisionSummary(): typeof this.lastDecision {
    return this.lastDecision;
  }

  private async warmSummaries(
    packet: ContextPacket,
    index: Record<string, IndexedFile>,
  ): Promise<void> {
    // Build summaries for reference-mode files so future packets can use them.
    const cached = await this.cache.all();
    const pending: FileSummary[] = [];
    for (const f of packet.selectedFiles) {
      if (f.mode !== "reference") continue;
      const idx = index[f.path];
      if (!idx) continue;
      const existing = cached[idx.path];
      if (existing?.sourceHash === idx.hash) continue;
      // We only have metadata here (no content) — store a structural summary
      // derived from symbols, which is cheap and hash-bound.
      const summary: FileSummary = {
        path: f.path,
        sourceHash: idx.hash,
        summary: `File: ${f.path}${idx.language ? ` (${idx.language})` : ""}\nSymbols: ${idx.symbols.slice(0, 30).join(", ")}`,
        estimatedTokens: Math.min(idx.estimatedTokens, 400),
        createdAt: new Date(this.now()).toISOString(),
      };
      pending.push(summary);
    }
    await this.cache.setMany(pending);
  }

  /** Build/refresh a content-derived summary for a file the caller has read. */
  async cacheSummaryFromContent(path: string, content: string): Promise<FileSummary | null> {
    if (!this.enabled || !this.config.cache.enabled) return null;
    const index = await this.ensureIndex();
    const idx = index.files[path];
    if (!idx) return null;
    const { hashContent } = await import("./context/repository-indexer.ts");
    const hash = hashContent(content);
    // Content-derived summaries can lift verbatim text (e.g. a `Purpose:` line
    // from a leading comment) straight from file content, which may embed a
    // hardcoded secret. Redact before this ever reaches cache/wire — this is
    // the only durable-write path that summarizes raw content rather than
    // structural metadata (symbols/paths), so it's the only one that needs it.
    const rawSummary = summarizeFile({ path, content, language: idx.language });
    const summaryText = this.config.privacy.redactLikelySecrets
      ? redactSecrets(rawSummary).text
      : rawSummary;
    const summary: FileSummary = {
      path,
      sourceHash: hash,
      summary: summaryText,
      estimatedTokens: 0,
      createdAt: new Date(this.now()).toISOString(),
    };
    const { estimateTokens } = await import("./metrics/token-estimator.ts");
    summary.estimatedTokens = estimateTokens(summary.summary);
    await this.cache.set(summary);
    return summary;
  }

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  async recordMemory(input: NewMemoryInput) {
    if (!this.enabled || !this.config.memory.enabled) {
      return { status: "rejected" as const, reason: "disabled", redacted: false };
    }
    await this.init();
    // Storage quota guard: refuse new durable writes once the runtime dir
    // exceeds the configured cap (prevents unbounded disk growth / DoS).
    const capBytes = this.config.storage.maxStorageMb * 1024 * 1024;
    if (capBytes > 0) {
      const used = await this.store.totalSizeBytes();
      if (used >= capBytes) {
        return {
          status: "rejected" as const,
          reason: `storage quota reached (${Math.round(used / 1048576)}MB >= ${this.config.storage.maxStorageMb}MB); run compact/sweep or raise storage.maxStorageMb`,
          redacted: false,
        };
      }
    }
    const enriched = await this.enrichFileEvidence(input);
    // Jev memory judgment is advisory for agent learnings only: it may attach
    // duplicate/contradiction hint tags, but never vetoes an explicit write.
    // The existing evidence + contradiction controls below still decide.
    const jevHints = await this.jevMemoryHints(enriched.content, enriched.relatedFiles ?? []);
    const hinted = jevHints.length
      ? { ...enriched, tags: [...new Set([...(enriched.tags ?? []), ...jevHints])].slice(0, 50) }
      : enriched;
    const result = await this.memory.record(hinted, {
      requireEvidenceForDurableFacts: this.config.memory.requireEvidenceForDurableFacts,
      redactLikelySecrets: this.config.privacy.redactLikelySecrets,
      minimumConfidence: this.config.memory.minimumConfidence,
      projectRoot: this.projectRoot,
    });
    if (result.status === "recorded" && result.entry) {
      await this.capture({ kind: "decision.recorded", memoryId: result.entry.id });
      // Keep local visualizers fresh without requiring a manual snapshot CLI.
      // Projection failure never invalidates the authoritative memory write.
      try { await this.exportSnapshot(); } catch { /* derived read model retries on next mutation/export */ }
    }
    return result;
  }

  /**
   * Advisory Jev judgment for an agent-supplied learning. Returns extra tags
   * (possible-duplicate / possible-contradiction / jev-kind:<kind>) or [].
   * Explicit writes are never vetoed: uncertain/offline Jev returns [] and the
   * existing deterministic controls decide. Only runs for agent-originated
   * learnings; explicit-user content bypasses advisory judging.
   */
  private async jevMemoryHints(content: string, relatedFiles: string[]): Promise<string[]> {
    const client = this.jev();
    if (!client) return [];
    try {
      const entries = await this.memory.loadAll();
      const active = entries.filter((e) => e.status === "active").slice(-50);
      const existing = active.slice(0, 8).map((e) => ({ id: e.id, kind: e.kind, text: e.content }));
      const keys = this.jevKeys({ query: content.slice(0, 500) }, {}, [content, ...relatedFiles, ...existing.map((e) => e.id)]);
      const judgment = await jevJudgeMemory(client, {
        query: content.slice(0, 500),
        tags: [],
        taskKey: keys.taskKey,
        configKey: keys.configKey,
        evidenceKey: keys.evidenceKey,
        content,
        relatedFiles,
        existingSummaries: existing,
      });
      this.drainJevUsage(client);
      if (!judgment.fromJev) return [];
      const tags: string[] = [`jev-kind:${judgment.kind}`];
      if (judgment.possibleDuplicate) tags.push("possible-duplicate");
      if (judgment.possibleContradiction) tags.push("possible-contradiction");
      if (judgment.verdict === "needs-evidence") tags.push("needs-evidence");
      // A discard verdict is advisory only: tag, never veto. Downstream review
      // can dispute/invalidate; the write itself proceeds.
      if (judgment.verdict === "discard") tags.push("jev-suggest-discard");
      this.metrics.add(this.jevMetricsPatch(false, true));
      return tags;
    } catch {
      this.metrics.add(this.jevMetricsPatch(true, false));
      return [];
    }
  }

  /**
   * Resolve `file` source references that have no hash against the current index:
   * attach the indexed hash and ensure a matching `file-hash-changed` rule exists
   * so a later edit/deletion of that file invalidates the memory. Files not in
   * the index (secret/ignored/missing/outside) are left unhashed; existing policy
   * may then drop them for durable kinds.
   */
  private async enrichFileEvidence(input: NewMemoryInput): Promise<NewMemoryInput> {
    const refs = input.sourceReferences ?? [];
    if (!refs.some((r) => r.kind === "file")) return input;
    let index: RepositoryIndex;
    try { index = await this.ensureIndex(); } catch { return input; }
    const rules = [...(input.invalidationRules ?? [])];
    const sourceReferences = refs.map((r) => {
      if (r.kind !== "file") return r;
      const rel = safeRelative(this.projectRoot, r.value) ?? r.value;
      const idx = index.files[rel];
      if (!idx) return r;
      if (!rules.some((ru) => ru.kind === "file-hash-changed" && ru.target === rel)) {
        rules.push({ kind: "file-hash-changed", target: rel });
      }
      return { ...r, value: rel, hash: idx.hash };
    });
    return { ...input, sourceReferences, invalidationRules: rules };
  }

  /**
   * Non-destructively invalidate memory whose file evidence changed or vanished.
   * Only entries with a `file-hash-changed` rule and a stored evidence hash are
   * considered; references without a stored hash are genuinely unverifiable and
   * are never falsely marked stale.
   */
  private async evaluateEvidence(index: RepositoryIndex): Promise<void> {
    const res = await this.memory.invalidateByEvidence(index.files, this.now());
    if (res.changed || res.deleted || res.expired || res.unverifiable) {
      this.metrics.add({ evidenceStaleMarked: res.changed + res.deleted + res.expired });
    }
  }

  async searchMemory(
    query: string,
    opts: { tags?: string[]; hintFiles?: string[]; changedFiles?: string[] } = {},
  ): Promise<MemorySelection[]> {
    if (!this.enabled || !this.config.memory.enabled) return [];
    await this.init();
    // Search is an automatic-context path too. Evaluate invalidation before
    // ranking so an expired or changed-evidence entry cannot leak merely
    // because a caller uses searchMemory instead of prepareContext.
    const index = await this.ensureIndex();
    await this.evaluateEvidence(index);
    const res = await this.memory.search(
      query,
      opts.tags ?? [],
      opts.hintFiles ?? [],
      opts.changedFiles ?? [],
      {
        maxEntries: this.config.memory.maxRetrievedEntries,
        maxTokens: this.config.memory.maxRetrievedTokens,
      },
      this.now(),
    );
    this.metrics.add({
      memoryEntriesConsidered: res.considered,
      memoryEntriesSelected: res.selections.length,
    });
    return res.selections;
  }

  async recordOutcome(
    outcome: TaskOutcome,
  ): Promise<{ recorded: boolean; operationId: string } | null> {
    if (!this.enabled) return null;
    await this.init();
    // Sanitize BEFORE any persistence: redact secret-shaped text and confine
    // touched-file paths to the project root. This runs even when automatic
    // recording is off, because the raw outcome is written to completed.jsonl.
    const safe = this.sanitizeOutcome(outcome);
    const operationId = safe.operationId ?? createHash("sha256")
      .update(JSON.stringify({
        taskId: safe.taskId,
        incarnationId: safe.incarnationId ?? null,
        status: safe.status,
        summary: safe.summary,
        touchedFiles: safe.touchedFiles,
        learnings: safe.learnings ?? [],
        failureReason: safe.failureReason ?? null,
      }))
      .digest("hex");
    safe.operationId = operationId;
    const reconciliation = await this.reconciler.recordOutcome(safe, this.now());
    if (!reconciliation.recorded) return reconciliation;
    // Emit a task_outcome value row (best-effort; never breaks outcome recording).
    await this.recordTaskOutcome({
      taskId: safe.taskId,
      incarnationId: safe.incarnationId,
      status: safe.status,
      source: safe.source ?? "agent",
    });
    await this.capture({ kind: "task.completed", status: safe.status, note: `${safe.touchedFiles.length} files` });
    // Persist verified learnings to durable memory (task-outcome kind).
    if ((safe.source ?? "agent") === "agent" && this.config.memory.enabled && safe.learnings?.length) {
      for (const learning of safe.learnings) {
        const res = await this.memory.record(
          {
            kind: "task-outcome",
            content: learning,
            confidence: safe.status === "success" ? 0.8 : 0.6,
            sourceReferences: [{ kind: "session", value: safe.taskId }],
            relatedFiles: safe.touchedFiles,
            tags: ["outcome", safe.status],
          },
          {
            requireEvidenceForDurableFacts: false,
            redactLikelySecrets: this.config.privacy.redactLikelySecrets,
            minimumConfidence: 0,
            projectRoot: this.projectRoot,
          },
        );
        if (res.status === "recorded") this.metrics.add({ rawFindingsPersisted: 1 });
      }
    }
    try { await this.exportSnapshot(); } catch { /* derived read model */ }
    return reconciliation;
  }

  /** Redact secret-shaped text and confine paths before persisting an outcome. */
  private sanitizeOutcome(outcome: TaskOutcome): TaskOutcome {
    const redact = this.config.privacy.redactLikelySecrets
      ? (s: string) => redactSecrets(s).text
      : (s: string) => s;
    const confine = (paths: string[]): string[] => {
      const out: string[] = [];
      for (const p of paths) {
        const rel = safeRelative(this.projectRoot, p);
        if (rel && !rel.startsWith("..")) {
          out.push(rel);
        }
      }
      return out;
    };
    const safe: TaskOutcome = {
      ...(outcome.operationId
        ? { operationId: redactSecrets(outcome.operationId).text.slice(0, 120) }
        : {}),
      taskId: outcome.taskId,
      ...(outcome.incarnationId ? { incarnationId: outcome.incarnationId } : {}),
      ...(outcome.source ? { source: outcome.source } : {}),
      status: outcome.status,
      summary: redact(outcome.summary),
      touchedFiles: confine(outcome.touchedFiles ?? []),
      recordedAt: outcome.recordedAt,
    };
    if (Array.isArray(outcome.learnings)) {
      const cleaned = outcome.learnings
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map(redact);
      safe.learnings = cleaned;
    }
    if (outcome.failureReason) safe.failureReason = redact(outcome.failureReason);
    return safe;
  }

  private async capture(event: Partial<StructuralEvent> & { kind: string }): Promise<StructuralEvent | null> {
    try { const result = await this.events.append(event); if (result) this.metrics.add({ eventsCaptured: 1 }); return result; } catch { return null; }
  }

  async timelineEvents(opts: { since?: string; until?: string; kinds?: string[]; limit?: number } = {}): Promise<StructuralEvent[]> {
    if (!this.enabled || !this.config.events.enabled) return [];
    await this.init(); return this.events.list(opts);
  }
  async eventDetail(id: string): Promise<StructuralEvent | null> {
    if (!this.enabled || !this.config.events.enabled) return null;
    await this.init(); return this.events.detail(id);
  }

  async createHandoff(input: { goal: string; completedWork?: string[]; testsPassed?: number; testsFailed?: number; testsSkipped?: number; failures?: string[]; openRisks?: string[]; nextActions?: string[]; evidenceIds?: string[]; sessionId?: string }): Promise<HandoffCapsule | null> {
    if (!this.enabled || !this.config.events.enabled) return null;
    await this.init(); const index = await this.ensureIndex(); const memory = await this.memory.loadAll();
    const approved = new Set(memory.filter((m) => !["candidate", "forgotten"].includes(m.status)).map((m) => m.id));
    const events = await this.events.list({ limit: 100 }); const id = randomUUID();
    // Defense-in-depth: the tool boundary already normalizes these arrays, but
    // engine.createHandoff is a public API other adapters may call directly,
    // so a malformed (non-array, or array with non-string elements) value must
    // never throw here.
    const toStringArray = (xs: unknown): string[] =>
      Array.isArray(xs)
        ? xs.filter((x): x is string => typeof x === "string")
        : typeof xs === "string"
          ? [xs]
          : [];
    const safe = (xs: unknown, max: number) => toStringArray(xs).slice(0, max).map((s) => redactSecrets(s).text.slice(0, 1000));
    const capsule: HandoffCapsule = { schemaVersion: 1, id, createdAt: new Date(this.now()).toISOString(), projectFingerprint: createHash("sha256").update(this.projectRoot).digest("hex"), eventWatermark: events.at(-1)?.id ?? null, goal: redactSecrets(input.goal).text.slice(0, 2000), completedWork: safe(input.completedWork, 50), changedFiles: Object.values(index.files).slice(0, 100).map((f) => ({ path: f.path, hash: f.hash })), testsPassed: input.testsPassed ?? 0, testsFailed: input.testsFailed ?? 0, testsSkipped: input.testsSkipped ?? 0, failures: safe(input.failures, 20), openRisks: safe(input.openRisks, 20), nextActions: safe(input.nextActions, 20), evidenceIds: toStringArray(input.evidenceIds).filter((x) => approved.has(x)).slice(0, 100), ...(input.sessionId ? { sessionId: redactSecrets(input.sessionId).text.slice(0, 120) } : {}) };
    await this.store.ensureDir("handoffs"); await this.store.writeJson(`handoffs/handoff-${id}.json`, capsule); await this.capture({ kind: "handoff.created", note: id }); this.metrics.add({ handoffsCreated: 1 }); return capsule;
  }

  async resumeHandoff(id: string): Promise<{ capsule: HandoffCapsule; staleFiles: string[]; evidence: import("./types.ts").MemoryEntry[]; brief: string } | null> {
    if (!this.enabled || !this.config.events.enabled) return null; await this.init();
    const capsule = await this.store.readJson<HandoffCapsule>(`handoffs/handoff-${id}.json`); if (!capsule) throw new Error("handoff not found");
    if (capsule.schemaVersion !== 1) throw new Error("unsupported handoff version");
    if (capsule.projectFingerprint !== createHash("sha256").update(this.projectRoot).digest("hex")) throw new Error("handoff project mismatch");
    const index = await this.ensureIndex(); const staleFiles = capsule.changedFiles.filter((f) => (index.files[f.path]?.hash ?? null) !== f.hash).map((f) => f.path);
    const memory = await this.memory.loadAll(); const evidence = memory.filter((m) => capsule.evidenceIds.includes(m.id) && !["candidate", "forgotten"].includes(m.status));
    await this.capture({ kind: "resume.consumed", note: id }); this.metrics.add({ resumesConsumed: 1 });
    return { capsule, staleFiles, evidence, brief: `${capsule.goal}\nCompleted: ${capsule.completedWork.join("; ")}\nStale files: ${staleFiles.length}` };
  }

  /**
   * Jev review recommendation for handoff/evidence triage (preview).
   * Advisory only: returns whether Jev recommends a review/handoff given the
   * supplied task evidence. Never throws; falls back to { recommendReview:
   * false } when Jev is off or uncertain. Callers (MCP/opencode) decide.
   */
  async jevReviewEvidence(evidence: Record<string, unknown>, taskQuery = ""): Promise<import("./jev/types.ts").JevReviewDecision> {
    const fallback = { recommendReview: false, confidence: 0, fromJev: false };
    const client = this.jev();
    if (!client) return fallback;
    try {
      const keys = this.jevKeys({ query: taskQuery }, {}, [JSON.stringify(evidence).slice(0, 2000)]);
      const { jevReview } = await import("./jev/router.ts");
      const decision = await jevReview(client, {
        query: taskQuery,
        tags: [],
        taskKey: keys.taskKey,
        configKey: keys.configKey,
        evidenceKey: keys.evidenceKey,
        evidence,
      });
      this.drainJevUsage(client);
      this.metrics.add(this.jevMetricsPatch(!decision.fromJev, decision.fromJev));
      return decision;
    } catch {
      this.metrics.add(this.jevMetricsPatch(true, false));
      return fallback;
    }
  }

  /**
   * Record a real tool outcome against capability health. Hosts call this
   * from tool-result hooks; `tool` is the host's tool name (MCP tools arrive
   * as `{server}_{tool}`). Unknown prefixes are ignored so native tools
   * never pollute server health. Never throws.
   */
  recordCapabilityOutcome(input: { tool: string; ok: boolean; error?: string }): void {
    try {
      const tool = input.tool.trim();
      if (!tool) return;
      const server = this.lastMcpServerNames.find((name) => tool === name || tool.startsWith(`${name}_`));
      if (!server) return;
      const toolSuffix = tool === server ? undefined : tool.slice(server.length + 1);
      this.capabilityHealth.recordOutcome({
        server,
        ...(toolSuffix ? { tool: toolSuffix } : {}),
        ok: input.ok,
        ...(input.error ? { error: redactSecrets(input.error).text.slice(0, 200) } : {}),
      });
    } catch {
      // Observation must never break the host path.
    }
  }

  /** Capability health snapshot: availability, failures, tested tools (no network). */
  capabilitySnapshot(): CapabilityHealthSnapshot & { web: WebCapabilities } {
    const health = this.capabilityHealth.snapshot();
    const servers = { ...health.servers };
    for (const server of this.lastMcpServers) {
      if (servers[server.name]) continue;
      servers[server.name] = {
        availability:
          server.availability ??
          (server.connected ? "connected" : "configured"),
        consecutiveFailures: 0,
        successes: 0,
      };
    }
    return {
      ...health,
      servers,
      web: detectWebCapabilities(this.lastMcpServers),
    };
  }

  /** Decision-provider status surface for cortex-status / status CLI (no network). */
  jevStatus(): {
    enabled: boolean;
    configured: boolean;
    coolingDown: boolean;
    provider: string;
    model: string;
    state: DecisionState;
    reason?: string;
    latencyMs?: number;
  } {
    const enabled = this.config.jev.enabled;
    const provider = resolveDecisionProvider(this.config.jev);
    const apiKey = this.decisionApiKey(provider.apiKeyEnv);
    const health = this.decisionHealth();
    return {
      enabled,
      configured: enabled && (!provider.requireAuth || apiKey.trim().length > 0),
      coolingDown: this.jevClient?.coolingDown ?? false,
      provider: provider.id,
      model: provider.model,
      state: health.state,
      ...(health.reason ? { reason: health.reason } : {}),
      ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
    };
  }
  async compactMemory() {
    if (!this.enabled) return { kept: [], superseded: 0, expired: 0, auditTrail: [] };
    await this.init();
    const result = await this.memory.compact({
      sessionRetentionDays: this.config.memory.sessionRetentionDays,
    });
    // Durably persist the compaction audit trail so the operation is never
    // silent. Each entry records what changed and when, linked by a run ID.
    if (result.auditTrail.length > 0) {
      const runId = randomUUID();
      const auditEntries = result.auditTrail.map((entry) => ({
        runId,
        action: entry.action,
        entryId: entry.id,
        at: entry.at,
      }));
      try {
        await this.store.appendJsonl("memory/compaction-audit.jsonl", auditEntries);
      } catch {
        // Audit persistence is best-effort; the compaction itself is already done.
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Review workflow (candidate/disputed/stale -> active, edit, pin, forget)
  // -------------------------------------------------------------------------

  async review(action: import("./review-types.ts").ReviewAction): Promise<unknown> {
    if (!this.enabled || !this.config.memory.enabled) return { disabled: true };
    await this.init();
    const now = this.now();
    switch (action.type) {
      case "list":
        return this.memory.listByStatus(action.statuses ?? ["candidate"], action.limit ?? 100);
      case "approve": {
        // Before approving, verify that file evidence references are still valid
        // against the current index. This prevents persisting stale evidence.
        const entries = await this.memory.loadAll();
        const target = entries.find((e) => e.id === action.id);
        if (!target) return { error: "unknown id", id: action.id };
        const fileRefs = target.sourceReferences.filter((r) => r.kind === "file" && Boolean(r.hash));
        if (fileRefs.length > 0) {
          const index = await this.ensureIndex();
          const invalidRefs: Array<{ file: string; expected: string; actual: string | null }> = [];
          for (const ref of fileRefs) {
            const current = index.files[ref.value];
            if (!current) {
              invalidRefs.push({ file: ref.value, expected: ref.hash!, actual: null });
            } else if (current.hash !== ref.hash) {
              invalidRefs.push({ file: ref.value, expected: ref.hash!, actual: current.hash });
            }
          }
          if (invalidRefs.length > 0) {
            return { error: "evidence mismatch; file hashes changed since recording", invalidRefs };
          }
        }
        return this.memory.setStatus(action.id, "active", now);
      }
      case "refresh-evidence": {
        // Explicitly accept the current file state for an entry whose evidence
        // changed. This updates hashes only; it never activates the entry.
        const entries = await this.memory.loadAll();
        const target = entries.find((e) => e.id === action.id);
        if (!target) return { error: "unknown id", id: action.id };
        const fileRefs = target.sourceReferences.filter((r) => r.kind === "file" && Boolean(r.hash));
        if (fileRefs.length === 0) {
          // No hashed file evidence to compare: an explicit refresh is still a
          // valid re-confirmation for age-based re-verification prompts.
          const verified = await this.memory.markVerified(action.id, now);
          if (!verified) return { error: "unknown id", id: action.id };
          return { refreshed: false, verified: true, entryId: verified.id, status: verified.status };
        }
        const index = await this.ensureIndex();
        const missing: string[] = [];
        const refs: Array<{ file: string; oldHash: string; newHash: string }> = [];
        for (const ref of fileRefs) {
          const current = index.files[ref.value];
          if (!current) {
            // Absence is unverifiable: never invent a hash for a missing file.
            missing.push(ref.value);
          } else if (current.hash !== ref.hash) {
            refs.push({ file: ref.value, oldHash: ref.hash!, newHash: current.hash });
          }
        }
        if (missing.length > 0) {
          return { error: "evidence file missing; cannot refresh", missing };
        }
        if (refs.length === 0) {
          // Hashes already match, but the call still re-confirms the entry so
          // an age marker is cleared instead of persisting forever.
          const verified = await this.memory.markVerified(action.id, now);
          if (!verified) return { error: "unknown id", id: action.id };
          return { refreshed: false, verified: true, entryId: verified.id, status: verified.status };
        }
        const refreshed = await this.memory.refreshEvidence(action.id, refs, now);
        if (!refreshed) return { error: "unknown id", id: action.id };
        const storageBackend: "sqlite" | "jsonl" =
          typeof (this.store as { ftsSupported?: unknown }).ftsSupported === "function" ? "sqlite" : "jsonl";
        await this.store.appendJsonl("memory/review-audit.jsonl", [{
          runId: randomUUID(),
          entryId: refreshed.id,
          at: new Date(now).toISOString(),
          action: "refresh-evidence",
          refs,
          resultingStatus: refreshed.status,
          storageBackend,
          pluginVersion: this.pluginVersion,
        }]);
        return { refreshed: true, entryId: refreshed.id, status: refreshed.status, refs };
      }
      case "dispute":
        return this.memory.setStatus(action.id, "disputed", now);
      case "invalidate":
        return this.memory.setStatus(action.id, "stale", now);
      case "suppress":
        return this.memory.setStatus(action.id, "forgotten", now);
      case "pin":
        return this.memory.addTag(action.id, "pinned", now);
      case "purge":
        return { purged: await this.memory.purge(action.id) };
      case "edit":
        return this.memory.editEntry(
          action.id,
          { content: action.content, confidence: action.confidence, tags: action.tags },
          {
            requireEvidenceForDurableFacts: false,
            redactLikelySecrets: this.config.privacy.redactLikelySecrets,
            minimumConfidence: 0,
            projectRoot: this.projectRoot,
          },
          now,
        );
      default:
        return { error: "unknown review action" };
    }
  }

  // -------------------------------------------------------------------------
  // Safety brief (observed evidence only; never executes anything)
  // -------------------------------------------------------------------------

  async generateSafetyBrief(git?: GitChangeSummary): Promise<import("./review-types.ts").SafetyBrief | null> {
    if (!this.enabled) return null;
    await this.init();
    const { isSecretFile } = await import("./memory/validation.ts");
    const MANIFESTS = new Set(["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "requirements.txt", "pyproject.toml", "go.mod", "cargo.toml", "gemfile", "composer.json"]);
    const changed = git?.changedFiles ?? [];
    const base = (p: string) => p.split("/").pop()?.toLowerCase() ?? "";
    const memory = this.config.memory.enabled ? await this.memory.loadAll() : [];
    const unresolvedFailures = memory
      .filter((m) => m.kind === "failure" && m.status === "active")
      .slice(0, 50)
      .map((m) => ({ id: m.id, content: m.content }));
    const staleEvidence = memory
      .filter(
        (m) =>
          m.status === "stale" ||
          m.tags.includes("evidence-stale") ||
          m.needsReverifyAt !== undefined,
      )
      .slice(0, 50)
      .map((m) => ({ id: m.id, content: m.content }));
    const activeTasks = await this.reconciler.loadActive(this.now());
    let testEvents = 0;
    try {
      const evts = await this.events.list({ kinds: ["test.observed", "task.completed"], limit: 100 });
      testEvents = evts.length;
    } catch { /* events optional */ }
    return {
      generatedAt: new Date(this.now()).toISOString(),
      changedFiles: changed.slice(0, 200),
      dependencyManifestChanges: changed.filter((p) => MANIFESTS.has(base(p))).slice(0, 50),
      secretRiskFiles: changed.filter((p) => isSecretFile(p)).slice(0, 50),
      unresolvedFailures,
      staleEvidence,
      openTasks: activeTasks.map((t) => t.taskId).slice(0, 100),
      testsObserved: testEvents > 0,
    };
  }

  // -------------------------------------------------------------------------
  // Importers (preview-first; candidates only, never auto-active)
  // -------------------------------------------------------------------------

  async importPreview(source: string, path: string): Promise<import("./importers/index.ts").ImportResult> {
    if (!this.enabled) return { candidates: [], skipped: ["disabled"] };
    const { readImportSource } = await import("./importers/index.ts");
    return readImportSource(source, path, this.projectRoot);
  }

  async importCommit(source: string, path: string): Promise<{ staged: number; skipped: number }> {
    if (!this.enabled || !this.config.memory.enabled) return { staged: 0, skipped: 0 };
    await this.init();
    const preview = await this.importPreview(source, path);
    const existing = await this.memory.loadAll();
    const seen = new Set(existing.map((e) => e.content.slice(0, 200)));
    let staged = 0;
    for (const cand of preview.candidates) {
      if (seen.has(cand.content.slice(0, 200))) continue;
      const res = await this.memory.record(cand, {
        requireEvidenceForDurableFacts: false,
        redactLikelySecrets: this.config.privacy.redactLikelySecrets,
        minimumConfidence: 0,
        projectRoot: this.projectRoot,
        now: this.now(),
      });
      if (res.status === "recorded") { staged++; seen.add(cand.content.slice(0, 200)); }
    }
    return { staged, skipped: preview.skipped.length };
  }

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------

  planTasks(descriptors: TaskDescriptor[]): TaskPlan | null {
    if (!this.enabled || !this.config.parallelism.enabled) return null;
    const plan = planTasks(descriptors, {
      maxConcurrentTasks: this.config.parallelism.maxConcurrentTasks,
      defaultBudgetTokens: Math.floor(this.config.context.maxTokens / 2),
    });
    // Metrics: duplicate assignments detected.
    const dup = plan.duplicateGroups.reduce((acc, g) => acc + Math.max(0, g.length - 1), 0);
    this.metrics.add({ duplicateAssignmentsDetected: dup });
    return plan;
  }

  async claimFiles(
    taskId: string,
    files: string[],
    opts: { sessionId?: string; title?: string } = {},
  ) {
    if (!this.enabled) return { granted: [], denied: [] };
    await this.init();
    // Register/refresh the task as active (heartbeat) and bind its session so
    // the sweeper can reap it if the session dies or it goes silent.
    await this.reconciler.touch(taskId, opts, this.now());
    const incarnationId = (await this.reconciler.loadActive(this.now())).find((t) => t.taskId === taskId)?.incarnationId;
    return this.ownership.claim(taskId, files, {
      incarnationId,
      sessionId: opts.sessionId,
      ttlMinutes: this.config.staleness.ownershipTtlMinutes,
      now: this.now(),
    });
  }

  /** Refresh a task's heartbeat to prevent it being reaped as abandoned. */
  async heartbeat(taskId: string, opts: { sessionId?: string } = {}): Promise<{ renewed: string[]; lost: string[] }> {
    if (!this.enabled) return { renewed: [], lost: [] };
    await this.init();
    const now = this.now();
    // Both mutations are individually serialized by their managers. Renew
    // first so a caller never receives a fresh task heartbeat while silently
    // continuing with an expired write lease.
    const renewal = await this.ownership.renew(taskId, {
      sessionId: opts.sessionId,
      ttlMinutes: this.config.staleness.ownershipTtlMinutes,
      now,
    });
    // mint:false — a heartbeat refreshes an existing task but never
    // resurrects one the sweeper has already reaped. Only explicit
    // registration (claimFiles/planner) creates an active record, so a
    // revival queued behind the reap's lock cannot undo its destructive act.
    if (renewal.lost.length === 0) await this.reconciler.touch(taskId, opts, now, { mint: false });
    return renewal;
  }

  async activeTasks() { await this.init(); return this.reconciler.loadActive(this.now()); }

  async releaseFiles(
    taskId: string,
    leaseId: string,
    fencingToken: number,
    files?: string[],
  ): Promise<{ released: string[] }> {
    if (!this.enabled) return { released: [] };
    await this.init();
    // Defense-in-depth: this is a public API other adapters may call
    // directly. A non-array, non-undefined `files` (bare string, number,
    // object) must never reach ownership.releaseLease's `.includes` call.
    const safeFiles =
      files === undefined
        ? undefined
        : Array.isArray(files)
          ? files
          : typeof files === "string"
            ? [files]
            : [];
    const released = await this.ownership.releaseLease(
      taskId,
      leaseId,
      fencingToken,
      safeFiles,
    );
    return { released };
  }

  // -------------------------------------------------------------------------
  // Cache validation
  // -------------------------------------------------------------------------

  async validateCache() {
    if (!this.enabled) return { valid: [], stale: [], missing: [] };
    const index = await this.ensureIndex();
    const all = await this.cache.all();
    const report = validateCache(all, index.files);
    await this.cache.invalidateAgainstIndex(index.files);
    return report;
  }

  // -------------------------------------------------------------------------
  // Metrics + health
  // -------------------------------------------------------------------------

  metricsSnapshot(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  /**
   * Metrics annotated with their origin. Host-reported token/cost fields are
   * `host-observed`; locally estimated fields are `estimated`; cache fields
   * reported by a provider are `provider-observed`. This lets consumers avoid
   * presenting an estimate as a measured billing value.
   */
  annotatedMetrics(): AnnotatedMetrics {
    const snap = this.metrics.snapshot();
    const hasHostUsage = snap.hostInputTokens > 0 || snap.hostOutputTokens > 0 || snap.hostReasoningTokens > 0;
    return {
      ...snap,
      origins: {
        estimatedTokensSelected: "estimated",
        estimatedTokensExcluded: "estimated",
        contextPacketTokens: "estimated",
        hostInputTokens: hasHostUsage ? "host-observed" : "unavailable",
        hostOutputTokens: hasHostUsage ? "host-observed" : "unavailable",
        hostReasoningTokens: hasHostUsage ? "host-observed" : "unavailable",
        providerCacheReadTokens: snap.providerCacheReadTokens > 0 ? "provider-observed" : "unavailable",
        providerCacheWriteTokens: snap.providerCacheWriteTokens > 0 ? "provider-observed" : "unavailable",
        hostReportedCost: snap.hostReportedCost > 0 ? "host-observed" : "unavailable",
      },
    };
  }

  async persistMetrics(): Promise<void> {
    if (!this.enabled) return;
    await this.init();
    await this.store.writeJson(
      `metrics/session-${new Date(this.now()).toISOString().slice(0, 10)}.json`,
      this.metrics.snapshot(),
    );
    await this.pruneSessionMetrics();
  }

  /**
   * Best-effort retention pruning for the daily session-metric snapshots.
   * Never throws and never blocks dispose: failures are swallowed and logged at
   * debug level when a logger is available. Non-matching filenames are never
   * removed. Runs at most once per dispose (this path is once-per-dispose).
   */
  private async pruneSessionMetrics(): Promise<void> {
    try {
      const retentionDays = this.config.telemetry.sessionMetrics.retentionDays;
      if (retentionDays <= 0) return;
      const cutoff = this.now() - retentionDays * 86_400_000;
      for (const path of await this.store.listFiles("metrics")) {
        const name = path.slice("metrics/".length);
        const date = sessionFileDate(name);
        if (date && date.getTime() < cutoff) await this.store.remove(path);
      }
    } catch (err) {
      // retention pruning is opportunistic; never surface past dispose
      (this as { debug?: (msg: string) => void }).debug?.(
        `session metrics prune failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Persist one completed host-reported cumulative usage snapshot as an
   * append-only delta event. The ledger contains no prompt, response, tool
   * argument, or tool-result content.
   */
  async recordHostUsage(
    observation: HostUsageObservation,
  ): Promise<{ recorded: boolean; duplicate: boolean }> {
    if (
      !this.enabled ||
      this.config.telemetry.mode === "off" ||
      this.config.telemetry.maxEvents < 1 ||
      this.config.telemetry.maxAgeDays < 1
    ) {
      return { recorded: false, duplicate: false };
    }
    await this.init();
    const cleanId = (value: string, max = 200) =>
      redactSecrets(String(value)).text.replace(/[\r\n]/g, " ").slice(0, max);
    const number = (value: number) =>
      Number.isFinite(value) ? Math.max(0, value) : 0;
    const integer = (value: number) => Math.floor(number(value));
    const cumulative = {
      reportedCost: number(observation.reportedCost),
      inputTokens: integer(observation.inputTokens),
      outputTokens: integer(observation.outputTokens),
      reasoningTokens: integer(observation.reasoningTokens),
      cacheReadTokens: integer(observation.cacheReadTokens),
      cacheWriteTokens: integer(observation.cacheWriteTokens),
    };
    const identity = {
      messageId: cleanId(observation.messageId, 120),
      sessionId: cleanId(observation.sessionId, 120),
      provider: cleanId(observation.provider),
      model: cleanId(observation.model),
      cumulative,
    };
    const eventKey = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    const now = this.now();
    const parsedObservedAt = Date.parse(observation.observedAt ?? "");
    const observedAtMs = Number.isFinite(parsedObservedAt) && parsedObservedAt <= now
      ? parsedObservedAt
      : now;
    const observedAt = new Date(observedAtMs).toISOString();
    const cutoff = now - this.config.telemetry.maxAgeDays * 86_400_000;
    if (observedAtMs < cutoff) return { recorded: false, duplicate: false };

    const release = await this.store.acquireLock("provider-usage");
    try {
      const ledger = await this.store.readJsonl<ProviderUsageEvent>(
        "metrics/provider-usage.jsonl",
      );
      const validEvents = ledger.entries.filter(isProviderUsageEvent);
      if (validEvents.some((event) => event.eventKey === eventKey)) {
        return { recorded: false, duplicate: true };
      }
      const prior = validEvents
        .filter((event) => event.messageId === identity.messageId)
        .at(-1)?.cumulative;
      const delta = {
        reportedCost: Math.max(0, cumulative.reportedCost - (prior?.reportedCost ?? 0)),
        inputTokens: Math.max(0, cumulative.inputTokens - (prior?.inputTokens ?? 0)),
        outputTokens: Math.max(0, cumulative.outputTokens - (prior?.outputTokens ?? 0)),
        reasoningTokens: Math.max(0, cumulative.reasoningTokens - (prior?.reasoningTokens ?? 0)),
        cacheReadTokens: Math.max(0, cumulative.cacheReadTokens - (prior?.cacheReadTokens ?? 0)),
        cacheWriteTokens: Math.max(0, cumulative.cacheWriteTokens - (prior?.cacheWriteTokens ?? 0)),
      };
      const event: ProviderUsageEvent = {
        schemaVersion: 2,
        eventKey,
        source: "opencode-host",
        ...identity,
        observedAt,
        currency: null,
        cumulative,
        delta,
      };
      const retained = validEvents.filter((existing) => {
        const timestamp = Date.parse(existing.observedAt);
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      });
      retained.push(event);
      const bounded = retained.slice(-this.config.telemetry.maxEvents);
      const needsRewrite =
        ledger.corruptLines > 0 ||
        validEvents.length !== ledger.entries.length ||
        bounded.length !== validEvents.length + 1;
      if (needsRewrite) {
        await this.store.rewriteJsonl("metrics/provider-usage.jsonl", bounded);
      } else {
        await this.store.appendJsonl("metrics/provider-usage.jsonl", [event]);
      }
      // Emit a lightweight link row correlating the task to this usage event.
      // ProviderUsageEvent carries no task identity, which is why the link row
      // exists. Best-effort: never breaks the host usage path.
      await this.recordProviderUsageLink({
        eventKey,
        messageId: identity.messageId,
        sessionId: identity.sessionId,
      });
      this.metrics.add({
        hostInputTokens: delta.inputTokens,
        hostOutputTokens: delta.outputTokens,
        hostReasoningTokens: delta.reasoningTokens,
        providerCacheReadTokens: delta.cacheReadTokens,
        providerCacheWriteTokens: delta.cacheWriteTokens,
        hostReportedCost: delta.reportedCost,
      });
      return { recorded: true, duplicate: false };
    } finally {
      await release();
    }
  }

  async memoryCounts(): Promise<Record<string, number>> {
    if (!this.enabled) return {};
    return this.memory.counts();
  }

  // ---------------------------------------------------------------------------
  // Value measurement (correlational only). Controlled by
  // telemetry.valueMeasurement.enabled (default ON). All of these are
  // best-effort: they never throw to the host, never block the host event
  // path, never corrupt an outcome record, and never write the session metrics
  // file. When disabled they are pure no-ops.
  // ---------------------------------------------------------------------------

  /** Resolve the strongest task identity we can from explicit ids or a session. */
  private async resolveTaskIdentityFromActive(input: { taskId?: string; incarnationId?: string; sessionId?: string }): Promise<{ taskId?: string; incarnationId?: string }> {
    const active = await this.reconciler.loadActive(this.now());
    if (input.taskId) {
      // An explicitly supplied incarnationId wins outright (callers know their
      // own key); otherwise fall back to the authoritative active-task table.
      if (input.incarnationId) return { taskId: input.taskId, incarnationId: input.incarnationId };
      const found = active.find((t) => t.taskId === input.taskId);
      return found
        ? { taskId: found.taskId, incarnationId: found.incarnationId }
        : { taskId: input.taskId };
    }
    if (input.sessionId) {
      const candidates = active.filter((t) => t.sessionId === input.sessionId);
      const latest = candidates.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))[0];
      if (latest) return { taskId: latest.taskId, incarnationId: latest.incarnationId };
    }
    return {};
  }

  private async resolveTaskIdentity(input: { taskId?: string; incarnationId?: string; sessionId?: string }): Promise<{ taskId?: string; incarnationId?: string }> {
    try {
      await this.init();
      const resolved = await this.resolveTaskIdentityFromActive(input);
      const sessionId = input.sessionId;
      if (sessionId && resolved.taskId) {
        this.rememberSessionTask(sessionId, resolved.taskId, resolved.incarnationId);
        return resolved;
      }
      if (sessionId && !resolved.taskId) {
        // The task may have just been completed and removed from the active
        // table; fall back to the most recent task we resolved for this session.
        const hint = this.sessionTaskHints.get(sessionId);
        if (hint) return { taskId: hint.taskId, incarnationId: hint.incarnationId };
      }
      return resolved;
    } catch {
      return {};
    }
  }

  /** Record the most recent (taskId, incarnationId) for a session, bounded. */
  private rememberSessionTask(sessionId: string, taskId: string, incarnationId?: string): void {
    this.sessionTaskHints.set(sessionId, { taskId, incarnationId, atMs: this.now() });
    if (this.sessionTaskHints.size > 500) {
      const entries = [...this.sessionTaskHints.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
      for (const [key] of entries.slice(0, entries.length - 500)) this.sessionTaskHints.delete(key);
    }
  }

  /** Record whether SupraCortex context was injected this turn (one row per turn). */
  async recordContextInjection(input: {
    injected: boolean;
    sessionId?: string;
    taskId?: string;
    incarnationId?: string;
  }): Promise<ContextInjectionEvent | null> {
    if (!this.enabled || !this.config.telemetry.valueMeasurement.enabled) return null;
    try {
      await this.init();
      const identity = await this.resolveTaskIdentity(input);
      const event: ContextInjectionEvent = {
        schemaVersion: 1,
        eventType: "context_injection",
        recordedAt: new Date(this.now()).toISOString(),
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
        ...(identity.incarnationId ? { incarnationId: identity.incarnationId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        supracortex: { "supracortex.context.injected": input.injected },
      };
      return (await this.valueMetrics.append(event)) as ContextInjectionEvent | null;
    } catch {
      return null;
    }
  }

  /**
   * Record a tool execution. latencyMs is measured. retryCount is the number of
   * repeated executions of the same tool with the same arguments hash within one
   * task (0 = first run); it is a heuristic and is always marked estimated.
   */
  async recordToolExecution(input: {
    tool: string;
    latencyMs: number;
    retryCount: number;
    argumentsHash?: string;
    sessionId?: string;
    taskId?: string;
    incarnationId?: string;
  }): Promise<ToolExecutionEvent | null> {
    if (!this.enabled || !this.config.telemetry.valueMeasurement.enabled) return null;
    try {
      await this.init();
      const identity = await this.resolveTaskIdentity(input);
      const latency = Number.isFinite(input.latencyMs) && input.latencyMs >= 0 ? Math.round(input.latencyMs) : 0;
      const retry = Number.isFinite(input.retryCount) && input.retryCount >= 0 ? Math.floor(input.retryCount) : 0;
      const event: ToolExecutionEvent = {
        schemaVersion: 1,
        eventType: "tool_execution",
        recordedAt: new Date(this.now()).toISOString(),
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
        ...(identity.incarnationId ? { incarnationId: identity.incarnationId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.argumentsHash ? { argumentsHash: input.argumentsHash } : {}),
        genAi: { "gen_ai.operation.name": input.tool },
        supracortex: {
          "supracortex.latency_ms": latency,
          "supracortex.retry.count": retry,
        },
        estimated: true,
        estimatedFields: ["supracortex.retry.count"],
      };
      return (await this.valueMetrics.append(event)) as ToolExecutionEvent | null;
    } catch {
      return null;
    }
  }

  /**
   * Lightweight link row correlating (taskId, incarnationId) to the existing
   * provider-usage ledger via eventKey/messageId. ProviderUsageEvent carries no
   * task identity, which is exactly why this link exists.
   */
  private async recordProviderUsageLink(input: {
    eventKey: string;
    messageId: string;
    sessionId: string;
  }): Promise<ProviderUsageLinkEvent | null> {
    if (!this.enabled || !this.config.telemetry.valueMeasurement.enabled) return null;
    try {
      const identity = await this.resolveTaskIdentity({ sessionId: input.sessionId });
      const event: ProviderUsageLinkEvent = {
        schemaVersion: 1,
        eventType: "provider_usage_link",
        recordedAt: new Date(this.now()).toISOString(),
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
        ...(identity.incarnationId ? { incarnationId: identity.incarnationId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        eventKey: input.eventKey,
        messageId: input.messageId,
      };
      return (await this.valueMetrics.append(event)) as ProviderUsageLinkEvent | null;
    } catch {
      return null;
    }
  }

  /** Record a task_outcome row. Best-effort; never breaks outcome recording. */
  private async recordTaskOutcome(input: {
    taskId: string;
    incarnationId?: string;
    status: OutcomeStatus;
    source: "agent" | "inferred";
  }): Promise<TaskOutcomeEvent | null> {
    if (!this.enabled || !this.config.telemetry.valueMeasurement.enabled) return null;
    try {
      const event: TaskOutcomeEvent = {
        schemaVersion: 1,
        eventType: "task_outcome",
        recordedAt: new Date(this.now()).toISOString(),
        taskId: input.taskId,
        ...(input.incarnationId ? { incarnationId: input.incarnationId } : {}),
        source: input.source,
        supracortex: { "supracortex.task.status": input.status },
      };
      return (await this.valueMetrics.append(event)) as TaskOutcomeEvent | null;
    } catch {
      return null;
    }
  }

  private async readUsageLedgerIndex(): Promise<Map<string, ProviderUsageEvent>> {
    try {
      const byKey = new Map<string, ProviderUsageEvent>();
      const tail = await this.store.readJsonlTail<ProviderUsageEvent>("metrics/provider-usage.jsonl", 2000);
      for (const event of tail.entries) {
        if (isProviderUsageEvent(event)) byKey.set(event.eventKey, event);
      }
      return byKey;
    } catch {
      return new Map();
    }
  }

  /**
   * Aggregation happens ON READ from the bounded tail of the value-events file.
   * Returns the same stable shape whether or not measurement is enabled; when
   * disabled every metric is absent and the comparison is refused.
   */
  async valueReport(): Promise<ValueReport> {
    if (!this.enabled || !this.config.telemetry.valueMeasurement.enabled) {
      return {
        enabled: false,
        boundedTail: true,
        unattributed: { rows: 0, distinctTaskIds: 0 },
        unclassifiedTasks: 0,
        segments: { injected: null, notInjected: null },
        sample: { injected: 0, notInjected: 0 },
        comparisonRendered: false,
        refusalReason:
          "measurement is disabled; enable telemetry.valueMeasurement.enabled to collect data",
        correlationLabel: VALUE_CORRELATION_LABEL,
      };
    }
    await this.init();
    const events = await this.valueMetrics.readTail();
    const usageByKey = await this.readUsageLedgerIndex();
    return buildValueReport(events, usageByKey);
  }

  async activeTaskCount(): Promise<number> {
    if (!this.enabled) return 0;
    return this.reconciler.activeCount();
  }

  async storageSizeBytes(): Promise<number> {
    return this.store.totalSizeBytes();
  }

  async writeHealth(patch: Partial<HealthState>): Promise<void> {
    const existing = (await this.store.readJson<HealthState>(HEALTH_FILE)) ?? {
      version: this.pluginVersion,
      schemaVersion: 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const next: HealthState = {
      ...existing,
      ...patch,
      version: this.pluginVersion,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.store.writeJson(HEALTH_FILE, next);
  }

  async readHealth(): Promise<HealthState | null> {
    return this.store.readJson<HealthState>(HEALTH_FILE);
  }

  async recordError(message: string): Promise<void> {
    await this.writeHealth({ lastError: { message, at: new Date(this.now()).toISOString() } });
  }

  /** Reconcile ownership after a crash/restart. */
  async reconcile(): Promise<{ released: string[] }> {
    if (!this.enabled) return { released: [] };
    await this.init();
    return this.reconciler.reconcileOwnership();
  }

  // -------------------------------------------------------------------------
  // SupraSpace interop (unified memory + graph export)
  // -------------------------------------------------------------------------

  private supraStore(): SupraSpaceStore | null {
    if (!this.config.supraspace.enabled) return null;
    try {
      return new SupraSpaceStore(this.projectRoot, this.config.supraspace.directory);
    } catch {
      return null;
    }
  }

  /**
   * Two-way sync with SupraSpace's `.supraspace/*.md` memory:
   *  1. INGEST free-form (non-managed) notes as candidate memory (deduped).
   *  2. PROJECT structured memory back into marker-fenced managed blocks.
   * Loop-safe (managed blocks are never re-ingested). Idempotent (no-op writes
   * are skipped). Returns a report; never throws to the caller.
   */
  async syncSupraSpace(): Promise<SupraSpaceSyncReport> {
    const now = this.now();
    const report: SupraSpaceSyncReport = {
      ranAt: new Date(now).toISOString(),
      filesWritten: [],
      projectedEntries: 0,
      ingestedCandidates: 0,
      ingestedRecorded: 0,
    };
    if (!this.enabled) {
      report.skippedReason = "disabled";
      return report;
    }
    const cfg = this.config.supraspace;
    if (!cfg.enabled) {
      report.skippedReason = "supraspace disabled";
      return report;
    }
    const store = this.supraStore();
    if (!store || !(await store.exists())) {
      report.skippedReason = "no .supraspace directory";
      return report;
    }
    await this.init();

    const contents = await store.readAll();

    // 1. Ingest free-form notes -> candidate memory.
    if (cfg.ingestNotes && this.config.memory.enabled) {
      const candidates = ingestFromFiles(contents, cfg.ingestConfidence);
      report.ingestedCandidates = candidates.length;
      const existing = await this.memory.loadAll();
      for (const c of candidates) {
        if (isDuplicate(c, existing)) continue;
        const res = await this.memory.record(
          {
            kind: c.kind,
            content: c.content,
            confidence: c.confidence,
            tags: c.tags,
            origin: c.origin,
          },
          {
            requireEvidenceForDurableFacts: false,
            redactLikelySecrets: this.config.privacy.redactLikelySecrets,
            minimumConfidence: 0,
            projectRoot: this.projectRoot,
            now,
          },
        );
        if (res.status === "recorded") {
          report.ingestedRecorded++;
          this.metrics.add({ rawFindingsPersisted: 1 });
        }
      }
    }

    // 2. Project structured memory -> .supraspace managed blocks.
    if (cfg.projectMemory) {
      const all = await this.memory.loadAll();
      const plan = planProjection(all, contents, now);
      report.projectedEntries = plan.projectedEntries;
      for (const [file, next] of plan.writes) {
        await store.write(file, next);
        report.filesWritten.push(file);
      }
    }

    // Refresh the persisted graph so external visualizers see current state.
    try {
      await this.exportGraph();
    } catch {
      /* best-effort */
    }

    return report;
  }

  /**
   * Export the structured state (memory + active tasks + ownership) as a typed
   * nodes/edges graph for external visualizers (e.g. the SupraSpace galaxy).
   * Also persists it to `.supracortex/graph.json` so external tools
   * (SupraSpace's server) can read the latest graph without invoking the CLI.
   */
  async exportGraph(): Promise<GraphExport | null> {
    return (await this.exportSnapshot())?.graph ?? null;
  }

  /** Export the complete, versioned read model used by SupraSpace and the vault. */
  async exportSnapshot(): Promise<CortexSnapshot | null> {
    if (!this.enabled) return null;
    await this.init();
    const memory = this.config.memory.enabled ? await this.memory.loadAll() : [];
    const activeTasks = await this.reconciler.loadActive(this.now());
    const ownership = await this.ownership.load(this.now());
    const graph = buildGraphExport({ memory, activeTasks, ownership, now: this.now() });
    // A malformed derived graph must never block the authoritative memory/task
    // snapshot. The graph store itself fails closed; here we omit it so
    // SupraSpace can continue rendering the last safe intelligence state.
    let codeGraph: CodeGraph | undefined;
    if (this.config.graph.enabled) {
      try { codeGraph = await this.codeGraph.readActive() ?? undefined; } catch { /* omit invalid derived state */ }
    }
    const snapshot: CortexSnapshot = { schemaVersion: 1, generatedAt: graph.generatedAt, graph, ...(codeGraph ? { codeGraph } : {}), memory, activeTasks, ownership };
    await this.store.writeJson("snapshot.json", snapshot);
    await this.store.writeJson("graph.json", graph);
    await this.writeVault(snapshot);
    return snapshot;
  }

  /** Regenerate the Obsidian-compatible vault from an authoritative snapshot. */
  private async writeVault(snapshot: CortexSnapshot): Promise<CortexVaultManifest> {
    const { files, manifest } = buildVaultProjection(snapshot);
    const root = join(this.store.root, "vault");
    const previous = await this.store.readJson<CortexVaultManifest>("vault-manifest.json");
    await mkdir(root, { recursive: true });
    // Write the next complete generation first. The manifest is the activation
    // point; a reader either sees the previous coherent manifest or this one,
    // never an intentionally emptied vault directory.
    for (const [relative, content] of files) {
      const path = join(root, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    await this.store.writeJson("vault-manifest.json", manifest);
    // Only after activation, remove notes no longer owned by the projection.
    const current = new Set(manifest.files.map((file) => file.path));
    for (const file of previous?.files ?? []) {
      if (!current.has(file.path)) await this.store.remove(`vault/${file.path}`);
    }
    return manifest;
  }
}
