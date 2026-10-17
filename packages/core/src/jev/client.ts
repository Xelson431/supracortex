/**
 * System One decision client (historical name: Jev client). Preview branch only.
 *
 * Speaks `POST {endpoint}` with `{ model, state, questions }`, so it serves
 * any compatible decision provider (Jev, self-hosted/hosted Laya, custom) —
 * see `./providers.ts` for provider presets. Which provider is configuration.
 *
 * - No network unless enabled in config AND (when required) an API key is
 *   present in the configured env var. The engine enables decisions by default.
 * - Native fetch with a bounded total deadline (default 1200ms), AbortSignal
 *   cancellation, no foreground retries.
 * - After 3 consecutive provider failures, skip decisions for 60s (in-memory
 *   cooldown, per client instance).
 * - Identical in-flight requests are coalesced; bounded decision cache keyed
 *   by project/worktree + task/agent + model/policy + config + candidate hash.
 * - Any failure (missing key, timeout, HTTP error, invalid response) returns
 *   a typed failure — never throws to the context path. Callers fall back to
 *   deterministic behavior.
 */

import { createHash } from "node:crypto";
import type {
  JevAnswer,
  JevDecisionsRequest,
  JevDecisionsResponse,
  JevDecisionsUsage,
  JevFailureReason,
  JevQuestion,
} from "./types.ts";
import { JEV_MODEL, JEV_SYSTEMONE_URL } from "./types.ts";
import { validateDecisionsResponse } from "./validate.ts";

export interface JevClientConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Total Jev deadline per operation in ms. Default 1200. */
  deadlineMs: number;
  /** Model id. Default typesafe/jev-1.13. */
  model: string;
  /** Decisions endpoint. Default the System One endpoint. */
  endpoint: string;
  /** Env var holding the bearer credential. Default OPENROUTER_API_KEY. */
  apiKeyEnv: string;
  /** When false, calls carry no Authorization header (self-hosted, no key). */
  requireAuth: boolean;
  /** Substring the response model must include. Empty skips the check. */
  modelMatch: string;
  /** Project/worktree discriminator for the decision cache. */
  projectKey: string;
  /** Decision cache TTL in ms. Default 5 minutes. */
  cacheTtlMs: number;
  /** Decision cache bound. Default 200 entries. */
  cacheMaxEntries: number;
}

export const DEFAULT_JEV_CLIENT_CONFIG: JevClientConfig = {
  enabled: false,
  deadlineMs: 1200,
  model: JEV_MODEL,
  endpoint: JEV_SYSTEMONE_URL,
  apiKeyEnv: "OPENROUTER_API_KEY",
  requireAuth: true,
  modelMatch: "jev",
  projectKey: "default",
  cacheTtlMs: 5 * 60 * 1000,
  cacheMaxEntries: 200,
};

export type JevCallResult =
  | { ok: true; response: JevDecisionsResponse; fromCache: boolean }
  | { ok: false; reason: JevFailureReason; detail?: string };

/** Validated usage + cache provenance for one decide() call (metrics only). */
export interface JevCallUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  fromCache: boolean;
  /** True when the call issued HTTP (not a cache hit or coalesced join). */
  issuedCall: boolean;
}

export type JevFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const COOLDOWN_AFTER_FAILURES = 3;
const COOLDOWN_MS = 60_000;

interface CacheEntry {
  response: JevDecisionsResponse;
  expiresAt: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function hashPayload(
  payload: JevDecisionsRequest,
  policyKey: string,
  projectKey: string,
  configKey: string,
): string {
  return createHash("sha256")
    .update(`${projectKey}\0${policyKey}\0${configKey}\0${stableStringify(payload)}`, "utf8")
    .digest("hex");
}

export class JevClient {
  private readonly config: JevClientConfig;
  private readonly apiKey: string | null;
  private readonly fetchImpl: JevFetch;
  private consecutiveFailures = 0;
  private cooldownUntilMs = 0;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<JevCallResult>>();
  /** Validated usage of the most recent decide() call (metrics only). */
  private lastUsage: JevCallUsage | null = null;

