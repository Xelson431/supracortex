/**
 * Model-agnostic decision providers over the System One wire protocol.
 *
 * Jev, Laya (self-hosted or hosted) and any compatible endpoint all speak
 * `POST {endpoint}` with `{ model, state, questions }` and return validated
 * typed answers. A "provider" is therefore configuration, not code: endpoint
 * URL, model id, credential env var, auth mode, and the expected model echo.
 *
 * The `JevClient` class name is historical (it is really a System One
 * decision client); renaming it would churn every caller for zero behavior
 * gain. The user-facing concept is "decision model", with `jev` kept as the
 * default provider id and legacy config alias.
 */

export type DecisionProviderId = "jev" | "laya-local" | "laya-hosted" | "custom";

export const DECISION_PROVIDER_IDS: readonly DecisionProviderId[] = [
  "jev",
  "laya-local",
  "laya-hosted",
  "custom",
];

export interface DecisionProviderPreset {
  readonly id: DecisionProviderId;
  /** Short human label for status surfaces (no secrets). */
  readonly label: string;
  readonly endpoint: string;
  readonly model: string;
  /** Env var holding the bearer credential. Empty = preset default. */
  readonly apiKeyEnv: string;
  /** Whether a bearer credential is required to call. */
  readonly requireAuth: boolean;
  /** Substring the response `model` field must include. Empty = skip check. */
  readonly modelMatch: string;
  /**
   * Measured-latency-based default per-turn budget (ms) used when the user has
   * not set jev.deadlineMs / jev.enrichmentBudgetMs. Jev answers in ~250-500
   * ms; local Laya takes ~1.9 s warm on this class of hardware.
   */
  readonly defaultBudgetMs: number;
  /** Max serialized request chars the model reads without truncation. */
  readonly maxInputChars: number;
  /**
   * Max questions per request. Laya's cost is linear in question count
   * (~0.6 s each on CPU), so the per-turn budget, not the encoder window, is
   * what bounds it.
   */
  readonly maxQuestions: number;
  /** Max chars of candidate text per question (latency scales with tokens). */
  readonly snippetChars: number;
}

const JEV_PRESET: DecisionProviderPreset = {
  id: "jev",
  label: "TypeSafe Jev (OpenRouter)",
  endpoint: "https://openrouter.ai/api/v1/systemone",
  model: "typesafe/jev-1.13",
  apiKeyEnv: "OPENROUTER_API_KEY",
  requireAuth: true,
  modelMatch: "jev",
  defaultBudgetMs: 800,
  maxInputChars: 12_000,
  maxQuestions: 18,
  snippetChars: 220,
};

const LAYA_LOCAL_PRESET: DecisionProviderPreset = {
  id: "laya-local",
  label: "Laya self-hosted (laya-serve)",
  endpoint: "http://127.0.0.1:8000/v1/systemone",
  model: "convaiinnovations/laya",
  apiKeyEnv: "LAYA_API_KEY",
  // laya-serve deployments are bearer-protected (unauthenticated calls get
  // 401). Unprotected dev servers can opt out with `auth: "none"`.
  requireAuth: true,
  modelMatch: "laya",
  defaultBudgetMs: 2_500,
  // Laya's encoder window is 512 tokens; longer requests are silently truncated.
  maxInputChars: 1_800,
  // Measured locally (CPU, ~6 ms per input token + ~0.5 s per question):
  // two short questions fit the 2.5 s budget with headroom under load.
  maxQuestions: 2,
  snippetChars: 90,
};

const LAYA_HOSTED_PRESET: DecisionProviderPreset = {
  id: "laya-hosted",
  label: "Laya hosted (System One compatible)",
  // No default: the hosted base URL is account/deployment specific.
  // Set `jev.endpoint` explicitly (plus model/apiKeyEnv as needed).
  endpoint: "",
  model: "convaiinnovations/laya",
  apiKeyEnv: "LAYA_API_KEY",
  requireAuth: true,
  modelMatch: "laya",
  defaultBudgetMs: 2_500,
  maxInputChars: 1_800,
  maxQuestions: 2,
  snippetChars: 90,
};

