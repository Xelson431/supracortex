/**
 * OpenCode provider cache adapter.
 *
 * Translates a core {@link ProviderCachePolicyIntent} into host-level actions.
 * This release is **observe-only**: for all modes the adapter returns
 * `{ applied: false, reason }`. Mutation of provider options is gated
 * experimental and will be filled in a post-stable spike.
 *
 * The adapter is a pure function — no IO, no imports from core types beyond
 * what it receives.
 */

import type { ProviderCachePolicyIntent } from "@local/supracortex-core";
import {
  normalizeProviderUsage,
  type NativeUsageFields,
  type NormalizedBilledUsage,
} from "@local/supracortex-core";

export type AdapterResult = {
  applied: boolean;
  reason: string;
};

/**
 * Process a provider cache policy intent and return the adapter's action
 * result.
 *
 * - `"observe-only"` / `"host-managed"`: no request mutation — the intent is
 *   returned as-is for telemetry/status reporting.
 * - `"optimize-safe"`: still no mutation (gated experimental). Returns
 *   `{ applied: false, reason }` explaining why.
 *
 * When `applied` is true, the caller should know that provider options were
 * mutated. In this release it is always false.
 */
export function processProviderCacheIntent(
  intent: ProviderCachePolicyIntent,
): AdapterResult {
  if (intent.mode === "optimize-safe") {
    return {
      applied: false,
      reason:
        "optimize-safe mode resolved but mutation is gated experimental in this release",
    };
  }

  // host-managed and observe-only: no mutation, no action.
  return {
    applied: false,
    reason: `mode ${intent.mode}: no provider option mutation (observe-only release)`,
  };
}

/**
 * Status-only measurement of native provider cache usage (Wave 2, item 2d).
 * Pure function: never mutates, never claims. Unsupported providers or
 * missing fields report `N/A`, never a fabricated 0%.
 */
export function summarizeNativeUsageForStatus(
  raw: NativeUsageFields | null | undefined,
  provider?: string,
): { summary: string; usage: NormalizedBilledUsage } {
  const usage = normalizeProviderUsage(raw, provider);
  if (!usage.supported) {
    return { summary: "provider cache: N/A (unsupported or unreported)", usage };
  }
  const rate =
    usage.hitRate === null ? "N/A" : `${(usage.hitRate * 100).toFixed(1)}%`;
  return {
    summary:
      `provider cache: reads ${usage.cacheRead}, writes ${usage.cacheWrite}, ` +
      `hit rate ${rate}${usage.invariantOk ? "" : " (invariant read+created≤total violated, clamped)"}`,
    usage,
  };
}
