/**
 * Configuration model, defaults, mode presets, and precedence resolution.
 *
 * Precedence (highest first):
 *   1. emergency disable env var (SUPRACORTEX_DISABLE)
 *   2. explicit runtime override (passed programmatically)
 *   3. project configuration (.supracortex/config.jsonc)
 *   4. global configuration
 *   5. built-in defaults
 *
 * SUPRACORTEX_ENABLE is supported but ranks BELOW the emergency
 * disable var; disable always wins to guarantee a safe kill switch.
 */

export type Mode = "off" | "minimal" | "balanced" | "aggressive" | "custom";
export type StorageDriver = "jsonl" | "sqlite";

export type TelemetryMode = "off" | "local";

export interface StorageConfig {
  driver: StorageDriver;
  directory: string;
  commitDurableMemory: boolean;
  maxStorageMb: number;
}

export interface MemoryConfig {
  enabled: boolean;
  automaticRecording: boolean;
  minimumConfidence: number;
  maxRetrievedEntries: number;
  maxRetrievedTokens: number;
  sessionRetentionDays: number;
  requireEvidenceForDurableFacts: boolean;
}

export interface ContextConfig {
  enabled: boolean;
  maxTokens: number;
  searchBeforeRead: boolean;
  preferChangedFiles: boolean;
  includeGitDiff: boolean;
  maxRecommendedReads: number;
  summaryThresholdTokens: number;
}

export interface CacheConfig {
  enabled: boolean;
  hashAlgorithm: "sha256";
  validateBeforeUse: boolean;
  maxAgeDays: number;
}

/** Experimental derived code graph. Explicit operations only in V1. */
export interface GraphConfig {
  enabled: boolean;
  maxNodes: number;
  maxEdges: number;
  maxQueryResults: number;
  automaticContext: boolean;
}

export interface ParallelismConfig {
  enabled: boolean;
  maxConcurrentTasks: number;
  preventOverlappingWrites: boolean;
  requireFileOwnership: boolean;
  useWorktreesForConflicts: boolean;
}

export interface EfficiencyConfig {
  detectDuplicateReads: boolean;
  detectDuplicateAssignments: boolean;
  trackApproximateTokens: boolean;
  compactCompletedTasks: boolean;
}

export interface IntegrationConfig {
  automaticContextPreparation: boolean;
  automaticOutcomeRecording: boolean;
  parallelPlanning: boolean;
}

/**
 * Decision-model integration (provider-agnostic; preview branch only).
 * Enabled by default; network calls require the provider's credential env var
 * (`OPENROUTER_API_KEY` for Jev). The provider selects among caller-supplied
 * candidates; existing deterministic behavior is the fallback for every
 * failure mode. `jev` is the legacy section name and default provider id.
 */
export interface JevConfig {
  /** Master switch. Default true; explicit false disables provider calls. */
  enabled: boolean;
  /**
   * Decision provider: "jev" (OpenRouter), "laya-local" (self-hosted
   * laya-serve), "laya-hosted" (explicit endpoint required), or "custom".
   * See `packages/core/src/jev/providers.ts` for presets.
   */
  provider: string;
  /** Decision deadline per call in ms. -1 (default) = provider default; no retries. */
  deadlineMs: number;
  /**
   * Decision model id. Default typesafe/jev-1.13 — treated as "unset" for
   * non-custom providers, which then use their preset model. Any explicitly
   * chosen id always wins.
   */
  model: string;
  /** Minimum confidence to act on an answer; below this, fall back. Default 0.6. */
  minConfidence: number;
  /**
   * Shared wall-clock budget (ms) across one context request's sequential
   * decision calls. -1 (default) = provider default; 0 skips all enrichment.
   */
  enrichmentBudgetMs: number;
  /**
   * Explicit decisions endpoint. Empty inherits the provider preset.
   * Required for "laya-hosted" and "custom".
   */
  endpoint: string;
  /** Env var holding the bearer credential. Empty inherits the preset. */
  apiKeyEnv: string;
  /** "auto" follows the preset; "bearer" requires a key; "none" sends none. */
  auth: string;
  /**
   * Substring the response model must include. Empty inherits the preset
   * ("jev" for Jev, "laya" for Laya).
   */
  modelMatch: string;
  /**
   * Optional env-style file holding the credential (parsed, never sourced).
   * Empty uses the default lookup: process env, then
   * `~/.config/supracortex/*.env`, then well-known system files.
   */
  credentialsFile: string;
}

export interface PrivacyConfig {
  redactEnvironmentValues: boolean;
  redactLikelySecrets: boolean;
  storeConversationText: boolean;
}