export const DECISION_PROVIDER_PRESETS: Record<DecisionProviderId, DecisionProviderPreset> = {
  jev: JEV_PRESET,
  "laya-local": LAYA_LOCAL_PRESET,
  "laya-hosted": LAYA_HOSTED_PRESET,
  custom: {
    id: "custom",
    label: "Custom System One endpoint",
    endpoint: "",
    model: "",
    apiKeyEnv: "",
    requireAuth: true,
    modelMatch: "",
    defaultBudgetMs: 1_200,
    maxInputChars: 4_000,
    maxQuestions: 8,
    snippetChars: 160,
  },
};

/**
 * Model id that older configs wrote verbatim as the default. It is honoured as
 * "inherit the preset" for non-Jev, non-custom providers so a config switched to
 * Laya by editing only `provider` keeps working. New configs leave `model` empty.
 */
export const LEGACY_DEFAULT_MODEL = "typesafe/jev-1.13";

export interface DecisionProviderInput {
  provider?: string;
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
  /** "auto" follows the preset; "bearer"/"none" override it. */
  auth?: string;
  modelMatch?: string;
}

export interface ResolvedDecisionProvider {
  readonly id: DecisionProviderId;
  readonly label: string;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly requireAuth: boolean;
  readonly modelMatch: string;
}

export function isDecisionProviderId(value: unknown): value is DecisionProviderId {
  return (
    typeof value === "string" &&
    (DECISION_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/**
 * Resolve effective provider settings from user config.
 *
 * Every field is "empty means inherit the preset": `endpoint`, `model`,
 * `apiKeyEnv`, `modelMatch`, and `auth: "auto"`. Switching provider is therefore
 * a one-field change (`provider`). For compatibility, the legacy default model
 * id is also treated as empty for providers other than Jev and custom.
 */
export function resolveDecisionProvider(input: DecisionProviderInput = {}): ResolvedDecisionProvider {
  const id: DecisionProviderId = isDecisionProviderId(input.provider) ? input.provider : "jev";
  const preset = DECISION_PROVIDER_PRESETS[id];
  const endpoint = input.endpoint?.trim() ? input.endpoint.trim() : preset.endpoint;
  const apiKeyEnv = input.apiKeyEnv?.trim() ? input.apiKeyEnv.trim() : preset.apiKeyEnv;
  const modelMatch = input.modelMatch?.trim() ? input.modelMatch.trim() : preset.modelMatch;
  const rawModel = input.model?.trim() ?? "";
  const inheritsModel = !rawModel || (rawModel === LEGACY_DEFAULT_MODEL && id !== "jev" && id !== "custom");
  const model = inheritsModel ? preset.model || rawModel : rawModel;
  const auth = input.auth?.trim() ?? "auto";
  const requireAuth = auth === "none" ? false : auth === "bearer" ? true : preset.requireAuth;
  return { id, label: preset.label, endpoint, model, apiKeyEnv, requireAuth, modelMatch };
}

/**
 * Effective timing for a provider. `-1` (or any negative) in config means
 * "provider default"; an explicit value always wins, including 0 (which
 * disables enrichment).
 */
export function effectiveDecisionTiming(input: DecisionProviderInput & { deadlineMs?: number; enrichmentBudgetMs?: number }): {
  deadlineMs: number;
  enrichmentBudgetMs: number;
  maxInputChars: number;
  maxQuestions: number;
  snippetChars: number;
} {
  const preset = DECISION_PROVIDER_PRESETS[isDecisionProviderId(input.provider) ? input.provider : "jev"];
  const pick = (v: number | undefined) => (typeof v === "number" && v >= 0 ? v : preset.defaultBudgetMs);
  return {
    deadlineMs: Math.max(100, pick(input.deadlineMs)),
    enrichmentBudgetMs: pick(input.enrichmentBudgetMs),
    maxInputChars: preset.maxInputChars,
    maxQuestions: preset.maxQuestions,
    snippetChars: preset.snippetChars,
  };
}
