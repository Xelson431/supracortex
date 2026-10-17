/**
 * Bundled SupraCortex Pi extension.
 *
 * - Creates one CortexService per working directory (lazy, on first use).
 * - Installs one bounded, tagged context message per task revision via the
 *   `context` hook; returns undefined when unchanged so Pi keeps system
 *   messages in place. Handler errors never break the request (Pi catches
 *   per-handler errors), but we still fail closed to deterministic behavior.
 * - Registers cortex tools + /cortex status command. Type-only Pi imports:
 *   the bundle externalizes Pi so the host supplies the runtime.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentsText, cortexText, jobsText } from "./commands.ts";
import {
  disabledCortex,
  footerStatus,
  projectLabel,
  PROVIDER_EXTRA_HEADERS,
  PROVIDER_USER_AGENT,
  providerSessionHeaders,
  unavailable,
  windowTitle,
} from "./brand.ts";
import { discoverAgents, type AgentDefinition } from "./agents.ts";
import { beginRunFile, logDebug, logError, logInfo, logWarn, runLogPath, setLogFile } from "./log.ts";
import { installOpenCodeCompatibleLocalFetch } from "./provider-fetch.ts";
import { installPacket, latestUserText, type PiMessageLike, renderPacket } from "./context.ts";
import { loadProjectCliConfig, resolveContextCaps, userConfigDir, type CliConfig } from "./config.ts";
import { CortexService } from "./service.ts";
import { JobStore } from "./job-store.ts";
import { Supervisor } from "./supervisor.ts";
import { cortexDelegateTool, cortexJobTool, cortexTools } from "./tools.ts";
import { createDashboardState, renderDashboard, renderWelcome } from "./dashboard.ts";
import { resolveRoleModel } from "./models.ts";

export const CORTEX_EXTENSION_FLAG = "cortex";
export const CORTEX_COMMAND = "cortex";

/** One CLI process = one run id for job lineage. */
const RUN_ID = randomUUID();

interface ServiceEntry {
  service: CortexService;
  cli: CliConfig | null;
  supervisor: Supervisor | null;
  agents: Map<string, AgentDefinition> | null;
}

const services = new Map<string, Promise<ServiceEntry>>();
const dashboards = new Map<string, ReturnType<typeof createDashboardState>>();
const refreshDashboards = new Map<string, () => void>();
const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const mcpStatuses = new Map<string, string>();

/** Bundled agent definitions ship with the package (templates/pi/agents). */
export function bundledAgentsDir(): string {
  // dist/pi-extension.js -> <root>/templates/pi/agents (packed layout).
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "templates", "pi", "agents");
}

async function getService(cwd: string): Promise<ServiceEntry> {
  const existing = services.get(cwd);
  if (existing) return existing;
  const pending = (async (): Promise<ServiceEntry> => {
    const [service, cli] = await Promise.all([CortexService.create(cwd), loadProjectCliConfig(cwd)]);
    return { service, cli, supervisor: null, agents: null };
  })();
  services.set(cwd, pending);
  try {
    return await pending;
  } catch (err) {
    services.delete(cwd);
    throw err;
  }
}

async function ensureAgents(cwd: string, entry: ServiceEntry): Promise<Map<string, AgentDefinition>> {
  if (entry.agents) return entry.agents;
  const agents = await discoverAgents([
    { dir: bundledAgentsDir(), layer: "bundled" },
    { dir: join(userConfigDir(), "agents"), layer: "user" },
    { dir: join(cwd, ".supracortex", "agents"), layer: "project" },
  ]);
  entry.agents = agents;
  return agents;
}