  constructor(
    opts: {
      config?: Partial<JevClientConfig>;
      apiKey?: string | null;
      fetchImpl?: JevFetch;
      now?: () => number;
    } = {},
  ) {
    this.config = { ...DEFAULT_JEV_CLIENT_CONFIG, ...(opts.config ?? {}) };
    const envName = this.config.apiKeyEnv?.trim() ? this.config.apiKeyEnv.trim() : "";
    const key = opts.apiKey ?? (envName ? (process.env[envName] ?? "") : "");
    this.apiKey = key?.trim() ? key.trim() : null;
    this.fetchImpl =
      opts.fetchImpl ??
      ((url, init) =>
        fetch(url, init) as unknown as Promise<{
          ok: boolean;
          status: number;
          json(): Promise<unknown>;
        }>);
    this.now = opts.now ?? (() => Date.now());
  }

  private readonly now: () => number;

  get failureCount(): number {
    return this.consecutiveFailures;
  }

  get coolingDown(): boolean {
    return this.now() < this.cooldownUntilMs;
  }

  /** Cache key inputs exposed for evidence-invalidation by callers. */
  static hashCandidates(candidates: readonly string[]): string {
    return createHash("sha256")
      .update([...candidates].sort().join("\0"), "utf8")
      .digest("hex")
      .slice(0, 16);
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Take (and clear) the usage of the most recent decide() call. Engine
   * drains this after each decision to attribute validated input/output
   * tokens, cost, calls, and cache hits to metrics.
   */
  takeLastUsage(): JevCallUsage | null {
    const usage = this.lastUsage;
    this.lastUsage = null;
    return usage;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= COOLDOWN_AFTER_FAILURES) {
      this.cooldownUntilMs = this.now() + COOLDOWN_MS;
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.cooldownUntilMs = 0;
  }

  /** Health observer (decision gate); notified of every settled call. */
  onResult: ((result: JevCallResult) => void) | null = null;

  async decide(input: Parameters<JevClient["decideInner"]>[0]): Promise<JevCallResult> {
    const result = await this.decideInner(input);
    try {
      this.onResult?.(result);
    } catch {
      /* observers never affect the call */
    }
    return result;
  }

  private async decideInner(input: {
    state: Record<string, unknown>;
    questions: Record<string, JevQuestion>;
    /** Task/agent discriminator: per-session/subtask isolation. */
    taskKey?: string;
    /** Model/policy discriminator (retrieval policy, depth policy...). */
    policyKey?: string;
    /** Config discriminator: callers pass a hash of the relevant config slice. */
    configKey?: string;
    /** Candidate-hash discriminator: callers invalidate changed evidence by key change. */
    evidenceKey?: string;
    /** Optional outer abort (hook cancellation). Combined with the deadline. */
    signal?: AbortSignal;
    /**
     * Per-call timeout (P06 shared-budget propagation). Caps this call —
     * including a coalesced wait — at the given milliseconds. The leader's
     * own fetch is aborted; a timed-out joiner never aborts another
     * subscriber's live request.
     */
    timeoutMs?: number;
  }): Promise<JevCallResult> {
    if (!this.config.enabled) return { ok: false, reason: "disabled" };
    if (!this.apiKey && this.config.requireAuth !== false) {
      this.recordFailure();
      return { ok: false, reason: "missing-key" };
    }
    if (this.coolingDown) return { ok: false, reason: "cooldown" };

    const payload: JevDecisionsRequest = {
      model: this.config.model,
      state: input.state,
      questions: input.questions,
    };
    const policyKey = input.policyKey ?? "default";
    const configKey = input.configKey ?? "default";
    const evidenceKey = input.evidenceKey ?? "";
    const taskKey = input.taskKey ?? "";
    const cacheKey = hashPayload(
      payload,
      `${policyKey}\0${taskKey}\0${evidenceKey}`,
      this.config.projectKey,
      configKey,
    );

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      this.lastUsage = {
        inputTokens: cached.response.usage.input_tokens,
        outputTokens: cached.response.usage.output_tokens,
        cost: cached.response.usage.cost ?? 0,
        fromCache: true,
        issuedCall: false,
      };
      return { ok: true, response: cached.response, fromCache: true };
    }
    if (cached) this.cache.delete(cacheKey);

    if (input.timeoutMs !== undefined && input.timeoutMs <= 0) {
      return { ok: false, reason: "timeout", detail: "budget-exhausted" };
    }
    const callTimeoutMs = input.timeoutMs === undefined ? undefined : Math.max(1, input.timeoutMs);

    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      const joined =
        callTimeoutMs === undefined
          ? await existing
          : await Promise.race([
              existing,
              new Promise<JevCallResult>((resolve) =>
                setTimeout(() => resolve({ ok: false, reason: "timeout", detail: "coalesced-wait" }), callTimeoutMs),
              ),
            ]);
      // A coalesced join shares the leader's usage without issuing HTTP.
      this.lastUsage = joined.ok
        ? {
            inputTokens: joined.response.usage.input_tokens,
            outputTokens: joined.response.usage.output_tokens,
            cost: joined.response.usage.cost ?? 0,
            fromCache: false,
            issuedCall: false,
          }
        : { inputTokens: 0, outputTokens: 0, cost: 0, fromCache: false, issuedCall: false };
      return joined;
    }

