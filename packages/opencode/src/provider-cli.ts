/**
 * `supracode provider list|show|use|check` — decision-provider switching.
 *
 * Switching provider is a machine-level choice, so `use` writes ONLY
 * `jev.provider` into the global config (or a project config with --project)
 * and clears the per-provider override fields that would otherwise pin the old
 * provider's endpoint/model/key. Everything else inherits the preset.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import {
  DECISION_PROVIDER_IDS,
  DECISION_PROVIDER_PRESETS,
  JevClient,
  isDecisionProviderId,
  effectiveDecisionTiming,
  resolveCredential,
  resolveDecisionProvider,
  type DecisionProviderId,
} from "@local/supracortex-core";
import { globalConfigPath, loadConfig } from "./config-loader.ts";

/** Fields that belong to a specific provider and must not survive a switch. */
const PROVIDER_SPECIFIC_FIELDS = ["endpoint", "model", "apiKeyEnv", "modelMatch", "auth"] as const;

export interface ProviderShow {
  provider: DecisionProviderId;
  label: string;
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKeyEnv: string;
  requireAuth: boolean;
  credential: "found" | "missing" | "not-required";
  credentialSource?: string;
  deadlineMs: number;
  enrichmentBudgetMs: number;
  configSource: { global: string; project: string; ignoredProjectKeys: string[] };
}

export async function providerShow(projectRoot: string): Promise<ProviderShow> {
  const loaded = await loadConfig({ projectRoot, env: process.env });
  const jev = loaded.config.jev;
  const p = resolveDecisionProvider(jev);
  const cred = p.apiKeyEnv ? resolveCredential(p.apiKeyEnv, { credentialsFile: jev.credentialsFile }) : null;
  return {
    provider: p.id,
    label: p.label,
    enabled: jev.enabled,
    endpoint: p.endpoint,
    model: p.model,
    apiKeyEnv: p.apiKeyEnv,
    requireAuth: p.requireAuth,
    credential: !p.requireAuth ? "not-required" : cred ? "found" : "missing",
    ...(cred ? { credentialSource: cred.source } : {}),
    deadlineMs: effectiveDecisionTiming(jev).deadlineMs,
    enrichmentBudgetMs: effectiveDecisionTiming(jev).enrichmentBudgetMs,
    configSource: {
      global: loaded.globalConfigPath,
      project: loaded.projectConfigPath,
      ignoredProjectKeys: loaded.ignoredProjectKeys.filter((k) => k.startsWith("jev.")),
    },
  };
}

export function providerList(): Array<{ id: DecisionProviderId; label: string; endpoint: string; model: string; apiKeyEnv: string }> {
  return DECISION_PROVIDER_IDS.map((id) => {
    const p = DECISION_PROVIDER_PRESETS[id];
    return { id, label: p.label, endpoint: p.endpoint || "(set jev.endpoint)", model: p.model || "(set jev.model)", apiKeyEnv: p.apiKeyEnv };
  });
}

export interface ProviderUseOptions {
  /** Extra explicit fields (for custom/laya-hosted). */
  endpoint?: string;
  model?: string;
}

export async function providerUse(projectRoot: string, id: string, opts: ProviderUseOptions = {}): Promise<{ path: string; provider: DecisionProviderId; notes: string[] }> {
  if (!isDecisionProviderId(id)) {
    throw new Error(`unknown provider "${id}" (expected one of: ${DECISION_PROVIDER_IDS.join(", ")})`);
  }
  if ((id === "custom" || id === "laya-hosted") && !opts.endpoint) {
    throw new Error(`provider "${id}" needs --endpoint <url>`);
  }
  // Provider is a machine-wide setting: always the central config.
  const path = globalConfigPath();
  let text = "{}\n";
  try {
    text = await readFile(path, "utf8");
  } catch {
    await mkdir(dirname(path), { recursive: true });
  }
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`refusing to edit unparseable config ${path}`);
  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  let next = applyEdits(text, modify(text, ["jev", "provider"], id, fmt));
  for (const field of PROVIDER_SPECIFIC_FIELDS) {
    next = applyEdits(next, modify(next, ["jev", field], undefined, fmt));
  }
  if (opts.endpoint) next = applyEdits(next, modify(next, ["jev", "endpoint"], opts.endpoint, fmt));
  if (opts.model) next = applyEdits(next, modify(next, ["jev", "model"], opts.model, fmt));
  await writeFile(path, next, "utf8");

  const notes: string[] = [];
  {
    const shown = await providerShow(projectRoot);
    if (shown.credential === "missing") {
      notes.push(`no credential found for ${shown.apiKeyEnv}; export it or put '${shown.apiKeyEnv}=…' in ~/.config/supracortex/<name>.env`);
    }
  }
  notes.push("Restart running OpenCode/SupraCode sessions to pick up the change.");
  return { path, provider: id, notes };
}

export interface ProviderCheck {
  provider: DecisionProviderId;
  ok: boolean;
  reason?: string;
  latencyMs: number;
  echoedModel?: string;
  inputTokens?: number;
}

/** One authenticated probe. Deliberately small; bypasses the decision cache. */
export async function providerCheck(projectRoot: string, timeoutMs = 15_000, env: NodeJS.ProcessEnv = process.env): Promise<ProviderCheck> {
  const loaded = await loadConfig({ projectRoot, env });
  const jev = loaded.config.jev;
  const p = resolveDecisionProvider(jev);
  const cred = p.apiKeyEnv ? resolveCredential(p.apiKeyEnv, { env, credentialsFile: jev.credentialsFile }) : null;
  const client = new JevClient({
    config: {
      enabled: true,
      deadlineMs: timeoutMs,
      endpoint: p.endpoint,
      model: p.model,
      apiKeyEnv: p.apiKeyEnv,
      requireAuth: p.requireAuth,
      modelMatch: p.modelMatch,
      projectKey: "provider-check",
      cacheTtlMs: 0,
    },
    apiKey: cred?.value ?? null,
  });
  const started = performance.now();
  const r = await client.decide({
    state: { probe: "supracode provider check" },
    questions: { ready: { type: "noul", instructions: "Is this request a health check?", criteria: { true: "It is a health check.", false: "It is not a health check." } } },
    timeoutMs,
    taskKey: `check-${Date.now()}`,
    policyKey: "check",
    configKey: "check",
    evidenceKey: "check",
  });
  const latencyMs = Math.round(performance.now() - started);
  return r.ok
    ? { provider: p.id, ok: true, latencyMs, echoedModel: r.response.model, inputTokens: r.response.usage?.input_tokens }
    : { provider: p.id, ok: false, latencyMs, reason: `${r.reason}${r.detail ? `: ${r.detail}` : ""}` };
}