async function getSupervisor(cwd: string, entry: ServiceEntry): Promise<Supervisor | null> {
  if (entry.supervisor) return entry.supervisor;
  try {
    // File sink first: everything below lands in the per-run log too.
    const logPath = runLogPath(entry.service.storagePath, RUN_ID);
    setLogFile(logPath);
    beginRunFile(logPath, { cwd });
    logInfo("extension", "supervisor starting", { cwd });
    const agents = await ensureAgents(cwd, entry);
    const store = await JobStore.create(entry.service.storagePath);
    const supervisor = new Supervisor({
      store,
      runId: RUN_ID,
      service: entry.service,
      cli: entry.cli,
      // Auth + model catalog resolve from the host agent dir (intentional
      // sharing; the key never enters transcripts). Honors the same override
      // Pi itself respects (verified P00: PI_CODING_AGENT_DIR).
      agentDir: process.env["PI_CODING_AGENT_DIR"] ?? getAgentDir(),
      agents,
      roleModels: entry.cli?.roleModels,
      mainModel: entry.cli?.mainModel,
    });
    const { interrupted } = await supervisor.recover();
    if (interrupted) logInfo("extension", "recovered interrupted jobs", { interrupted });
    entry.supervisor = supervisor;
    logInfo("extension", "supervisor ready", { agents: agents.size });
    return supervisor;
  } catch (err) {
    logError("extension", "supervisor unavailable", { error: err instanceof Error ? err.message : "init failed", cwd });
    return null;
  }
}

export async function closeAllServices(): Promise<void> {
  const entries = [...services.values()];
  services.clear();
  for (const entry of entries) {
    try {
      const resolved = await entry;
      await resolved.supervisor?.shutdown();
      await resolved.service.close();
    } catch {
      // Best-effort shutdown.
    }
  }
}

