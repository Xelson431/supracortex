/**
 * Public API for @local/supracortex-core.
 *
 * This package has ZERO imports from OpenCode. The OpenCode adapter
 * consumes this surface and injects a StorageAdapter + environment data.
 */

export * from "./types.ts";
export {
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  CONFIG_FIELD_REGISTRY,
  DEPRECATED_UNIMPLEMENTED_PATHS,
  buildDefaultTemplate,
  flattenConfig,
  applyModePreset,
  resolveConfig,
  projectScopedConfig,
  detectStorageDriver,
  PROJECT_SCOPED_PATHS,
  mergeConfig,
  validateConfig,
  unknownConfigKeys,
  deepClone,
  RENAMED_CONFIG_KEYS,
  REMOVED_CONFIG_KEYS,
} from "./config.ts";
export type {
  Config,
  PartialConfig,
  Mode,
  ResolvedConfig,
  ResolveInput,
  StorageDriver,
  TelemetryMode,
  TelemetryConfig,
  ValueMeasurementConfig,
  EventsConfig,
  GraphConfig,
  ConfigFieldRegistryEntry,
  ConfigFieldStability,
} from "./config.ts";

export {
  PACKAGE_VERSION,
  TOOLSET_API_VERSION,
  CONFIG_SCHEMA_VERSION,
  STORAGE_SCHEMA_VERSION,
  MEMORY_RECORD_VERSION,
  CONTEXT_PACKET_VERSION,
  EVENT_SCHEMA_VERSION,
  METRICS_EVENT_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  VAULT_MANIFEST_VERSION,
  HANDOFF_SCHEMA_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
  CODE_GRAPH_EXTRACTOR_VERSION,
} from "../../../src/version.ts";

export { Engine } from "./engine.ts";
export type { EngineOptions, GatherInputs } from "./engine.ts";

export type { StorageAdapter, HistoryManager, JsonlAppendResult, JsonlReadResult } from "./storage/storage-adapter.ts";
export { JsonlStore } from "./storage/jsonl-store.ts";
export { createSqliteStore } from "./storage/sqlite-store.ts";
export { runMigrations, readVersion } from "./storage/migrations.ts";
export { ensureRuntimeGitignore } from "./storage/runtime-gitignore.ts";
export { migrateJsonlToSqlite } from "./storage/migrate.ts";
export type { MigrateResult } from "./storage/migrate.ts";

export { MemoryManager, CONTRADICTION_THRESHOLD, findContradiction } from "./memory/manager.ts";
export type { RecordOptions, RecordResult } from "./memory/manager.ts";
export { decideMemoryTransition, allMemoryTransitionPairs, requiresResolution, isUnresolvedCandidate } from "./memory/transitions.ts";
export type { MemoryTransitionDecision } from "./memory/transitions.ts";
export type { NewMemoryInput, BuildOptions, BuildResult, RecordClassification } from "./memory/schemas.ts";
export { buildMemoryEntry, classifyRecord, MAX_CONTENT_CHARS, MAX_ARRAY_ITEMS, MAX_REF_ITEMS } from "./memory/schemas.ts";
export { redactSecrets, containsLikelySecret, isSecretFile, safeRelative, resolveProjectStorageDirectory } from "./memory/validation.ts";
export { retrieveMemory } from "./memory/retrieval.ts";
export { scoreMemory, scoreFile, buildQueryContext, tokenize } from "./memory/ranking.ts";
export { compactMemory, enforceLineBudget, MAX_LINES } from "./memory/compaction.ts";
export type { CompactionOptions, CompactionResult } from "./memory/compaction.ts";
export { pruneSessionMetrics, sessionFileDate, selectBudgetOverflow } from "./metrics/session-prune.ts";