export interface TelemetryConfig {
  mode: TelemetryMode;
  maxEvents: number;
  maxAgeDays: number;
  /**
   * Local-only "value measurement" (correlational only). Default ON.
   * When disabled, no collection happens, no new files are created, and runtime
   * behaviour is byte-identical to today. This is NOT an A/B or experiment
   * harness — it only records whether context was injected, tool latency/retries,
   * provider usage links, and task outcomes, and never claims causation.
   */
  valueMeasurement: ValueMeasurementConfig;
  /**
   * Retention for per-day session metric snapshots (`metrics/session-*.json`).
   * Files older than this many days are pruned at the next engine dispose.
   * 0 disables pruning (keep forever). A negative value is rejected at validation.
   */
  sessionMetrics: SessionMetricsConfig;
}
export interface ValueMeasurementConfig {
  enabled: boolean;
  maxEvents: number;
  maxAgeDays: number;
}
export interface SessionMetricsConfig {
  retentionDays: number;
}
export interface EventsConfig {
  enabled: boolean;
  maxEvents: number;
  maxAgeDays: number;
  maxSizeMb: number;
}

/**
 * Staleness / garbage-collection policy. OpenCode exposes no timer hook, so the
 * sweep runs opportunistically (engine init, session.idle, session.deleted).
 * All windows are in minutes; 0 disables that particular reaper.
 */
export interface StalenessConfig {
  enabled: boolean;
  /** Active task with no heartbeat for this long is considered abandoned. */
  taskHeartbeatTimeoutMinutes: number;
  /** File ownership claim older than this (and no live task) is force-released. */
  ownershipTtlMinutes: number;
  /** Session working state older than this is purged. */
  sessionTtlMinutes: number;
  /** Cache summaries past cache.maxAgeDays are pruned during sweep too. */
  pruneStaleCacheOnSweep: boolean;
  /** Re-mark durable memory as needing re-verification after this many days. */
  memoryReverifyDays: number;
  /** Drop completed-task log rows older than this many days (audit retention). */
  completedTaskRetentionDays: number;
}

/**
 * SupraSpace interop. When enabled and a `.supraspace/` folder is present, Cortex
 * projects its structured memory into the six SupraSpace Markdown files (inside
 * marker-fenced managed blocks) and can ingest free-form human/agent notes from
 * them. This unifies the two memory systems instead of running them in parallel.
 */
export interface SupraSpaceConfig {
  enabled: boolean;
  /** Directory name to look for (relative to project root). */
  directory: string;
  /** Write Cortex memory into .supraspace/*.md managed blocks. */
  projectMemory: boolean;
  /** Ingest free-form (non-managed) .supraspace notes as candidate memory. */
  ingestNotes: boolean;
  /** Minimum confidence assigned to ingested candidates. */
  ingestConfidence: number;
  /** Sync automatically during the staleness sweep. */
  syncOnSweep: boolean;
}

export interface Config {
  enabled: boolean;
  mode: Mode;
  storage: StorageConfig;
  memory: MemoryConfig;
  context: ContextConfig;
  cache: CacheConfig;
  graph: GraphConfig;
  parallelism: ParallelismConfig;
  efficiency: EfficiencyConfig;
  jev: JevConfig;
  integration: IntegrationConfig;
  privacy: PrivacyConfig;
  telemetry: TelemetryConfig;
  staleness: StalenessConfig;
  supraspace: SupraSpaceConfig;
  events: EventsConfig;
}

export type PartialConfig = {
  [K in keyof Config]?: Config[K] extends object ? Partial<Config[K]> : Config[K];
};

import { CONFIG_SCHEMA_VERSION } from "../../../src/version.ts";

/** @deprecated Use CONFIG_SCHEMA_VERSION. */
export const SCHEMA_VERSION = CONFIG_SCHEMA_VERSION;

