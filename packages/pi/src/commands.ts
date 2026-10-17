/**
 * P07 slash commands: /agents, /jobs, /cortex. Pure text builders over live
 * state (testable without Pi); the extension only routes + notifies.
 * No header/footer/editor changes — Pi chrome is preserved by design.
 */

import { effectiveDecisionTiming, resolveDecisionProvider } from "@local/supracortex-core";
import type { AgentDefinition } from "./agents.ts";
import type { CliConfig, ModelRef } from "./config.ts";
import { resolveContextCaps, resolveJobLimits } from "./config.ts";
import { resolveRoleModel } from "./models.ts";
import type { CortexService } from "./service.ts";
import type { Supervisor } from "./supervisor.ts";

export interface CommandDeps {
  service: CortexService;
  cli: CliConfig | null;
  agents: Map<string, AgentDefinition>;
  supervisor: Supervisor | null;
  roleModels?: Record<string, ModelRef>;
  mainModel?: ModelRef;
}

function effectiveModel(deps: CommandDeps, agent: AgentDefinition): string {
  try {
    const { ref, provenance } = resolveRoleModel({
      role: agent.name,
      roleModels: deps.roleModels,
      agentModel: agent.model,
      mainModel: deps.mainModel,
    });
    return `${ref.provider}/${ref.id} (${provenance})`;
  } catch {
    return "unconfigured (no main/role/agent model)";
  }
}

/** /agents [role]: effective model/tools/provenance per role. */
export function agentsText(deps: CommandDeps, args: string): string {
  const name = args.trim().split(/\s+/, 1)[0] ?? "";
  if (name) {
    const agent = deps.agents.get(name);
    if (!agent) return `unknown role "${name.slice(0, 48)}"`;
    return [
      `role: ${agent.name} [${agent.layer}]`,
      `model: ${effectiveModel(deps, agent)}`,
      `thinking: ${agent.thinking ?? "session default"}`,
      `tools: ${agent.tools.join(", ")}`,
      `skills: ${agent.skills.join(", ") || "none"}`,
      `description: ${agent.description}`,
    ].join("\n");
  }
  if (!deps.agents.size) return "no agent roles defined";
  return [...deps.agents.values()]
    .map((a) => `- ${a.name} [${a.layer}]: ${effectiveModel(deps, a)} | tools: ${a.tools.join(",")}`)
    .join("\n");
}

/** /jobs [status|result <id>|cancel <id>]: background job control. */
export async function jobsText(deps: CommandDeps, args: string): Promise<string> {
  const sup = deps.supervisor;
  if (!sup) return "job supervisor unavailable";
  const [verb = "status", rest = ""] = args.trim().split(/\s+/, 2) as [string?, string?];
  if (verb === "cancel" && rest) {
    try {
      const state = await sup.cancel(rest);
      return `job ${rest.slice(0, 8)}: ${state}`;
    } catch (err) {
      return `cancel failed: ${err instanceof Error ? err.message : "error"}`;
    }
  }
  if (verb === "result" && rest) {
    try {
      const text = await sup.loadResultText(sup.currentRunId, rest);
      return text ?? `no stored result for ${rest.slice(0, 8)}`;
    } catch (err) {
      return `result failed: ${err instanceof Error ? err.message : "error"}`;
    }
  }
  const live = sup.listLive();
  const limits = sup.limits();
  const lines = live.map(
    (j) => `- ${j.id.slice(0, 8)} (${j.role}): ${j.state}${j.stuck ? " [STUCK: abort unsettled, admissions blocked]" : ""}`,
  );
  return [
    `jobs: ${live.length} live (max ${limits.maxRunning} running)${sup.isAdmissionsBlocked() ? " [ADMISSIONS BLOCKED]" : ""}`,
    ...lines,
  ].join("\n");
}

/** /cortex: enabled state, packet budget, index/graph, Jev, agents, jobs. */
export function cortexText(deps: CommandDeps): string {
  const s = deps.service.status();
  const caps = resolveContextCaps(deps.cli);
  const limits = resolveJobLimits(deps.cli);
  const live = deps.supervisor?.listLive() ?? [];
  const metrics = deps.service.engine.metricsSnapshot();
  return [
    `cortex: ${s.enabled ? "enabled" : "disabled"} (${s.reason})`,
    `decision: ${s.jevSuppressed ? "off (deterministic-only)" : `on via ${resolveDecisionProvider(deps.service.config.jev).id}/${resolveDecisionProvider(deps.service.config.jev).model} (budget ${effectiveDecisionTiming(deps.service.config.jev).enrichmentBudgetMs}ms/req)`}`,
    `jev usage (measured, this process): ${metrics.jevInputTokens} input / ${metrics.jevOutputTokens} output tokens · ${metrics.jevCalls} validated responses`,
    `packet caps: main ${caps.mainMaxTokens} / child ${caps.childMaxTokens} tokens`,
    `jobs: ${live.length} live (max ${limits.maxRunning} running, ${limits.maxQueued} queued)`,
    `roles: ${[...deps.agents.keys()].join(", ") || "none"}`,
    `storage: ${s.storagePath}`,
  ].join("\n");
}