export default function supracortexExtension(pi: ExtensionAPI): void {
  try {
    installOpenCodeCompatibleLocalFetch();
  } catch (err) {
    logWarn("extension", "provider fetch parity shim unavailable", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  pi.registerFlag(CORTEX_EXTENSION_FLAG, {
    description: "SupraCortex integration (bundled)",
    type: "boolean",
  });

  // SupraCode identity (P11): fresh-session wordmark header + editor status
  // widget + window title, TUI only. Everything is best-effort and guarded —
  // headless/print/rpc modes never see this path.
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (ctx.mode !== "tui") return;
      let cortex: "on" | "off" = "off";
      try {
        const entry = await getService(ctx.cwd);
        cortex = entry.service.status().enabled ? "on" : "off";
      } catch {
        // Fall through with cortex off; the banner still brands the session.
      }
      const project = projectLabel(ctx.cwd);
      const dashboard = createDashboardState(project);
      dashboard.cortex = cortex;
      try {
        const entry = await getService(ctx.cwd);
        dashboard.jev = entry.service.config.jev.enabled ? "on" : "off";
      } catch {
        dashboard.cortex = "unavailable";
      }
      dashboards.set(ctx.cwd, dashboard);
      dashboard.selectedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
      const entry = await getService(ctx.cwd);
      const agents = await ensureAgents(ctx.cwd, entry);
      const sampleAgent = agents.values().next().value as AgentDefinition | undefined;
      if (sampleAgent) {
        try {
          const resolved = resolveRoleModel({ role: sampleAgent.name, roleModels: entry.cli?.roleModels, agentModel: sampleAgent.model, mainModel: entry.cli?.mainModel });
          dashboard.subagentModel = `${resolved.ref.provider}/${resolved.ref.id}`;
        } catch {
          dashboard.subagentModel = "unconfigured";
        }
      }
      refreshDashboards.set(ctx.cwd, () => {
      const width = Math.max(1, process.stdout.columns || 80);
      ctx.ui.setWidget(
        "supracode-status",
        renderDashboard(dashboard, width),
        { placement: "belowEditor" },
        );
      const mcpStatus = mcpStatuses.get(ctx.cwd);
      if (mcpStatus) ctx.ui.setStatus("supracode-mcp", mcpStatus);
      });
      refreshDashboards.get(ctx.cwd)?.();
      ctx.ui.setStatus("cortex", dashboard.jobs > 0 ? `● ${dashboard.jobs} agent${dashboard.jobs === 1 ? "" : "s"} running` : undefined);
      // Fresh-session wordmark above the chat. render() receives the live
      // width on every render so narrow terminals get the compact fallback.
      ctx.ui.setHeader((_tui, theme) => ({
        render(width: number): string[] {
          return renderWelcome(project, width, (text) => theme.fg("accent", text));
        },
        invalidate() {},
      }));
      ctx.ui.setTitle(windowTitle(ctx.cwd));
    } catch (err) {
      logWarn("extension", "branding skipped", { error: err instanceof Error ? err.message : "unknown" });
    }
  });

  pi.on("model_select", (event, ctx) => {
    const dashboard = dashboards.get(ctx.cwd);
    if (!dashboard) return;
    dashboard.selectedModel = `${event.model.provider}/${event.model.id}`;
    refreshDashboards.get(ctx.cwd)?.();
  });

  // The MCP adapter owns connection lifecycle. Mirror its sanitized status
  // snapshot into the footer so startup, failures and auth needs are visible.
  // Guarded: unit-test fake hosts may not provide the shared event bus.
  pi.events?.on?.(MCP_STATUS_EVENT, (data) => {
    if (!data || typeof data !== "object") return;
    const snapshot = data as { version?: number; servers?: Array<{ status?: string }> };
    if (snapshot.version !== 1 || !Array.isArray(snapshot.servers)) return;
    const connected = snapshot.servers.filter((server) => server.status === "connected" || server.status === "cached").length;
    const failed = snapshot.servers.filter((server) => server.status === "failed" || server.status === "needs-auth");
    const pending = snapshot.servers.filter((server) => server.status === "not-connected").length;
    const auth = failed.filter((server) => server.status === "needs-auth").length;
    const parts = [`MCP ${connected}/${snapshot.servers.length}`];
    if (failed.length) parts.push(`${failed.length} issue${failed.length === 1 ? "" : "s"}${auth ? ` · ${auth} auth` : ""}`);
    else if (pending) parts.push(`${pending} on demand`);
    for (const [cwd] of dashboards) {
      mcpStatuses.set(cwd, parts.join(" · "));
      const refresh = refreshDashboards.get(cwd);
      if (!refresh) continue;
      refresh();
    }
  });

  const resolve = async (cwd: string): Promise<CortexService> => (await getService(cwd)).service;
  for (const tool of cortexTools(resolve)) {
    pi.registerTool(tool);
  }
  const resolveSupervisor = async (cwd: string) => {
    const entry = await getService(cwd);
    const supervisor = await getSupervisor(cwd, entry);
    if (!supervisor) throw new Error("SupraCortex supervisor unavailable");
    return supervisor;
  };
  pi.registerTool(cortexDelegateTool(resolveSupervisor));
  pi.registerTool(cortexJobTool(resolveSupervisor));

  pi.registerCommand(CORTEX_COMMAND, {
    description: "SupraCortex status (context, Jev, packet caps, roles, jobs, storage)",
    handler: async (_args, ctx) => {
      try {
        const entry = await getService(ctx.cwd);
        const agents = await ensureAgents(ctx.cwd, entry).catch(() => new Map());
        ctx.ui.notify(cortexText({ service: entry.service, cli: entry.cli, agents, supervisor: entry.supervisor, roleModels: entry.cli?.roleModels, mainModel: entry.cli?.mainModel }), "info");
      } catch (err) {
        ctx.ui.notify(unavailable(err instanceof Error ? err.message : "init failed"), "error");
      }
    },
  });

  pi.registerCommand("agents", {
    description: "SupraCortex agent roles (effective model, tools, provenance)",
    handler: async (args, ctx) => {
      try {
        const entry = await getService(ctx.cwd);
        const agents = await ensureAgents(ctx.cwd, entry).catch(() => new Map());
        ctx.ui.notify(agentsText({ service: entry.service, cli: entry.cli, agents, supervisor: entry.supervisor, roleModels: entry.cli?.roleModels, mainModel: entry.cli?.mainModel }, args), "info");
      } catch (err) {
        ctx.ui.notify(`agents failed: ${err instanceof Error ? err.message : "error"}`, "error");
      }
    },
  });

  pi.registerCommand("jobs", {
    description: "SupraCortex background jobs (status | result <id> | cancel <id>)",
    handler: async (args, ctx) => {
      try {
        const entry = await getService(ctx.cwd);
        const agents = await ensureAgents(ctx.cwd, entry).catch(() => new Map());
        const supervisor = await getSupervisor(ctx.cwd, entry);
        ctx.ui.notify(await jobsText({ service: entry.service, cli: entry.cli, agents, supervisor, roleModels: entry.cli?.roleModels, mainModel: entry.cli?.mainModel }, args), "info");
      } catch (err) {
        ctx.ui.notify(`jobs failed: ${err instanceof Error ? err.message : "error"}`, "error");
      }
    },
  });

  // Main-session usage reconciliation (P08): entry-id keyed, exactly-once.
  // Runs at turn_end (assistant messages exist by then) and in the context
  // hook (catch-up across restarts). The context hook alone is insufficient:
  // it fires BEFORE the pending LLM call, so the newest assistant message is
  // never visible there.
  async function reconcileMain(
    ctx: {
      cwd: string;
      sessionManager: { getSessionId(): string | undefined; getEntries(): Array<{ id?: unknown; type?: unknown; message?: unknown }> };
    },
    entry: ServiceEntry,
  ): Promise<void> {
    try {
      const supervisor = await getSupervisor(ctx.cwd, entry);
      if (!supervisor) return;
      const entries = ctx.sessionManager.getEntries();
      await supervisor.reconcileMainEntries(ctx.sessionManager.getSessionId() ?? "unknown", entries);
    } catch {
      // Best-effort; the ledger stays authoritative for what was recorded.
    }
  }

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const entry = await getService(ctx.cwd);
      await reconcileMain(ctx, entry);
    } catch (err) {
      logWarn("extension", "turn_end reconciliation failed", { error: err instanceof Error ? err.message : "unknown" });
    }
  });

  pi.on("context", async (event, ctx) => {
    let entry: ServiceEntry;
    try {
      entry = await getService(ctx.cwd);
    } catch (err) {
      logWarn("extension", "service unavailable, leaving conversation untouched", {
        error: err instanceof Error ? err.message : "init failed",
        cwd: ctx.cwd,
      });
      return undefined;
    }
    // Background completion delivery (original parent only, next boundary)
    // + keyed footer status (multi-extension safe; cleared when idle).
    try {
      const supervisor = await getSupervisor(ctx.cwd, entry);
      await supervisor?.deliverPending({
        currentSessionFile: ctx.sessionManager.getSessionFile(),
        send: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
      });
      const live = supervisor?.listLive() ?? [];
      const running = live.filter((j) => j.state === "running" || j.state === "queued").length;
      const dashboard = dashboards.get(ctx.cwd);
      if (dashboard) {
        dashboard.jobs = running;
        dashboard.lastActivity = running ? "Jobs running" : "Turn complete";
        refreshDashboards.get(ctx.cwd)?.();
      }
      const stuck = live.some((j) => j.stuck);
      ctx.ui.setStatus("cortex", running > 0 || stuck || supervisor?.isAdmissionsBlocked()
        ? footerStatus({ running, stuck, admissionsBlocked: supervisor?.isAdmissionsBlocked() ?? false })
        : undefined);
      await reconcileMain(ctx, entry);
    } catch (err) {
      logWarn("extension", "delivery/status pass failed", { error: err instanceof Error ? err.message : "unknown" });
    }
    if (!entry.service.status().enabled) {
      const dashboard = dashboards.get(ctx.cwd);
      if (dashboard) {
        dashboard.cortex = "off";
        dashboard.lastActivity = "Context integration off";
        refreshDashboards.get(ctx.cwd)?.();
      }
      logDebug("extension", "cortex disabled, skipping packet", { reason: entry.service.status().reason });
      return undefined;
    }
    const query = latestUserText(event.messages as PiMessageLike[]);
    if (!query) return undefined;
    const caps = resolveContextCaps(entry.cli);
    let packet: Awaited<ReturnType<CortexService["prepare"]>>;
    try {
      packet = await entry.service.prepare(query);
    } catch (err) {
      logWarn("extension", "packet preparation failed", { error: err instanceof Error ? err.message : "unknown" });
      return undefined;
    }
    if (!packet) return undefined;
    const rendered = renderPacket(packet, caps.mainMaxTokens);
    const dashboard = dashboards.get(ctx.cwd);
    if (dashboard) {
      dashboard.cortex = "on";
      dashboard.jev = entry.service.config.jev.enabled ? "on" : "off";
      const metrics = entry.service.engine.metricsSnapshot();
      dashboard.jevInputTokens = metrics.jevInputTokens;
      dashboard.jevOutputTokens = metrics.jevOutputTokens;
      dashboard.jevCalls = metrics.jevCalls;
      refreshDashboards.get(ctx.cwd)?.();
    }
    const next = installPacket(event.messages as PiMessageLike[], rendered);
    if (!next) return undefined;
    if (dashboard) {
      dashboard.packets += 1;
      dashboard.memories += packet.selectedMemory.length;
      dashboard.reads += packet.selectedFiles.length;
      dashboard.lastActivity = "Context packet injected";
      refreshDashboards.get(ctx.cwd)?.();
    }
    return { messages: next as typeof event.messages };
  });

  // Provider identity: send OpenCode's User-Agent on main-session provider
  // calls so proxies treat SupraCode traffic identically. Headers mutate in
  // place (Pi convention); this runs after Pi assembles headers, so ours wins.
  // Body parity with OpenCode's AI-SDK shape (verified via wire capture):
  // max_tokens (not max_completion_tokens), no `store` field,
  // tool_choice:"auto" when tools are present. A free-tier gate on `store`
  // is plausible (permission_error/insufficient_quota); anything Pi needs
  // back is read from responses, never from the echoed request.
  pi.on("before_provider_request", async (event) => {
    try {
      const payload = event.payload as Record<string, unknown> | null | undefined;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
      const next: Record<string, unknown> = { ...payload };
      if ("store" in next) delete next["store"];
      if (typeof next["max_completion_tokens"] === "number" && next["max_tokens"] === undefined) {
        next["max_tokens"] = next["max_completion_tokens"];
        delete next["max_completion_tokens"];
      }
      if (Array.isArray(next["tools"]) && next["tool_choice"] === undefined) {
        next["tool_choice"] = "auto";
      }
      // Match OpenCode's exact body: it sends NO reasoning/thinking fields
      // at all. The proxy derives effort routing from reasoning.effort,
      // reasoning_effort, effort, thinking* variants — Pi's high-effort
      // values correlate perfectly with refusals, so drop them rather than
      // merely overriding one key. Shallow copy already made; nested
      // objects are replaced, never mutated in place.
      for (const key of [
        "reasoning",
        "reasoning_effort",
        "reasoningEffort",
        "effort",
        "thinking",
        "thinkingLevel",
        "thinking_level",
        "thinkingBudget",
        "thinking_budget",
        "thinkingConfig",
      ]) {
        if (key in next) delete next[key];
      }
      logDebug("extension", "provider payload normalized", { keys: Object.keys(next).join(",") });
      return next;
    } catch (err) {
      logWarn("extension", "payload normalization failed", { error: err instanceof Error ? err.message : "unknown" });
      return undefined;
    }
  });

  // Per-process session pair, mirroring OpenCode's x-session-affinity/id.
  const sessionHeaders = providerSessionHeaders();
  pi.on("before_provider_headers", async (event) => {
    try {
      event.headers["User-Agent"] = PROVIDER_USER_AGENT;
      for (const [key, value] of Object.entries(PROVIDER_EXTRA_HEADERS)) {
        event.headers[key] = value;
      }
      for (const [key, value] of Object.entries(sessionHeaders)) {
        event.headers[key] = value;
      }
      // Pi's HTTP stack tags requests with x-stainless-* telemetry headers;
      // OpenCode sends none. Null deletes per the headers contract.
      for (const key of Object.keys(event.headers)) {
        if (key.toLowerCase().startsWith("x-stainless-")) event.headers[key] = null;
      }
      logDebug("extension", "provider identity headers set", { agent: PROVIDER_USER_AGENT });
    } catch (err) {
      logWarn("extension", "identity headers override failed", { error: err instanceof Error ? err.message : "unknown" });
    }
  });

  // NOTE (P08): compaction summary calls are billable, but the
  // `session_compact` event carries no usage object and core exposes no
  // compaction-count sink, so compaction tokens are currently unattributed
  // (recorded as an open gap in VALIDATION_LOG, not estimated).

  pi.on("session_shutdown", () => {
    refreshDashboards.clear();
    dashboards.clear();
    void closeAllServices();
  });
}