export type ConfigFieldStability = "stable" | "experimental" | "deprecated-unimplemented";
export interface ConfigFieldRegistryEntry {
  owner: string;
  default: unknown;
  stability: ConfigFieldStability;
  securityImpact: "none" | "privacy" | "integrity" | "availability";
  functionalTest: string;
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  mode: "balanced",
  storage: {
    driver: "jsonl",
    directory: ".supracortex",
    commitDurableMemory: false,
    maxStorageMb: 250,
  },
  memory: {
    enabled: true,
    automaticRecording: true,
    minimumConfidence: 0.65,
    maxRetrievedEntries: 20,
    maxRetrievedTokens: 4000,
    sessionRetentionDays: 14,
    requireEvidenceForDurableFacts: true,
  },
  context: {
    enabled: true,
    maxTokens: 12000,
    searchBeforeRead: true,
    preferChangedFiles: true,
    includeGitDiff: true,
    maxRecommendedReads: 6,
    summaryThresholdTokens: 3000,
  },
  cache: {
    enabled: true,
    hashAlgorithm: "sha256",
    validateBeforeUse: true,
    maxAgeDays: 30,
  },
  graph: {
    enabled: true,
    maxNodes: 50_000,
    maxEdges: 200_000,
    maxQueryResults: 50,
    // Automatic graph hints are experimental: they apply only when a graph
    // generation exists AND this flag is true (codeGraphStatus reports the
    // effective value). The default is false, so graph navigation stays
    // explicit via the cortex_graph_* tools unless a project opts in.
    automaticContext: false,
  },
  parallelism: {
    enabled: true,
    maxConcurrentTasks: 4,
    preventOverlappingWrites: true,
    requireFileOwnership: true,
    useWorktreesForConflicts: false,
  },
  jev: {
    // Missing credentials or provider failures fall back to deterministic retrieval.
    enabled: true,
    provider: "jev",
    // -1 = use the provider's measured default (Jev 800 ms, local Laya 2 500
    // ms). Any explicit value wins. The fetch is aborted at the deadline.
    deadlineMs: -1,
    // Empty = the provider preset's model (typesafe/jev-1.13 for Jev).
    model: "",
    minConfidence: 0.6,
    enrichmentBudgetMs: -1,
    endpoint: "",
    apiKeyEnv: "",
    auth: "auto",
    modelMatch: "",
    credentialsFile: "",
  },
  efficiency: {
    detectDuplicateReads: true,
    detectDuplicateAssignments: true,
    trackApproximateTokens: true,
    compactCompletedTasks: true,
  },
  integration: {
    automaticContextPreparation: true,
    automaticOutcomeRecording: true,
    parallelPlanning: true,
  },
  privacy: {
    redactEnvironmentValues: true,
    redactLikelySecrets: true,
    storeConversationText: false,
  },
  telemetry: {
    mode: "local",
    maxEvents: 50_000,
    maxAgeDays: 30,
    // Local measurement only; events remain bounded by maxEvents/maxAgeDays.
    valueMeasurement: {
      enabled: true,
      maxEvents: 20_000,
      maxAgeDays: 30,
    },
    // Daily session-metric snapshots are pruned past this age on engine dispose.
    // 0 disables pruning (keep forever); negatives are rejected at validation.
    sessionMetrics: { retentionDays: 90 },
  },
  staleness: {
    enabled: true,
    taskHeartbeatTimeoutMinutes: 30,
    ownershipTtlMinutes: 60,
    sessionTtlMinutes: 60,
    pruneStaleCacheOnSweep: true,
    memoryReverifyDays: 90,
    completedTaskRetentionDays: 30,
  },
  supraspace: {
    // The bridge is ready by default but skips cleanly when no source exists.
    // Imported notes remain candidate evidence until explicitly reviewed.
    enabled: true,
    directory: ".supraspace",
    projectMemory: true,
    ingestNotes: true,
    ingestConfidence: 0.6,
    syncOnSweep: true,
  },
  events: { enabled: true, maxEvents: 5000, maxAgeDays: 30, maxSizeMb: 20 },
};

/**
 * Dotted config paths that are currently accepted for back-compat but consumed
 * by no runtime behavior. This is the single source of truth: both
 * `stabilityForConfigPath()` (drives warnings for existing user configs) and
 * `buildDefaultTemplate()` (prunes these from freshly generated config files)
 * derive from this list so they cannot drift apart.
 */
export const DEPRECATED_UNIMPLEMENTED_PATHS: string[] = [
  "storage.commitDurableMemory",
  "cache.validateBeforeUse",
  "cache.hashAlgorithm",
  "efficiency.detectDuplicateReads",
  "efficiency.trackApproximateTokens",
  "efficiency.compactCompletedTasks",
  "integration.parallelPlanning",
  "privacy.redactEnvironmentValues",
  "privacy.storeConversationText",
  "context.searchBeforeRead",
  // No runtime consumer: the planner never creates worktrees. A `false`
  // here read as "feature disabled" while nothing could enable it.
  "parallelism.useWorktreesForConflicts",
];

/**
 * One ownership record per public config leaf. This is deliberately data, not
 * prose: tests ensure new config keys cannot be introduced without a runtime
 * owner and a functional test reference.
 */
export const CONFIG_FIELD_REGISTRY: Record<string, ConfigFieldRegistryEntry> = Object.fromEntries(
  Object.entries(flattenConfig(DEFAULT_CONFIG)).map(([path, value]) => [
    path,
    {
      owner: ownerForConfigPath(path),
      default: value,
      stability: stabilityForConfigPath(path),
      securityImpact: securityImpactForConfigPath(path),
      functionalTest: "tests/unit/config.test.ts",
    },
  ]),
);

