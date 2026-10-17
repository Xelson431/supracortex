/**
 * Core type definitions for supracortex.
 *
 * This module has ZERO runtime imports from OpenCode. It defines the
 * data model shared across memory, context, cache, orchestration and metrics.
 *
 * Constraint: this repo runs under Node's native TypeScript type-stripping
 * (`erasableSyntaxOnly`). Do not use enums, namespaces, or parameter properties.
 * Use string-literal unions and plain `const` objects instead.
 */

// ---------------------------------------------------------------------------
// Memory model
// ---------------------------------------------------------------------------

export type MemoryKind =
  | "fact"
  | "decision"
  | "convention"
  | "failure"
  | "constraint"
  | "task-outcome";

export type MemoryStatus = "active" | "superseded" | "stale" | "disputed" | "candidate" | "forgotten";

export type SourceReferenceKind = "file" | "commit" | "command" | "external" | "session";

export interface SourceReference {
  kind: SourceReferenceKind;
  /** Project-relative normalized path, commit sha, URL, or command string. */
  value: string;
  /** Optional line range for file references. */
  lines?: [number, number];
  /** Content hash of the source at the time the reference was recorded. */
  hash?: string;
  note?: string;
}

export type InvalidationRuleKind =
  | "file-hash-changed"
  | "file-deleted"
  | "time-elapsed"
  | "manual";

export interface InvalidationRule {
  kind: InvalidationRuleKind;
  /** For file-* rules: project-relative path. For time-elapsed: ISO expiry. */
  target?: string;
  expiresAt?: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  /**
   * ISO time this entry was flagged as due for re-verification (age-based).
   * Advisory only: it never changes `status`, so the entry stays retrievable.
   */
  needsReverifyAt?: string;
  /** 0..1. Confidence that this entry is currently true. */
  confidence: number;
  status: MemoryStatus;
  sourceReferences: SourceReference[];
  relatedFiles: string[];
  relatedSymbols: string[];
  tags: string[];
  invalidationRules: InvalidationRule[];
  supersedes?: string[];
  /** Optional origin marker, e.g. "agent:explorer" or "user". Never a transcript. */
  origin?: string;
}

/** A memory entry paired with the reason it was selected for a context packet. */
export interface MemorySelection {
  entry: MemoryEntry;
  score: number;
  reason: string;
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Repository index
// ---------------------------------------------------------------------------

export interface IndexedFile {
  /** Project-relative normalized path. */
  path: string;
  hash: string;
  sizeBytes: number;
  estimatedTokens: number;
  language?: string;
  symbols: string[];
  /** Lightweight import hints (regex-extracted): relative specifiers normalized
   * to project-relative paths, package specifiers kept verbatim. Not semantic. */
  imports: string[];
  /** ISO time the file was last indexed. */
  indexedAt: string;
  /** mtime in ms as reported by the filesystem when indexed. */
  mtimeMs: number;
}

export interface RepositoryIndex {
  version: number;
  root: string;
  generatedAt: string;
  files: Record<string, IndexedFile>;
  /** Reverse import hints: path -> paths that import it. Rebuilt each full index. */
  reverseImports?: Record<string, string[]>;
  /**
   * True when every indexed file had its bytes read and hashed this run. False
   * when one or more files were served from the mtime+size fast path without a
   * byte-level re-hash (see `unverifiedFiles`).
   */
  verified?: boolean;
  /** Count of files whose hash was reused without reading bytes. */
  unverifiedFiles?: number;
}

// ---------------------------------------------------------------------------
// Derived code knowledge graph (V1)
// ---------------------------------------------------------------------------

/** V1 deliberately contains only facts proven by the local repository index. */
export type CodeGraphNodeKind = "repository" | "directory" | "file" | "symbol";
export type CodeGraphEdgeKind = "contains" | "defines" | "imports";
export type CodeGraphProvenance = "repository-index";

export interface CodeGraphNode {
  id: string;
  kind: CodeGraphNodeKind;
  label: string;
  path?: string;
  symbol?: string;
  language?: string;
  sourceHash?: string;
  provenance: CodeGraphProvenance;
  confidence: "extracted";
  extractorVersion: number;
}

export interface CodeGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: CodeGraphEdgeKind;
  provenance: CodeGraphProvenance;
  confidence: "extracted";
  /** Project-relative source path for the relation; never an absolute path. */
  sourcePath: string;
  sourceHash: string;
}