    // The leader's own fetch is bounded by the tighter of the configured
    // per-operation deadline and the caller's remaining budget (P06).
    const fetchDeadlineMs =
      callTimeoutMs === undefined ? this.config.deadlineMs : Math.min(this.config.deadlineMs, callTimeoutMs);
    const pending = this.execute(payload, input.signal, fetchDeadlineMs);
    this.inFlight.set(cacheKey, pending);
    try {
      const result = await pending;
      if (result.ok) {
        this.lastUsage = {
          inputTokens: result.response.usage.input_tokens,
          outputTokens: result.response.usage.output_tokens,
          cost: result.response.usage.cost ?? 0,
          fromCache: false,
          issuedCall: true,
        };
        this.cache.set(cacheKey, {
          response: result.response,
          expiresAt: this.now() + this.config.cacheTtlMs,
        });
        while (this.cache.size > this.config.cacheMaxEntries) {
          const oldest = this.cache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
      } else {
        this.lastUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          fromCache: false,
          issuedCall: false,
        };
      }
      return result;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async execute(
    payload: JevDecisionsRequest,
    outerSignal?: AbortSignal,
    fetchDeadlineMs?: number,
  ): Promise<JevCallResult> {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) return { ok: false, reason: "timeout", detail: "already-aborted" };
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });
    }
    // The timer aborts the ACTUAL fetch (not a race around it): a timed-out
    // subscriber never leaves a mutating late response behind.
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, fetchDeadlineMs ?? this.config.deadlineMs),
    );
    try {
      let res: { ok: boolean; status: number; json(): Promise<unknown> };
      try {
        res = await this.fetchImpl(this.config.endpoint, {
          method: "POST",
          headers: {
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        this.recordFailure();
        const message = (err as Error)?.message ?? String(err);
        const isAbort = (err as Error)?.name === "AbortError" || controller.signal.aborted;
        return {
          ok: false,
          reason: isAbort ? "timeout" : "http-error",
          detail: message.slice(0, 200),
        };
      }
      if (!res.ok) {
        this.recordFailure();
        return { ok: false, reason: "http-error", detail: `status ${res.status}` };
      }
      let raw: unknown;
      try {
        raw = await res.json();
      } catch {
        this.recordFailure();
        return { ok: false, reason: "invalid-response", detail: "unparseable-json" };
      }
      const validated = validateDecisionsResponse(raw);
      if (!validated) {
        this.recordFailure();
        return { ok: false, reason: "invalid-response", detail: "schema-mismatch" };
      }
      // Model echo check: response must come from the configured provider
      // family (skipped when modelMatch is empty).
      const modelMatch = this.config.modelMatch?.trim() ? this.config.modelMatch.trim() : "";
      if (modelMatch && !validated.model.includes(modelMatch)) {
        this.recordFailure();
        return {
          ok: false,
          reason: "invalid-response",
          detail: `unexpected-model ${validated.model.slice(0, 64)}`,
        };
      }
      this.recordSuccess();
      return { ok: true, response: validated, fromCache: false };
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** Convenience: sum validated usage across calls for metrics. */
export function sumUsage(usages: JevDecisionsUsage[]): JevDecisionsUsage {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const usage of usages) {
    input += usage.input_tokens;
    output += usage.output_tokens;
    cost += usage.cost ?? 0;
  }
  return { input_tokens: input, output_tokens: output, cost };
}

/** Re-export for callers that only need answer access. */
export type { JevAnswer };