export { buildIndex, hashContent, INDEX_VERSION } from "./context/repository-indexer.ts";
export { summarizeFile, extractSymbols, detectLanguage } from "./context/summaries.ts";
export { buildContextPacket } from "./context/builder.ts";
export { TokenBudget } from "./context/token-budget.ts";
export {
  selectFiles,
  resolveCompactionTrigger,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_FLOOR_BUFFER_TOKENS,
} from "./context/selector.ts";
export type { SelectorOptions, SelectorResult, CompactionTrigger } from "./context/selector.ts";
export {
  CONTEXT_WIRE_ESTIMATOR,
  isContextPacketV2,
  projectContextPacketV2,
  secondReadBilledTokens,
  estimateWireTextTokens,
  describeWireBudget,
} from "./context/wire-budget.ts";
export type { WireBudgetDescription } from "./context/wire-budget.ts";
export { classifySummaries } from "./context/invalidation.ts";

export {
  CODE_GRAPH_LIMITS,
  CodeGraphIntegrityError,
  decodeCodeGraph,
  decodeCodeGraphManifest,
} from "./graph/schema.ts";
export { buildCodeGraph } from "./graph/builder.ts";
export { CodeGraphStore } from "./graph/store.ts";
export { graphNeighbors, graphExplain, graphPath, graphImpact, resolveCodeGraphSelector } from "./graph/query.ts";

export { ContextCache } from "./cache/context-cache.ts";
export { validateCache } from "./cache/invalidation.ts";
export { contextKey } from "./cache/cache-key.ts";

export { JevClient, DEFAULT_JEV_CLIENT_CONFIG, sumUsage } from "./jev/client.ts";
export type { JevClientConfig, JevCallResult, JevCallUsage, JevFetch } from "./jev/client.ts";
export { DecisionBudget } from "./jev/budget.ts";
export { CapabilityHealth } from "./capabilities/health.ts";
export type {
  CapabilityAvailability,
  CapabilityOutcome,
  ServerHealth,
  CapabilityHealthSnapshot,
} from "./capabilities/health.ts";
export {
  isWebSearchTool,
  isWebFetchTool,
  detectWebCapabilities,
} from "./capabilities/web.ts";
export type { WebCapabilities } from "./capabilities/web.ts";
export {
  validateDecisionsResponse,
  validateUsage,
  validateAnswer,
  validateQuestions,
  readChoice,
  readNoul,
  readScore,
  scoreToCandidateRelevance,
  readDepthBucket,
  readMemoryVerdict,
  readMemoryKind,
} from "./jev/validate.ts";
export {
  routingQuestions,
  skillMcpQuestions,
  rerankQuestions,
  rerankScale,
  graphQuestions,
  memoryJudgmentQuestions,
  reviewQuestions,
  JEV_GRAPH_OPERATIONS,
} from "./jev/questions.ts";
export {
  jevRoute,
  jevSelectSkillsMcp,
  jevRerankMemories,
  jevRerankPaths,
  jevSelectGraph,
  jevJudgeMemory,
  jevReview,
  fallbackRouting,
  JEV_MIN_CONFIDENCE,
} from "./jev/router.ts";
export { JEV_MODEL, JEV_SYSTEMONE_URL, JEV_DECISIONS_URL } from "./jev/types.ts";
export {
  DECISION_PROVIDER_IDS,
  DECISION_PROVIDER_PRESETS,
  LEGACY_DEFAULT_MODEL,
  isDecisionProviderId,
  resolveDecisionProvider,
  effectiveDecisionTiming,
} from "./jev/providers.ts";
export {
  resolveCredential,
  readEnvAssignment,
  USER_CREDENTIALS_DIR,
  SYSTEM_CREDENTIAL_FILES,
  OPENCODE_LOGIN_PROVIDERS,
  opencodeAuthFile,
  readOpencodeLogin,
  writeCredential,
  removeCredential,
} from "./jev/credentials.ts";
export type { CredentialLookup, ResolvedCredential } from "./jev/credentials.ts";
export type {
  DecisionProviderId,
  DecisionProviderPreset,
  DecisionProviderInput,
  ResolvedDecisionProvider,
} from "./jev/providers.ts";
export type {
  JevDepthBucket,
  JevMemoryVerdict,
  JevMemoryKind,
  JevQuestion,
  JevChoiceQuestion,
  JevNoulQuestion,
  JevScoreQuestion,
  JevDecisionsRequest,
  JevDecisionsResponse,
  JevDecisionsUsage,
  JevAnswer,
  JevChoiceAnswer,
  JevNoulAnswer,
  JevScoreAnswer,
  JevCandidateScore,
  JevRoutingDecision,
  JevSkillMcpDecision,
  JevGraphDecision,
  JevMemoryJudgment,
  JevReviewDecision,
  JevFailureReason,
} from "./jev/types.ts";