export interface CodeGraphOmission {
  code: "unresolved-import" | "node-limit" | "edge-limit";
  count: number;
}

export interface CodeGraphAccounting {
  indexedFiles: number;
  nodes: number;
  edges: number;
  unresolvedImports: number;
}

export interface CodeGraph {
  schemaVersion: number;
  extractorVersion: number;
  generationId: string;
  projectFingerprint: string;
  repositoryId: string;
  generatedAt: string;
  /** Digest of sorted project-relative paths and current content hashes. */
  sourceWatermark: string;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  omissions: CodeGraphOmission[];
  accounting: CodeGraphAccounting;
}

export interface CodeGraphManifest {
  schemaVersion: number;
  generationId: string;
  sourceWatermark: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
}

export type CodeGraphSelector = `node:${string}` | `path:${string}` | `symbol:${string}`;
export interface CodeGraphQueryLimits {
  maxDepth?: number;
  maxResults?: number;
  maxFanout?: number;
}

// ---------------------------------------------------------------------------
// Summaries + cache
// ---------------------------------------------------------------------------

export interface FileSummary {
  path: string;
  /** Hash of the source content this summary was derived from. */
  sourceHash: string;
  summary: string;
  estimatedTokens: number;
  createdAt: string;
}

export interface CacheReport {
  hits: number;
  misses: number;
  stale: number;
  entries: number;
}

// ---------------------------------------------------------------------------
// Context packet
// ---------------------------------------------------------------------------

export type FileSelectionMode = "full" | "summary" | "reference";

export interface FileSelection {
  path: string;
  mode: FileSelectionMode;
  /**
   * Legacy V1 planning charge. This is the cost of the selected packet item,
   * not necessarily the cost of the referenced source file.
   */
  estimatedTokens: number;
  /** Estimated tokens in the source body when this is a read recommendation. */
  estimatedSourceTokens?: number;
  score: number;
  reason: string;
  hash?: string;
}

export interface SummarySelection {
  path: string;
  summary: string;
  sourceHash: string;
  verified: boolean;
  estimatedTokens: number;
  reason: string;
}

export interface GitChangeSummary {
  branch?: string;
  changedFiles: string[];
  staged: string[];
  untracked: string[];
  ahead?: number;
  behind?: number;
}

export type OmissionReason =
  | "budget-exhausted"
  | "excluded-binary"
  | "excluded-gitignored"
  | "excluded-secret"
  | "excluded-generated"
  | "low-relevance"
  | "outside-project"
  | "unchanged-cached";

export interface ContextOmission {
  path: string;
  reason: OmissionReason;
  detail?: string;
}

export interface ContextBudget {
  maxTokens: number;
  usedTokens: number;
  remainingTokens: number;
}

export interface SkillRecommendation {
  name: string;
  reason: string;
  priority: number;
  intendedAgent?: string;
  needsLoad: boolean;
}

export interface SkillExclusion {
  name: string;
  reason: string;
}

export interface McpToolRecommendation {
  server: string;
  tool?: string;
  purpose: string;
  mutating: boolean;
  requiresApproval: boolean;
  estimatedSchemaTokens?: number;
}

export interface McpExclusion {
  server: string;
  reason: string;
}

export interface ContextPacket {
  taskId: string;
  taskSummary: string;
  selectedMemory: MemorySelection[];
  selectedFiles: FileSelection[];
  selectedSummaries: SummarySelection[];
  currentGitChanges?: GitChangeSummary;
  constraints: string[];
  knownFailures: string[];
  estimatedTokens: number;
  budget: ContextBudget;
  cacheReport: CacheReport;
  omissions: ContextOmission[];
  recommendedSkills: SkillRecommendation[];
  excludedSkills: SkillExclusion[];
  recommendedMcpTools: McpToolRecommendation[];
  excludedMcpServers: McpExclusion[];
  generatedAt: string;
}