export function flattenConfig(value: unknown, prefix = ""): Record<string, unknown> {
  if (!isPlainObject(value)) return prefix ? { [prefix]: value } : {};
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // Kept inline because the registry is initialized before the merge helper's
    // module-level guard is declared below.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) Object.assign(result, flattenConfig(child, path));
    else result[path] = child;
  }
  return result;
}

function ownerForConfigPath(path: string): string {
  if (path.startsWith("storage.")) return "packages/core/src/storage";
  if (path.startsWith("memory.")) return "packages/core/src/memory";
  if (path.startsWith("context.")) return "packages/core/src/context";
  if (path.startsWith("cache.")) return "packages/core/src/cache";
  if (path.startsWith("graph.")) return "packages/core/src/graph";
  if (path.startsWith("parallelism.") || path.startsWith("staleness."))
    return "packages/core/src/orchestration";
  if (path.startsWith("jev.")) return "packages/core/src/jev";
  if (path.startsWith("events.") || path.startsWith("logging.")) return "packages/core/src/events";
  if (path.startsWith("telemetry.")) return "packages/core/src/metrics";
  if (path.startsWith("integration.")) return "packages/opencode/src/plugin.ts";
  if (path.startsWith("supraspace.")) return "packages/core/src/supraspace";
  if (path.startsWith("privacy.")) return "packages/core/src/engine.ts";
  return "packages/core/src/config.ts";
}

function stabilityForConfigPath(path: string): ConfigFieldStability {
  // These switches are currently not consumed by a runtime behavior. Keeping
  // them visible but explicitly deprecated is safer than implying a guarantee.
  if (DEPRECATED_UNIMPLEMENTED_PATHS.includes(path)) return "deprecated-unimplemented";
  if (path === "graph.automaticContext") return "experimental";
  if (path.startsWith("jev.")) return "experimental";
  return "stable";
}

function securityImpactForConfigPath(path: string): ConfigFieldRegistryEntry["securityImpact"] {
  if (
    path.startsWith("privacy.") ||
    path.startsWith("telemetry.") ||
    path === "storage.commitDurableMemory" ||
    path.startsWith("supraspace.")
  )
    return "privacy";
  if (
    path.startsWith("storage.") ||
    path.startsWith("memory.") ||
    path.startsWith("cache.") ||
    path.startsWith("graph.")
  )
    return "integrity";
  if (
    path.startsWith("context.") ||
    path.startsWith("parallelism.") ||
    path.startsWith("staleness.")
  )
    return "availability";
  return "none";
}

/**
 * A deep clone of DEFAULT_CONFIG with every deprecated-unimplemented path
 * removed, for use when generating a brand-new config file. Existing user
 * configs are untouched by this: `validateConfig()` still accepts (and warns
 * on) the pruned keys, and `resolveConfig()` still fills them in from
 * DEFAULT_CONFIG when they are absent, so effective runtime behavior is
 * unchanged. Only the on-disk template written for new installs gets smaller.
 */
export function buildDefaultTemplate(): PartialConfig {
  const template = deepClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  for (const path of DEPRECATED_UNIMPLEMENTED_PATHS) deleteNestedPath(template, path);
  return template as unknown as PartialConfig;
}

/**
 * Mode presets express intent as concrete effective settings. `custom` leaves
 * the merged user config untouched. `off` behaves exactly like enabled:false.
 */
export function applyModePreset(base: Config, mode: Mode): Config {
  const c = deepClone(base);
  c.mode = mode;
  switch (mode) {
    case "off":
      c.enabled = false;
      c.events.enabled = false;
      return c;
    case "minimal":
      c.enabled = true;
      c.memory.automaticRecording = false;
      c.context.maxTokens = 4000;
      c.context.maxRecommendedReads = 2;
      c.context.includeGitDiff = false;
      c.memory.maxRetrievedEntries = 6;
      c.memory.maxRetrievedTokens = 1500;
      c.parallelism.enabled = false;
      c.events.maxEvents = 500;
      c.events.maxAgeDays = 7;
      c.events.maxSizeMb = 5;
      return c;
    case "balanced":
      c.enabled = true;
      return c;
    case "aggressive":
      c.enabled = true;
      c.context.maxTokens = 24000;
      c.context.maxRecommendedReads = 12;
      c.memory.maxRetrievedEntries = 40;
      c.memory.maxRetrievedTokens = 8000;
      c.parallelism.maxConcurrentTasks = 8;
      return c;
    case "custom":
      return c;
    default:
      return c;
  }
}