export { planTasks } from "./orchestration/scheduler.ts";
export { buildTaskGraph } from "./orchestration/task-graph.ts";
export { parallelSafety, detectOverlaps } from "./orchestration/parallel-safety.ts";
export {
  detectDuplicateTasks,
  detectDuplicateReads,
} from "./orchestration/duplicate-detector.ts";
export { OwnershipManager, planOwnership } from "./orchestration/ownership.ts";
export { Reconciler } from "./orchestration/reconciler.ts";
export { Sweeper } from "./orchestration/sweeper.ts";
export type { SweepInput } from "./orchestration/sweeper.ts";

export { SupraSpaceStore, SUPRASPACE_FILES, isSupraSpaceFile } from "./supraspace/store.ts";
export {
  planProjection,
  composeFileContent,
  stripManagedBlock,
  ingestFromFiles,
  isDuplicate,
  normalizeFingerprint,
  PROJECTED_FILES,
  BLOCK_BEGIN,
  BLOCK_END,
} from "./supraspace/projector.ts";
export type { IngestCandidate, ProjectionPlan } from "./supraspace/projector.ts";
export { buildGraphExport } from "./supraspace/graph.ts";
export type { GraphExportInput } from "./supraspace/graph.ts";
export { buildVaultProjection } from "./vault/projector.ts";

export { recommendSkills } from "./skills/registry.ts";
export type { SkillRecommendInput, SkillRecommendResult } from "./skills/registry.ts";
export { selectMcpTools, AGENT_MCP_PROFILE } from "./mcp/selector.ts";
export type { McpSelectInput, McpSelectResult } from "./mcp/selector.ts";

export { MetricsCollector, emptySnapshot, emptyExtras } from "./metrics/collector.ts";
export type { MeasurementExtras } from "./metrics/collector.ts";
export { estimateTokens, estimateBytesTokens, measureTokens, measureTokensAsync, loadTiktokenESM, preloadTiktoken } from "./metrics/token-estimator.ts";
export type { TokenMeasureResult } from "./metrics/token-estimator.ts";
export { formatMetrics, formatBilledVsEstimated } from "./metrics/report.ts";
export * from "./metrics/value/index.ts";
export { EventStore } from "./events/store.ts";
export { normalizeEvent } from "./events/normalizer.ts";
export type { StructuralEvent, StructuralEventKind } from "./events/types.ts";

export { resolveProviderCachePolicy } from "./provider-cache.ts";
export type { ResolveProviderCachePolicyInput } from "./provider-cache.ts";
export {
  normalizeProviderUsage,
  mapFlatUsageToNested,
} from "./provider-cache.ts";
export type {
  NativeUsageFields,
  NormalizedBilledUsage,
} from "./provider-cache.ts";
export { runDiagnostics, readJsonlTail, sanitizeDiagnostics, safeReadFile, freshnessHours, isStaleFreshness, formatFreshness, formatHandshake, HEALTH_STALE_AFTER_HOURS, HANDSHAKE_SLOW_MS, HANDSHAKE_BUDGET_MS, STILL_BOOTING_CODE, HANDSHAKE_PROTOCOL_VERSION } from "./diagnostics/index.ts";
export type { DiagnosticCheck, DiagnosticInput, DiagnosticStatus, Evidence, TailResult } from "./diagnostics/index.ts";
export {
  PROJECT_DIR as CONFIG_PROJECT_DIR,
  CONFIG_FILENAME,
  projectConfigPath,
  globalConfigPath,
  stripJsonc,
  readConfigFile,
  loadConfigLayers,
} from "./config-files.ts";
export type { ConfigLayers, StorageDriverSource } from "./config-files.ts";