/** ContextPacketV2 describes data that may actually be serialized to a host. */
export type ContextMemoryOriginV2 =
  | "explicit-user"
  | "local-source"
  | "agent-candidate"
  | "imported";

export interface ContextMemoryEvidenceV2 {
  id: string;
  kind: string;
  text: string;
  origin: ContextMemoryOriginV2;
  evidenceState: "verified" | "user-authenticated";
  automaticEligibility: true;
  reason: string;
}

export interface ContextSummaryEvidenceV2 {
  path: string;
  text: string;
  sourceHash: string;
  reason: string;
}

export interface ContextInlineSourceV2 {
  path: string;
  text: string;
  sourceHash: string;
  range?: [number, number];
  reason: string;
}

export interface ContextReadRecommendationV2 {
  path: string;
  sourceHash: string;
  estimatedSourceTokens: number;
  reason: string;
}

export interface ContextOmissionV2 {
  subject: string;
  reasonCode: string;
  detail?: string;
}

export interface ContextPacketAccountingV2 {
  maxPayloadTokens: number;
  /** Estimate over the final serialized adapter payload, not source bodies. */
  payloadTokensEstimated: number;
  /** Planning estimate for all evidence/source candidates represented here. */
  sourceTokensConsideredEstimated: number;
  /** Planning estimate for bodies that are recommended for a future read. */
  sourceTokensRecommendedEstimated: number;
  estimator: string;
}

/**
 * Frozen V2 semantic shape. Adapter renderers may return separate transport
 * measurements (for example UTF-8 bytes), but may not blur those measurements
 * with source-token planning estimates.
 */
export interface ContextSkillGuidanceV2 {
  name: string;
  reason: string;
}

export interface ContextMcpGuidanceV2 {
  server: string;
  tool?: string;
  purpose: string;
}