/**
 * Configuration is CENTRAL: `~/.config/supracortex/config.jsonc` is the single
 * source of truth for every feature. A project's `.supracortex/config.jsonc`
 * may only carry facts about that project's own store and a per-project kill
 * switch — values that describe the project itself and so cannot go stale
 * relative to the machine. Any other key in a project file is ignored (and
 * reported by `doctor`), because project files written by older installers
 * froze full default dumps that silently overrode later central changes.
 */
export const PROJECT_SCOPED_PATHS: readonly string[] = ["enabled", "storage.directory", "storage.driver"];

export interface ProjectScopedResult {
  /** Only the project-scoped keys. */
  config: PartialConfig;
  /** Dotted paths present in the file but ignored (managed centrally). */
  ignored: string[];
}

export function projectScopedConfig(raw: unknown): ProjectScopedResult {
  if (!isPlainObject(raw)) return { config: {}, ignored: [] };
  const flat = flattenConfig(raw as Record<string, unknown>);
  const kept: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [path, value] of Object.entries(flat)) {
    if (path === "$schema") continue;
    if (PROJECT_SCOPED_PATHS.includes(path)) {
      const parts = path.split(".");
      let cur = kept;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]!] = isPlainObject(cur[parts[i]!]) ? cur[parts[i]!] : {};
        cur = cur[parts[i]!] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]!] = value;
    } else {
      ignored.push(path);
    }
  }
  return { config: kept as PartialConfig, ignored };
}

/**
 * Store identity is a fact about the data on disk, not a preference: opening
 * the wrong backend shows an empty store. When no project file pins the
 * driver, detect it from what exists under the storage directory. Pure given
 * the `exists` probe (injected for tests).
 */
export function detectStorageDriver(
  storageRoot: string,
  exists: (path: string) => boolean,
): StorageDriver | null {
  if (exists(`${storageRoot}/state/store.sqlite`)) return "sqlite";
  if (exists(`${storageRoot}/memory/durable.jsonl`) || exists(`${storageRoot}/index/repository.json`)) return "jsonl";
  return null;
}

export interface ResolveInput {
  defaults?: Config;
  global?: PartialConfig | null;
  project?: PartialConfig | null;
  runtimeOverride?: PartialConfig | null;
  env?: Record<string, string | undefined>;
}

export interface ResolvedConfig {
  config: Config;
  /** Human-readable reason for the effective enabled/disabled state. */
  reason: string;
  /** Which layer decided the enabled flag. */
  source: "env-disable" | "env-enable" | "runtime" | "project" | "global" | "default" | "mode-off";
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function envFlag(value: string | undefined): boolean {
  if (value == null) return false;
  return TRUTHY.has(value.trim().toLowerCase());
}

/**
 * Merge config layers and resolve the effective enabled state with a documented
 * precedence. Mode presets are applied AFTER structural merge, then the explicit
 * `enabled` flags from each layer are re-applied so an explicit toggle wins over
 * a preset's implied enabled value.
 */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const defaults = input.defaults ?? DEFAULT_CONFIG;
  const env = input.env ?? {};

  // Structural merge (low -> high precedence for values).
  let merged = deepClone(defaults);
  if (input.global) merged = mergeConfig(merged, input.global);
  if (input.project) merged = mergeConfig(merged, input.project);
  if (input.runtimeOverride) merged = mergeConfig(merged, input.runtimeOverride);

  // Apply mode preset, then re-assert any explicit enabled flags that layers set.
  const explicitEnabled = firstDefinedEnabled([input.runtimeOverride, input.project, input.global]);
  merged = applyModePreset(merged, merged.mode);
  if (explicitEnabled !== undefined) merged.enabled = explicitEnabled;

  // Precedence for the final enabled decision.
  if (envFlag(env.SUPRACORTEX_DISABLE)) {
    merged.enabled = false;
    return {
      config: merged,
      reason: "Disabled by SUPRACORTEX_DISABLE environment variable.",
      source: "env-disable",
    };
  }

  if (envFlag(env.SUPRACORTEX_ENABLE)) {
    merged.enabled = true;
    return {
      config: merged,
      reason: "Enabled by SUPRACORTEX_ENABLE environment variable.",
      source: "env-enable",
    };
  }

  if (merged.mode === "off") {
    merged.enabled = false;
    return { config: merged, reason: 'Mode is "off".', source: "mode-off" };
  }

  if (input.runtimeOverride && input.runtimeOverride.enabled !== undefined) {
    return {
      config: merged,
      reason: `Runtime override set enabled=${merged.enabled}.`,
      source: "runtime",
    };
  }
  if (input.project && input.project.enabled !== undefined) {
    return {
      config: merged,
      reason: `Project config set enabled=${merged.enabled}.`,
      source: "project",
    };
  }
  if (input.global && input.global.enabled !== undefined) {
    return {
      config: merged,
      reason: `Global config set enabled=${merged.enabled}.`,
      source: "global",
    };
  }

