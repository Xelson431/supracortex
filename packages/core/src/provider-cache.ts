/**
 * Provider cache policy resolution.
 *
 * This module is **host-agnostic**: it knows nothing about OpenAI option shapes,
 * Claude header names, or any host-specific option format. It resolves a pure
 * policy intent ({@link ProviderCachePolicyIntent}) from host capabilities,
 * provider-family hints, and privacy constraints. The adapter layer translates
 * the intent into host-specific actions.
 *
 * Constraint: `erasableSyntaxOnly` — no enums, no namespaces, no parameter
 * properties. String-literal unions and plain const objects only.
 */

import { createHash } from "node:crypto";
import type {
  HostCapabilities,
  ProviderCacheMode,
  ProviderCachePolicyIntent,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Capability table: known host + provider family → supported option path.
// ---------------------------------------------------------------------------
// Entries here represent hosts that allow cache breakpoint configuration
// through a provider option key known to the core. Unknown hosts, router
// providers, or unspecified families never match "optimize-safe".
//
// Format: "host:provider-family" → { optionPath, sinceVersion? }.
// Provider families are coarse: "openai", "anthropic", "google", etc.
// No host-specific option shapes are stored here; only the option key path
// and the minimum host version that supports it.
// ---------------------------------------------------------------------------

interface CacheCapabilityEntry {
  /** Dot-delimited option key path (e.g. "provider.options.cache_control"). */
  optionPath: string;
  /** Minimum required host version for this option path. Undefined = any. */
  sinceVersion?: string;
}

const CACHE_CAPABILITY_TABLE: Record<string, CacheCapabilityEntry> = {
  // OpenCode ≥ 1.18 has experimental provider option forwarding via
  // experimental.chat.provider.options. This is still gated; the table exists
  // for when setCacheBreakpoints graduates to "supported".
  "opencode:openai": {
    optionPath: "experimental.chat.provider.options.openai",
    sinceVersion: "1.18.0",
  },
  "opencode:anthropic": {
    optionPath: "experimental.chat.provider.options.anthropic",
    sinceVersion: "1.18.0",
  },
  // Claude Code is a separate host with its own config surface.
  "claude-code:anthropic": {
    optionPath: "provider.options.anthropic.cache_control",
    sinceVersion: "0.1.0",
  },
  // Add future host+provider entries here. Never add router/multi-provider
  // hosts — they do not have stable per-provider option paths.
};

// ---------------------------------------------------------------------------
// Privacy dimension strings used in digest computation. These are shared,
// deterministic, and contain zero secrets/paths/user data.
// ---------------------------------------------------------------------------

const PRIVACY_DIMENSION: Record<string, string> = {
  policy: "supracortex/provider-cache/v1",
  schema: "ProviderCachePolicyIntent/v1",
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolveProviderCachePolicyInput {
  /** Host identifier (e.g. "opencode", "claude-code"). */
  host: string;
  /** Optional provider family hint (e.g. "openai", "anthropic", "google"). */
  providerHint?: string;
  /** Optional model hint (e.g. "gpt-4o", "claude-sonnet-4-20250514"). */
  modelHint?: string;
  /** Optional host version for capability gating. */
  hostVersion?: string;
  /** Host capability report. */
  capability: Pick<
    HostCapabilities,
    "setProviderOptions" | "setCacheBreakpoints"
  >;
  /** Project identifier (absolute path or stable key). Never a secret. */
  projectKey: string;
  /** Stable prefix used for cache-key scoping. */
  stablePrefix: string;
  /** Optional privacy policy constraints. */
  privacyPolicy?: {
    zeroDataRetention?: boolean;
    dataResidency?: string;
  };
}

/**
 * Resolve the provider cache policy intent from host capabilities, provider
 * hints, and privacy constraints.
 *
 * Decision matrix:
 *
 * | setCacheBreakpoints | Known host + provider | zeroDataRetention | Result        |
 * |---------------------|-----------------------|-------------------|---------------|
 * | supported           | yes (allowlist entry) | no                | optimize-safe |
 * | supported           | no (unknown/router)   | *                 | observe-only  |
 * | *                  | *                     | yes               | observe-only  |
 * | unsupported/unknown | yes                   | no                | host-managed  |
 * | unsupported/unknown | no                    | no                | observe-only  |
 *
 * The result is always an **intent**. The adapter layer decides whether to act
 * on it. This function never performs IO, never accesses network, never reads
 * config files, and never creates provider-specific option objects.
 */
export function resolveProviderCachePolicy(
  input: ResolveProviderCachePolicyInput,
): ProviderCachePolicyIntent {
  // 1. Privacy policy always wins.
  if (input.privacyPolicy?.zeroDataRetention) {
    return {
      mode: "observe-only" as ProviderCacheMode,
      projectKeyDigest: computeDigest(input, "observe-only", "key"),
      stablePrefixDigest: computeDigest(input, "observe-only", "prefix"),
      // requestedTtl deliberately omitted — never request extended TTL.
    };
  }

  // 2. Determine mode.
  const mode = resolveMode(input);

  // 3. Compute digests — stable per inputs, mix privacy dimension strings.
  const projectKeyDigest = computeDigest(input, mode, "key");
  const stablePrefixDigest = computeDigest(input, mode, "prefix");

  // 4. requestedTtl: only for optimize-safe mode.
  let requestedTtl: string | undefined;
  if (mode === "optimize-safe") {
    requestedTtl = "1h";
  }

  return { mode, projectKeyDigest, stablePrefixDigest, requestedTtl };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveMode(
  input: ResolveProviderCachePolicyInput,
): ProviderCacheMode {
  const { capability, host, hostVersion, providerHint } = input;

  // optimize-safe only when:
  //   - setCacheBreakpoints === "supported"
  //   - host is known in the capability table
  //   - provider family is known for that host
  //   - version requirement satisfied (if any)
  if (capability.setCacheBreakpoints === "supported") {
    const family = providerHint ?? "unknown";
    const key = `${host}:${family}`;
    const entry = CACHE_CAPABILITY_TABLE[key];
    if (entry && isVersionAtLeast(hostVersion, entry.sinceVersion)) {
      return "optimize-safe" as ProviderCacheMode;
    }
    // Fall through: known host with unsupported provider, or router provider,
    // or version too low → observe-only.
    return "observe-only" as ProviderCacheMode;
  }

  // When setCacheBreakpoints is unsupported/unknown/experimental:
  //   - Known non-router hosts default to host-managed.
  //   - Unknown or router providers → observe-only.
  if (host !== "unknown" && host !== "mcp") {
    return "host-managed" as ProviderCacheMode;
  }

  return "observe-only" as ProviderCacheMode;
}

/**
 * Compute a deterministic SHA-256 hex digest for project key or stable prefix.
 * Mixes in privacy dimension strings — never raw paths, secrets, emails, or
 * prompt text. The result is stable for identical inputs.
 */
function computeDigest(
  input: ResolveProviderCachePolicyInput,
  mode: ProviderCacheMode,
  domain: "key" | "prefix",
): string {
  const dimension = [
    PRIVACY_DIMENSION.policy,
    PRIVACY_DIMENSION.schema,
    input.host,
    input.providerHint ?? "unknown",
    input.modelHint ?? "unknown",
    mode,
    domain,
  ].join("|");

  const scoped = domain === "key" ? input.projectKey : input.stablePrefix;
  return createHash("sha256")
    .update(dimension)
    .update("\x00")
    .update(scoped)
    .digest("hex");
}

/**
 * Simple semver comparison. Returns true if `version` >= `minimum`.
 * Fail-closed: when a minimum is required, an unknown, empty, or
 * unparseable `version` returns false (observe-only). Undefined minimum
 * means "any" (returns true).
 */
function isVersionAtLeast(
  version: string | undefined,
  minimum: string | undefined,
): boolean {
  if (!minimum) return true;
  if (!version || version.trim() === "") return false;
  const vParts = version.trim().split(".").map(Number);
  const mParts = minimum.split(".").map(Number);
  if (
    vParts.some((n) => !Number.isFinite(n)) ||
    mParts.some((n) => !Number.isFinite(n))
  ) {
    return false;
  }
  for (let i = 0; i < Math.max(vParts.length, mParts.length); i++) {
    const v = vParts[i] ?? 0;
    const m = mParts[i] ?? 0;
    if (v > m) return true;
    if (v < m) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Disjoint billed-usage normalization (Wave 2, item 2d).
//
// Cache hits are MEASURED from native provider usage fields only — never
// modeled, never fabricated. Fields stay disjoint:
// input / output / cacheRead / cacheWrite, plus a cost split.
// ---------------------------------------------------------------------------

/** Raw native usage payload as reported by a provider host (flat or nested). */
export interface NativeUsageFields {
  // OpenAI-style
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // Anthropic-style
  cached_tokens?: number;
  cache_creation?: number;
  // DeepSeek-style
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  // Generic
  input_tokens?: number;
  output_tokens?: number;
  // OmniRoute flat aliases
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  [key: string]: unknown;
}

export interface NormalizedBilledUsage {
  /** Measured input tokens excluding cache reads (disjoint). */
  input: number;
  /** Measured output tokens (disjoint). */
  output: number;
  /** Measured cache-read tokens (disjoint). */
  cacheRead: number;
  /** Measured cache-write/creation tokens (disjoint). */
  cacheWrite: number;
  /** billed-in = input + cacheRead + cacheWrite. */
  billedInput: number;
  /** Null when the provider reports no cache fields (never fabricated 0%). */
  hitRate: number | null;
  /** False for providers with no usage support (e.g. Ollama/local). */
  supported: boolean;
  /** False when read+created exceeded the reported total (clamped). */
  invariantOk: boolean;
}

/** Providers known to report no usable token fields. */
const UNSUPPORTED_USAGE_PROVIDERS = new Set(["ollama", "local", "unknown-local"]);

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

/**
 * Map a flat usage record (e.g. OmniRoute flat keys) to the nested native
 * field names. Unknown keys pass through untouched.
 */
export function mapFlatUsageToNested(
  flat: Record<string, unknown>,
): NativeUsageFields {
  const out: NativeUsageFields = { ...flat };
  if (out.cache_read_input_tokens === undefined && typeof flat.cacheReadTokens === "number") {
    out.cache_read_input_tokens = flat.cacheReadTokens as number;
  }
  if (out.cache_creation_input_tokens === undefined && typeof flat.cacheWriteTokens === "number") {
    out.cache_creation_input_tokens = flat.cacheWriteTokens as number;
  }
  if (out.input_tokens === undefined && typeof flat.inputTokens === "number") {
    out.input_tokens = flat.inputTokens as number;
  }
  if (out.output_tokens === undefined && typeof flat.outputTokens === "number") {
    out.output_tokens = flat.outputTokens as number;
  }
  return out;
}

/**
 * Normalize native provider usage into disjoint billed fields.
 *
 * - cacheRead comes from `cache_read_input_tokens` / `cached_tokens` /
 *   `prompt_cache_hit_tokens` (measured only).
 * - cacheWrite comes from `cache_creation_input_tokens` / `cache_creation`.
 * - Missing usage fields → `{ supported: false, hitRate: null }`, never 0%.
 * - Invariant `read + created ≤ total` is enforced by clamping; violations
 *   set `invariantOk: false`.
 * - DeepSeek check: when hit+miss are both present they must equal
 *   `prompt_tokens` (otherwise `invariantOk: false`, values still reported).
 */
export function normalizeProviderUsage(
  raw: NativeUsageFields | null | undefined,
  provider?: string,
): NormalizedBilledUsage {
  const unsupported = (provider ?? "").toLowerCase();
  if (!raw || UNSUPPORTED_USAGE_PROVIDERS.has(unsupported)) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      billedInput: 0,
      hitRate: null,
      supported: false,
      invariantOk: true,
    };
  }
  const mapped = mapFlatUsageToNested(raw as Record<string, unknown>);
  const readRaw =
    mapped.cache_read_input_tokens ?? mapped.cached_tokens ?? mapped.prompt_cache_hit_tokens;
  const writeRaw = mapped.cache_creation_input_tokens ?? mapped.cache_creation;
  const cacheRead0 = asNonNegativeInt(readRaw) ?? 0;
  const cacheWrite0 = asNonNegativeInt(writeRaw) ?? 0;
  const hasCacheFields = readRaw !== undefined || writeRaw !== undefined;
  const hasAnyFields =
    hasCacheFields ||
    mapped.input_tokens !== undefined ||
    mapped.output_tokens !== undefined ||
    mapped.prompt_tokens !== undefined ||
    mapped.completion_tokens !== undefined ||
    mapped.inputTokens !== undefined ||
    mapped.outputTokens !== undefined;
  if (!hasAnyFields) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      billedInput: 0,
      hitRate: null,
      supported: false,
      invariantOk: true,
    };
  }
  let input = asNonNegativeInt(mapped.input_tokens ?? mapped.prompt_tokens ?? mapped.inputTokens) ?? 0;
  const output =
    asNonNegativeInt(mapped.output_tokens ?? mapped.completion_tokens ?? mapped.outputTokens) ?? 0;

  let invariantOk = true;

  // DeepSeek check: hit + miss must equal prompt_tokens.
  const hit = asNonNegativeInt(mapped.prompt_cache_hit_tokens);
  const miss = asNonNegativeInt(mapped.prompt_cache_miss_tokens);
  const prompt = asNonNegativeInt(mapped.prompt_tokens);
  if (hit !== null && miss !== null && prompt !== null && hit + miss !== prompt) {
    invariantOk = false;
  }

  // Invariant: read + created ≤ total input. Clamp the reads into the total.
  let cacheRead = cacheRead0;
  let cacheWrite = cacheWrite0;
  if (cacheRead + cacheWrite > input && input > 0) {
    invariantOk = false;
    const totalCache = cacheRead + cacheWrite;
    const scale = input / totalCache;
    cacheRead = Math.floor(cacheRead * scale);
    cacheWrite = input - cacheRead;
  }
  if (input === 0 && cacheRead + cacheWrite > 0) {
    // Provider reported cache activity against a zero total: report measured
    // values, billed-in is the cache sum, no rate claim.
    input = cacheRead + cacheWrite;
  }
  // Providers report input INCLUSIVE of cache reads (Anthropic/OpenAI
  // convention), so the disjoint identity is:
  // billed-in = inputExclCache + cacheRead + cacheWrite.
  const inputExclCache = Math.max(0, input - cacheRead);
  return {
    input: inputExclCache,
    output,
    cacheRead,
    cacheWrite,
    billedInput: inputExclCache + cacheRead + cacheWrite,
    hitRate: hasCacheFields && input > 0 ? cacheRead / input : null,
    supported: true,
    invariantOk,
  };
}