export interface ContextPacketV2 {
  schemaVersion: 2;
  taskId: string;
  evidence: {
    memory: ContextMemoryEvidenceV2[];
    summaries: ContextSummaryEvidenceV2[];
    inlineSources: ContextInlineSourceV2[];
  };
  recommendations: {
    reads: ContextReadRecommendationV2[];
    /** Jev/deterministic skill guidance that survived final budget selection. */
    skills: ContextSkillGuidanceV2[];
    /** Jev/deterministic MCP guidance that survived final budget selection. */
    mcpTools: ContextMcpGuidanceV2[];
  };
  omissions: ContextOmissionV2[];
  accounting: ContextPacketAccountingV2;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Task input + orchestration
// ---------------------------------------------------------------------------

/** Explicit host boundary: MCP tools are not native prompt hooks. */
export type CapabilityLevel = "supported" | "experimental" | "unsupported" | "unknown";
export interface HostCapabilities {
  host: "opencode" | "codex" | "claude-code" | "pi" | "kiro" | "mcp" | "unknown";
  integration: "native" | "mcp-tools-only" | "none";
  readUserTask: CapabilityLevel;
  injectRequestContext: CapabilityLevel;
  observeUsage: CapabilityLevel;
  observeCost: CapabilityLevel;
  observeCompaction: CapabilityLevel;
  setProviderOptions: CapabilityLevel;
  setCacheBreakpoints: CapabilityLevel;
  lifecycleEvents: CapabilityLevel;
  operationParity: CapabilityLevel;
  evidence?: string[];
}

export interface TaskInput {
  taskId?: string;
  /** Natural-language description of the task/objective. */
  query: string;
  /** Optional explicit files the caller already knows are relevant. */
  hintFiles?: string[];
  /** Optional tags to bias retrieval. */
  tags?: string[];
  /** Optional token budget override for this call. */
  maxTokens?: number;
}

export interface PlannedTask {
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  readScope: string[];
  writeScope: string[];
  suggestedAgentRole?: string;
  contextBudgetTokens: number;
  parallelSafe: boolean;
  parallelSafetyReason: string;
  completionCriteria: string[];
}

export interface TaskPlan {
  tasks: PlannedTask[];
  /** Ordered execution waves; each wave is a list of task ids safe to run together. */
  waves: string[][];
  duplicateGroups: string[][];
  warnings: string[];
}

export interface TaskDescriptor {
  id?: string;
  title: string;
  objective: string;
  readScope?: string[];
  writeScope?: string[];
  suggestedAgentRole?: string;
  dependencies?: string[];
  completionCriteria?: string[];
}

// ---------------------------------------------------------------------------
// File ownership
// ---------------------------------------------------------------------------

/** A single write-ownership claim with staleness metadata. */
export interface OwnershipClaim {
  taskId: string;
  incarnationId?: string;
  claimedAt: string;
  /** Opaque generation identifier shared by every path in an atomic lease. */
  leaseId?: string;
  /** Monotonically increasing generation; stale workers must not act on it. */
  fencingToken?: number;
  /** Last successful lease renewal. Absent on legacy records. */
  renewedAt?: string;
  /** Optional owning session; used to reap claims of dead sessions. */
  sessionId?: string;
  /** Optional absolute-time expiry (ISO). After this the claim is stale. */
  expiresAt?: string;
}

export interface FileOwnership {
  /** path -> claim. */
  claims: Record<string, OwnershipClaim>;
  updatedAt: string;
  /** Next monotonic fencing generation; retained across expiry/reaping. */
  nextFencingToken?: number;
}

export interface OwnershipClaimResult {
  granted: string[];
  denied: Array<{ path: string; heldBy: string }>;
  leaseId?: string;
  fencingToken?: number;
  incarnationId?: string;
}

export interface OwnershipRenewalResult {
  renewed: string[];
  /** Claims that were absent, expired, or bound to a different session. */
  lost: string[];
}

/** An active task with liveness metadata for staleness detection. */
export interface ActiveTaskRecord {
  taskId: string;
  incarnationId?: string;
  startedAt: string;
  /** Heartbeat: updated whenever the task shows progress. */
  lastSeenAt: string;
  sessionId?: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type OutcomeStatus = "success" | "failure" | "partial";

export interface TaskOutcome {
  /** Stable retry identity. When omitted, Engine derives one from safe fields. */
  operationId?: string;
  taskId: string;
  incarnationId?: string;
  source?: "agent" | "inferred";
  status: OutcomeStatus;
  summary: string;
  touchedFiles: string[];
  learnings?: string[];
  failureReason?: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Every token/cost/latency metric must identify whether it is observed,
 * estimated, derived, or unavailable. Missing data is `null + unavailable`,
 * never `0`. This prevents false precision in savings/cost reports.
 */
export type MetricOrigin = "host-observed" | "provider-observed" | "estimated" | "derived" | "unavailable";

export interface TokenMeasure {
  value: number | null;
  unit: "tokens";
  origin: MetricOrigin;
  source?: string;
}

export interface CostMeasure {
  value: number | null;
  currency: string | null;
  origin: MetricOrigin;
  source?: string;
}

/** Jev decision-model telemetry. All additive within a session. Zero when Jev is off. */
export interface JevMetrics {
  /** Jev-assisted context preparations (any Jev decision applied). */
  decisionsApplied: number;
  /** Context preparations that fell back to deterministic behavior. */
  fallbacks: number;
  /** Jev HTTP calls issued (excluding cache hits and coalesced joins). */
  calls: number;
  /** Jev cache hits (bounded decision cache). */
  cacheHits: number;
  /** Consecutive provider failures observed (resets on success). */
  consecutiveFailures: number;
  /** Validated Jev usage totals. */
  inputTokens: number;
  outputTokens: number;
  /** Billed cost reported by the provider (informational only). */
  cost: number;
}

export function emptyJevMetrics(): JevMetrics {
  return {
    decisionsApplied: 0,
    fallbacks: 0,
    calls: 0,
    cacheHits: 0,
    consecutiveFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };
}

export interface MetricsSnapshot {
  eventsCaptured: number;
  handoffsCreated: number;
  resumesConsumed: number;
  evidenceStaleMarked: number;
  filesConsidered: number;
  filesOpened: number;
  unchangedFilesSkipped: number;
  cacheHits: number;
  cacheMisses: number;
  staleSummariesRejected: number;
  duplicateReadsDetected: number;
  duplicateAssignmentsDetected: number;
  estimatedTokensSelected: number;
  estimatedTokensExcluded: number;
  memoryEntriesConsidered: number;
  memoryEntriesSelected: number;
  contextPacketTokens: number;
  skillsConsidered: number;
  skillsRecommended: number;
  duplicateSkillLoadsAvoided: number;
  mcpServersConsidered: number;
  mcpServersSelected: number;
  mcpToolsSelected: number;
  duplicateResearchAvoided: number;
  rawFindingsPersisted: number;
  jevDecisionsApplied: number;
  jevFallbacks: number;
  jevCalls: number;
  jevCacheHits: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  hostInputTokens: number;
  hostOutputTokens: number;
  hostReasoningTokens: number;
  providerCacheReadTokens: number;
  providerCacheWriteTokens: number;
  hostReportedCost: number;
}

/**
 * Metrics annotated with their origin so consumers can distinguish observed
 * from estimated values. The plain {@link MetricsSnapshot} remains backward
 * compatible; this richer view is returned by `annotatedMetrics()`.
 */
export interface AnnotatedMetrics extends MetricsSnapshot {
  origins: {
    estimatedTokensSelected: MetricOrigin;
    estimatedTokensExcluded: MetricOrigin;
    contextPacketTokens: MetricOrigin;
    hostInputTokens: MetricOrigin;
    hostOutputTokens: MetricOrigin;
    hostReasoningTokens: MetricOrigin;
    providerCacheReadTokens: MetricOrigin;
    providerCacheWriteTokens: MetricOrigin;
    hostReportedCost: MetricOrigin;
  };
}

export interface HostUsageObservation {
  messageId: string;
  sessionId: string;
  provider: string;
  model: string;
  observedAt?: string;
  reportedCost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderUsageEvent {
  schemaVersion: 2;
  eventKey: string;
  source: "opencode-host";
  messageId: string;
  sessionId: string;
  provider: string;
  model: string;
  observedAt: string;
  currency: null;
  cumulative: {
    reportedCost: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  delta: {
    reportedCost: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export interface HandoffCapsule {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  projectFingerprint: string;
  eventWatermark: string | null;
  goal: string;
  completedWork: string[];
  changedFiles: Array<{ path: string; hash: string | null }>;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  failures: string[];
  openRisks: string[];
  nextActions: string[];
  evidenceIds: string[];
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Skills + MCP metadata (lightweight)
// ---------------------------------------------------------------------------

export type SkillScope = "project" | "global" | "builtin";

export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
  scope: SkillScope;
  contentHash: string;
  estimatedTokens: number;
  triggers?: string[];
  compatibleAgents?: string[];
  modifiedAt?: string;
}

export type McpServerType = "local" | "remote";

export interface McpToolMetadata {
  name: string;
  description?: string;
  mutating: boolean;
  sensitive: boolean;
  estimatedSchemaTokens?: number;
}

/**
 * Lifecycle state of an MCP server as last observed by the host.
 * Distinct by design: "configured" (known from config only), "connected"
 * (host reports a live connection, implies authenticated), "tested" (a tool
 * call succeeded in this process), "failed" (in failure cooldown).
 */
export type McpServerAvailability = "configured" | "connected" | "tested" | "failed";

export interface McpServerMetadata {
  name: string;
  type: McpServerType;
  enabled: boolean;
  connected?: boolean;
  requiresAuth: boolean;
  tools: McpToolMetadata[];
  /** Host-observed availability; absent means "configured" (never seen live). */
  availability?: McpServerAvailability;
  /** ISO timestamp of the last host observation. */
  lastCheckedAt?: string;
}

// ---------------------------------------------------------------------------
// Graph export (for external visualizers, e.g. SupraSpace galaxy graph)
// ---------------------------------------------------------------------------

export type GraphNodeKind =
  | "root"
  | "memory-kind"
  | "fact"
  | "decision"
  | "convention"
  | "failure"
  | "constraint"
  | "task-outcome"
  | "task"
  | "file"
  | "session";

export interface GraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  /** Depth from root (0 root, 1 grouping, 2 entity, 3 detail). */
  depth: number;
  /** Optional 0..1 weight (confidence / relevance) for sizing. */
  weight?: number;
  /** Optional status for coloring (e.g. active/disputed/stale). */
  status?: string;
  /** Optional extra metadata; kept small and non-sensitive. */
  meta?: Record<string, string | number | boolean>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** Optional relationship label (e.g. "supersedes", "touches", "owns"). */
  relation?: string;
}

export interface GraphExport {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Small summary for headers/legends. */
  stats: {
    memoryEntries: number;
    activeTasks: number;
    ownedFiles: number;
  };
}

/** Stable, read-only export consumed by SupraSpace and vault visualizers. */
export interface CortexSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  graph: GraphExport;
  /** Optional, derived file/symbol/import graph. Never authoritative memory. */
  codeGraph?: CodeGraph;
  memory: MemoryEntry[];
  activeTasks: ActiveTaskRecord[];
  ownership: FileOwnership | null;
}

/** Manifest for the generated Obsidian-compatible Markdown projection. */
export interface CortexVaultManifest {
  schemaVersion: 1;
  generatedAt: string;
  snapshotGeneratedAt: string;
  files: Array<{ path: string; entityId?: string; kind: string }>;
}

// ---------------------------------------------------------------------------
// SupraSpace bridge
// ---------------------------------------------------------------------------

/** The six fixed SupraSpace memory files. */
export type SupraSpaceMemoryFile =
  | "project.md"
  | "architecture.md"
  | "decisions.md"
  | "tasks.md"
  | "agent-notes.md"
  | "review-notes.md";

export interface SupraSpaceSyncReport {
  ranAt: string;
  /** Files whose managed block was written/updated. */
  filesWritten: SupraSpaceMemoryFile[];
  /** Count of memory entries projected into .supraspace files. */
  projectedEntries: number;
  /** Count of candidate entries ingested from .supraspace free-form text. */
  ingestedCandidates: number;
  /** Ingested candidates that were actually recorded (passed dedup/policy). */
  ingestedRecorded: number;
  skippedReason?: string;
}


// ---------------------------------------------------------------------------
// Provider cache policy
// ---------------------------------------------------------------------------

/**
 * Provider cache mode.
 * - `"host-managed"`: the host/provider manages caching (model context protocol
 *   cache_control, prompt caching, etc.). Core should not inject cache options.
 * - `"observe-only"`: the host does not manage caching; core observes cache
 *   metrics but does not mutate provider options.
 * - `"optimize-safe"`: core may inject cache-optimizing provider options when
 *   the host explicitly supports `setCacheBreakpoints` and the provider family
 *   is on the allowlist. Gated experimental in this release (no mutation yet).
 */
export type ProviderCacheMode = "host-managed" | "observe-only" | "optimize-safe";

/**
 * Resolved provider cache policy intent emitted by the core. The adapter
 * translates this into host-specific actions.
 */
export interface ProviderCachePolicyIntent {
  mode: ProviderCacheMode;
  /** SHA-256 hex digest of project identity + privacy dimension. */
  projectKeyDigest: string;
  /** SHA-256 hex digest of stable prefix + privacy dimension. */
  stablePrefixDigest: string;
  /**
   * Optional requested TTL for cache entries (e.g. "1h", "30m"). Omitted when
   * `zeroDataRetention` forces observe-only mode — never request extended TTL
   * that violates privacy policy.
   */
  requestedTtl?: string;
}

export interface HealthState {
  version: string;
  schemaVersion: number;
  lastError?: { message: string; at: string } | null;
  lastIndexedAt?: string | null;
  lastSweepAt?: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Staleness sweep
// ---------------------------------------------------------------------------

export interface SweepReport {
  ranAt: string;
  reason: string;
  abandonedTasks: string[];
  releasedOwnership: string[];
  expiredSessions: string[];
  prunedCacheEntries: number;
  memoryFlaggedForReverify: string[];
  prunedCompletedTasks: number;
  /** Lock dirs removed by the force-quit garbage collector (dead owners). */
  collectedLocks: string[];
  /** True if the sweep made no changes (system already clean). */
  clean: boolean;
}