  return {
    config: merged,
    reason: `Default enabled=${merged.enabled}.`,
    source: "default",
  };
}

function firstDefinedEnabled(layers: Array<PartialConfig | null | undefined>): boolean | undefined {
  for (const layer of layers) {
    if (layer && typeof layer.enabled === "boolean") return layer.enabled;
  }
  return undefined;
}

/** Keys that must never be merged from untrusted config (prototype pollution). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Shallow-by-section deep merge: known object sections merge key-by-key. */
export function mergeConfig(base: Config, patch: PartialConfig): Config {
  const out = deepClone(base);
  for (const key of Object.keys(patch) as Array<keyof Config>) {
    if (FORBIDDEN_KEYS.has(key as string)) continue; // pollution guard
    const value = patch[key];
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = mergeNested(current, value) as never;
    } else {
      out[key] = value as never;
    }
  }
  return out;
}

/**
 * Recursively merge a nested partial object into a base, filling in missing
 * sibling defaults while letting explicitly-set values win. This keeps
 * additive 3+ level config sections (e.g. `telemetry.valueMeasurement`) from
 * losing their defaults when a user overrides only one leaf.
 */
function mergeNested(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue; // pollution guard
    const value = patch[key];
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = mergeNested(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepClone<T>(v: T): T {
  return structuredClone(v);
}

/** Set a value at a dot-separated path inside a nested object, creating parent sections as needed. */
function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  const max = parts.length - 1;
  let current = obj;
  for (let i = 0; i < max; i++) {
    const key = parts[i] as string;
    if (FORBIDDEN_KEYS.has(key)) return;
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  const last = parts[max] as string;
  if (!FORBIDDEN_KEYS.has(last)) current[last] = value;
}

/** Delete a value at a dot-separated path inside a nested object. No-op if intermediate sections are missing. */
function deleteNestedPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  const max = parts.length - 1;
  let current = obj;
  for (let i = 0; i < max; i++) {
    const key = parts[i] as string;
    if (!isPlainObject(current[key])) return;
    current = current[key] as Record<string, unknown>;
  }
  const last = parts[max] as string;
  if (FORBIDDEN_KEYS.has(last)) return;
  delete current[last];
  // Clean up empty parent containers after deletion only if the parent becomes empty.
  if (Object.keys(current).length === 0 && max > 0) {
    const parentParts = parts.slice(0, -1);
    const pMax = parentParts.length - 1;
    let parent = obj;
    for (let i = 0; i < pMax; i++) {
      const key = parentParts[i] as string;
      if (!isPlainObject(parent[key])) return;
      parent = parent[key] as Record<string, unknown>;
    }
    const pLast = parentParts[pMax] as string;
    if (isPlainObject(parent[pLast])) {
      const p = parent[pLast] as Record<string, unknown>;
      if (Object.keys(p).length === 0) delete parent[pLast];
    }
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible key lifecycle: renamed keys map silently, removed keys
// warn but never hard-error.
// ---------------------------------------------------------------------------

/** Keys that have been renamed. Value is the new key path. */
export const RENAMED_CONFIG_KEYS: Record<string, string> = {
  "context.maxFullFiles": "context.maxRecommendedReads",
};

/** Keys that have been removed entirely. Present in user config → warning, not error. */
export const REMOVED_CONFIG_KEYS: string[] = [
  "efficiency.enabled",
  "privacy.allowPathsOutsideProject",
  "logging",
  "logging.level",
  "logging.maxFiles",
  "logging.maxFileSizeMb",
];

/** Check if a flattened key path matches a removed prefix. */
function isRemovedKey(path: string): boolean {
  return (
    REMOVED_CONFIG_KEYS.includes(path) || REMOVED_CONFIG_KEYS.some((k) => path.startsWith(k + "."))
  );
}

// ---------------------------------------------------------------------------
// Lightweight runtime validation (no external deps in core).
// Returns a list of human-readable problems; empty means valid.
// ---------------------------------------------------------------------------

export function validateConfig(cfg: unknown): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  value: Config;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = coerceObject(cfg);

  // Migrate raw config: handle renamed and removed keys before merging.
  const rawFlat = flattenConfig(raw);
  const migratedRaw = structuredClone(raw);
  for (const [path, value] of Object.entries(rawFlat)) {
    const renamed = RENAMED_CONFIG_KEYS[path];
    if (renamed) {
      // If the user explicitly set the new key too, the new key value wins.
      // Only apply the old → new migration when the new key is absent from raw.
      if (!(renamed in rawFlat)) {
        setNestedPath(migratedRaw, renamed, value);
      }
      deleteNestedPath(migratedRaw, path);
      warnings.push(`configuration key '${path}' is renamed to '${renamed}'; update your config`);
    } else if (isRemovedKey(path)) {
      warnings.push(`configuration key '${path}' was removed and is ignored`);
      deleteNestedPath(migratedRaw, path);
    }
  }

  const merged = mergeConfig(DEFAULT_CONFIG, migratedRaw);
  for (const path of unknownConfigKeys(migratedRaw))
    errors.push(`unknown configuration key: ${path}`);

  // Warn about deprecated-unimplemented fields that have no runtime effect.
  const migratedFlat = flattenConfig(migratedRaw);
  for (const path of Object.keys(migratedFlat)) {
    const entry = CONFIG_FIELD_REGISTRY[path];
    if (entry?.stability === "deprecated-unimplemented") {
      warnings.push(
        `configuration key '${path}' is deprecated and has no runtime effect; it will be removed in a future version`,
      );
    }
  }

  const num = (v: number, name: string, min: number, max: number) => {
    if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) {
      errors.push(`${name} must be a number in [${min}, ${max}], got ${String(v)}`);
    }
  };

  const validModes: Mode[] = ["off", "minimal", "balanced", "aggressive", "custom"];
  if (!validModes.includes(merged.mode)) {
    errors.push(`mode must be one of ${validModes.join(", ")}, got ${String(merged.mode)}`);
  }
  if (merged.storage.driver !== "jsonl" && merged.storage.driver !== "sqlite") {
    errors.push(`storage.driver must be "jsonl" or "sqlite", got ${String(merged.storage.driver)}`);
  }
  if (!isSafeStorageDirectory(merged.storage.directory)) {
    errors.push(
      "storage.directory must be a non-root project-relative directory without traversal",
    );
  }
  num(merged.memory.minimumConfidence, "memory.minimumConfidence", 0, 1);
  num(merged.memory.maxRetrievedEntries, "memory.maxRetrievedEntries", 0, 10000);
  num(merged.memory.maxRetrievedTokens, "memory.maxRetrievedTokens", 0, 1_000_000);
  num(merged.context.maxTokens, "context.maxTokens", 0, 10_000_000);
  num(merged.context.maxRecommendedReads, "context.maxRecommendedReads", 0, 1000);
  num(merged.graph.maxNodes, "graph.maxNodes", 1, 50_000);
  num(merged.graph.maxEdges, "graph.maxEdges", 1, 200_000);
  num(merged.graph.maxQueryResults, "graph.maxQueryResults", 1, 50);
  if (merged.jev.deadlineMs !== -1) num(merged.jev.deadlineMs, "jev.deadlineMs", 100, 30_000);
  num(merged.jev.minConfidence, "jev.minConfidence", 0, 1);
  if (merged.jev.enrichmentBudgetMs !== -1) num(merged.jev.enrichmentBudgetMs, "jev.enrichmentBudgetMs", 0, 10_000);
  if (typeof merged.jev.model !== "string" || merged.jev.model.length > 200) {
    errors.push("jev.model must be a model id (max 200 chars) or empty for the provider preset");
  }
  if (!["jev", "laya-local", "laya-hosted", "custom"].includes(merged.jev.provider)) {
    errors.push('jev.provider must be "jev", "laya-local", "laya-hosted" or "custom"');
  }
  if (typeof merged.jev.endpoint !== "string" || merged.jev.endpoint.length > 500) {
    errors.push("jev.endpoint must be a URL string (max 500 chars) or empty for the provider preset");
  } else if (merged.jev.endpoint.trim()) {
    try {
      const url = new URL(merged.jev.endpoint.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    } catch {
      errors.push("jev.endpoint must be an http(s) URL or empty for the provider preset");
    }
  }
  if (
    (merged.jev.provider === "custom" || merged.jev.provider === "laya-hosted") &&
    !merged.jev.endpoint.trim()
  ) {
    errors.push(`jev.endpoint is required when jev.provider is "${merged.jev.provider}"`);
  }
  if (
    typeof merged.jev.apiKeyEnv !== "string" ||
    merged.jev.apiKeyEnv.length > 128 ||
    (merged.jev.apiKeyEnv.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(merged.jev.apiKeyEnv.trim()))
  ) {
    errors.push("jev.apiKeyEnv must be an env var name or empty for the provider preset");
  }
  if (typeof merged.jev.credentialsFile !== "string" || merged.jev.credentialsFile.length > 1000) {
    errors.push("jev.credentialsFile must be a file path string (max 1000 chars) or empty");
  }
  if (!["auto", "bearer", "none"].includes(merged.jev.auth)) {
    errors.push('jev.auth must be "auto", "bearer" or "none"');
  }
  if (typeof merged.jev.modelMatch !== "string" || merged.jev.modelMatch.length > 64) {
    errors.push("jev.modelMatch must be a short substring (max 64 chars) or empty for the provider preset");
  }
  if (
    [merged.graph.maxNodes, merged.graph.maxEdges, merged.graph.maxQueryResults].some(
      (value) => !Number.isInteger(value),
    )
  ) {
    errors.push("graph limits must be whole numbers");
  }
  num(merged.storage.maxStorageMb, "storage.maxStorageMb", 1, 100_000);
  num(merged.parallelism.maxConcurrentTasks, "parallelism.maxConcurrentTasks", 1, 128);
  num(
    merged.staleness.taskHeartbeatTimeoutMinutes,
    "staleness.taskHeartbeatTimeoutMinutes",
    0,
    1_000_000,
  );
  num(merged.staleness.ownershipTtlMinutes, "staleness.ownershipTtlMinutes", 0, 1_000_000);
  num(merged.staleness.sessionTtlMinutes, "staleness.sessionTtlMinutes", 0, 1_000_000);
  num(merged.staleness.memoryReverifyDays, "staleness.memoryReverifyDays", 0, 100_000);
  num(
    merged.staleness.completedTaskRetentionDays,
    "staleness.completedTaskRetentionDays",
    0,
    100_000,
  );
  num(merged.supraspace.ingestConfidence, "supraspace.ingestConfidence", 0, 1);
  num(merged.events.maxEvents, "events.maxEvents", 0, 1_000_000);
  num(merged.events.maxAgeDays, "events.maxAgeDays", 0, 100_000);
  num(merged.events.maxSizeMb, "events.maxSizeMb", 0, 10_000);

  if (merged.telemetry.mode !== "off" && merged.telemetry.mode !== "local") {
    errors.push('telemetry.mode must be "off" or "local"');
  }
  num(merged.telemetry.maxEvents, "telemetry.maxEvents", 0, 1_000_000);
  num(merged.telemetry.maxAgeDays, "telemetry.maxAgeDays", 0, 100_000);
  if (merged.telemetry.mode === "local" && merged.telemetry.maxEvents < 1) {
    errors.push("telemetry.maxEvents must be at least 1 when telemetry.mode is local");
  }
  if (merged.telemetry.mode === "local" && merged.telemetry.maxAgeDays < 1) {
    errors.push("telemetry.maxAgeDays must be at least 1 when telemetry.mode is local");
  }
  num(
    merged.telemetry.valueMeasurement.maxEvents,
    "telemetry.valueMeasurement.maxEvents",
    0,
    1_000_000,
  );
  num(
    merged.telemetry.valueMeasurement.maxAgeDays,
    "telemetry.valueMeasurement.maxAgeDays",
    0,
    100_000,
  );
  if (
    merged.telemetry.valueMeasurement.enabled &&
    merged.telemetry.valueMeasurement.maxEvents < 1
  ) {
    errors.push(
      "telemetry.valueMeasurement.maxEvents must be at least 1 when value measurement is enabled",
    );
  }
  if (
    merged.telemetry.valueMeasurement.enabled &&
    merged.telemetry.valueMeasurement.maxAgeDays < 1
  ) {
    errors.push(
      "telemetry.valueMeasurement.maxAgeDays must be at least 1 when value measurement is enabled",
    );
  }
  // retentionDays accepts 0 intentionally: 0 disables pruning (keep forever).
  num(
    merged.telemetry.sessionMetrics.retentionDays,
    "telemetry.sessionMetrics.retentionDays",
    0,
    100_000,
  );

  return { valid: errors.length === 0, errors, warnings, value: merged };
}

function isSafeStorageDirectory(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "" || value === ".") return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value))
    return false;
  return !value.split(/[\\/]+/).some((part) => part === "..");
}

/** Return path-specific unknown keys before merge drops them. */
export function unknownConfigKeys(
  value: unknown,
  template: unknown = DEFAULT_CONFIG,
  prefix = "",
): string[] {
  if (!isPlainObject(value) || !isPlainObject(template)) return [];
  const keys: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key)) {
      keys.push(path);
      continue;
    }
    if (!(key in template)) {
      keys.push(path);
      continue;
    }
    const expected = (template as Record<string, unknown>)[key];
    if (isPlainObject(child) && isPlainObject(expected))
      keys.push(...unknownConfigKeys(child, expected, path));
  }
  return keys;
}

function coerceObject(v: unknown): PartialConfig {
  return isPlainObject(v) ? (v as PartialConfig) : {};
}
