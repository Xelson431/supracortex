/**
 * Tool factory. Builds the OpenCode tool map from a PluginRuntime.
 *
 * We construct tools with the `tool()` helper from @opencode-ai/plugin/tool so
 * zod arg schemas match OpenCode's expectations. Every tool:
 *   - checks the feature gate first and returns a bounded disabled response;
 *   - has a strict input schema and bounded output;
 *   - never invokes a model;
 *   - never throws to OpenCode (errors are caught and returned as text).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import type { PluginRuntime } from "../runtime.ts";
import { renderPacketForPrompt } from "../packet-rendering.ts";
import { formatMetrics } from "@local/supracortex-core";

import type { HostCapabilities } from "@local/supracortex-core";
import {
  resolveProviderCachePolicy,
  redactSecrets,
  type ProviderCachePolicyIntent,
} from "@local/supracortex-core";
import { processProviderCacheIntent } from "../provider-cache-adapter.ts";

const z = tool.schema;

/**
 * OpenCode native capabilities. OpenCode provides in-process hooks that exceed
 * MCP's tool-only surface: it can read the user task from request properties,
 * inject system context via experimental.chat.system.transform, observe
 * completed assistant usage, and receive lifecycle events. It cannot set
 * provider options or cache breakpoints (those remain host-managed).
 */
function openCodeCapabilities(): HostCapabilities {
  return {
    host: "opencode",
    integration: "native",
    readUserTask: "supported",
    injectRequestContext: "supported",
    observeUsage: "supported",
    observeCost: "supported",
    observeCompaction: "unsupported",
    setProviderOptions: "unsupported",
    setCacheBreakpoints: "unsupported",
    lifecycleEvents: "supported",
    operationParity: "supported",
    evidence: ["experimental.chat.system.transform", "event hook", "tool() API"],
  };
}

const DISABLED = "supracortex is disabled; no action taken.";

function bounded(text: string, max = 12000): string {
  return text.length > max ? text.slice(0, max) + "\n…(truncated)" : text;
}

/**
 * Run a tool handler behind the feature gate with a structural safety net.
 *
 * Any throw from `fn` (malformed model-supplied args reaching unvalidated
 * code paths, unexpected engine errors, etc.) is caught here and converted
 * into a bounded `{ error }` result instead of propagating to the OpenCode
 * host as an unhandled rejection. This mirrors the "never throw to the host"
 * convention used for lifecycle hooks in plugin.ts (silent catch, safe
 * fallback) — no new logging dependency is introduced.
 */
export async function guard<T>(
  rt: PluginRuntime,
  fn: () => Promise<T>,
): Promise<T | { disabled: true } | { error: string }> {
  if (!rt.gate.active) return { disabled: true };
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: redactSecrets(message).text.slice(0, 500) };
  }
}

function isGuardDisabled(res: unknown): res is { disabled: true } {
  return typeof res === "object" && res !== null && (res as { disabled?: unknown }).disabled === true;
}

function isGuardError(res: unknown): res is { error: string } {
  return (
    typeof res === "object" &&
    res !== null &&
    typeof (res as { error?: unknown }).error === "string" &&
    !isGuardDisabled(res)
  );
}

/**
 * Normalize an optional array-of-strings argument that a model may send with
 * the wrong shape. `undefined` is preserved (so downstream `?? []`/"release
 * all" semantics are unaffected); a bare string is wrapped; anything else
 * (number, object, etc.) becomes an empty array — a safe no-op rather than a
 * crash.
 */
function toOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

/** Pass an array-typed argument through unchanged; anything else becomes undefined. */
function toArrayOrUndefined<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

export function buildTools(rt: PluginRuntime): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {
    cortex_prepare_context: tool({
      description:
        "Prepare a bounded, explained context packet for a task: relevant memory, files, summaries, git changes, skill and MCP recommendations, and a token budget. Does not call a model.",
      args: {
        query: z.string().describe("Natural-language description of the task"),
        hintFiles: z.array(z.string()).optional().describe("Files already known relevant"),
        tags: z.array(z.string()).optional(),
        maxTokens: z.number().int().positive().optional(),
        agent: z.string().optional().describe("Target agent role for skill/MCP recommendations"),
        loadedSkills: z.array(z.string()).optional(),
      },
      async execute(args, _ctx) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return { text: DISABLED, meta: {} };
          const gather = await rt.gather(args.agent, toOptionalStringArray(args.loadedSkills) ?? []);
          const task: Parameters<typeof engine.prepareContext>[0] = { query: args.query };
          const hintFiles = toOptionalStringArray(args.hintFiles);
          const tags = toOptionalStringArray(args.tags);
          if (hintFiles) task.hintFiles = hintFiles;
          if (tags) task.tags = tags;
          if (args.maxTokens) task.maxTokens = args.maxTokens;
          const packet = await engine.prepareContext(task, gather);
          if (!packet) return { text: DISABLED, meta: {} };
          return {
            text: renderPacketForPrompt(packet),
            meta: {
              taskId: packet.taskId,
              estimatedTokens: packet.estimatedTokens,
              files: packet.selectedFiles.length,
              memory: packet.selectedMemory.length,
              omissions: packet.omissions.length,
            },
          };
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "prepare-context", output: `Error: ${res.error}` };
        return { title: "prepare-context", output: bounded(res.text), metadata: res.meta };
      },
    }),

    cortex_search_memory: tool({
      description:
        "Search persistent project memory (facts, decisions, conventions, failures, constraints) for entries relevant to a query. Returns ranked entries with reasons.",
      args: {
        query: z.string(),
        tags: z.array(z.string()).optional(),
        hintFiles: z.array(z.string()).optional(),
      },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const sel = await engine.searchMemory(args.query, {
            tags: toOptionalStringArray(args.tags) ?? [],
            hintFiles: toOptionalStringArray(args.hintFiles) ?? [],
          });
          if (!sel.length) return "No matching memory entries.";
          return sel
            .map(
              (s) =>
                `- [${s.entry.kind} ${s.score}] ${s.entry.content}\n  reason: ${s.reason}`,
            )
            .join("\n");
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "search-memory", output: `Error: ${res.error}` };
        return { title: "search-memory", output: bounded(res as string) };
      },
    }),

    cortex_record_memory: tool({
      description:
        "Record a durable memory entry. Active durable facts/decisions/conventions/constraints require evidence (sourceReferences); pass status \"candidate\" to submit one for review without evidence. Content is redacted for likely secrets. Never record secrets or transcripts.",
      args: {
        kind: z.enum(["fact", "decision", "convention", "failure", "constraint", "task-outcome"]),
        content: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        status: z
          .enum(["active", "candidate"])
          .optional()
          .describe("candidate = submit for review; active = default when evidence is present"),
        sourceReferences: z
          .array(
            z.object({
              kind: z.enum(["file", "commit", "command", "external", "session"]),
              value: z.string(),
              note: z.string().optional(),
            }),
          )
          .optional(),
        relatedFiles: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const out = await engine.recordMemory({
            kind: args.kind,
            content: args.content,
            confidence: args.confidence,
            status: args.status,
            sourceReferences: toArrayOrUndefined(args.sourceReferences),
            relatedFiles: toOptionalStringArray(args.relatedFiles),
            tags: toOptionalStringArray(args.tags),
          });
          if (out.status === "rejected") return `Rejected: ${out.reason}`;
          const notes = [out.redacted ? "redacted secrets" : "", out.disputed ? "marked DISPUTED (contradiction)" : ""].filter(Boolean);
          return `Recorded ${args.kind} (${out.entry?.id})${notes.length ? ` [${notes.join("; ")}]` : ""}`;
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "record-memory", output: `Error: ${res.error}` };
        return { title: "record-memory", output: bounded(res as string) };
      },
    }),

    cortex_record_outcome: tool({
      description:
        "Record a task outcome (success/failure/partial). Pass back the incarnationId returned by cortex_claim_files. Releases file ownership and persists verified learnings to memory. Do not include secrets or transcripts.",
      args: {
        operationId: z.string().max(120).optional(),
        taskId: z.string(),
        incarnationId: z.string().optional(),
        status: z.enum(["success", "failure", "partial"]),
        summary: z.string(),
        touchedFiles: z.array(z.string()).optional(),
        learnings: z.array(z.string()).optional(),
        failureReason: z.string().optional(),
      },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const outcome = await engine.recordOutcome({
            operationId: args.operationId,
            taskId: args.taskId,
            incarnationId: args.incarnationId,
            status: args.status,
            summary: args.summary,
            touchedFiles: args.touchedFiles ?? [],
            learnings: Array.isArray(args.learnings)
              ? args.learnings
              : typeof args.learnings === "string"
                ? [args.learnings]
                : [],
            failureReason: args.failureReason,
            recordedAt: new Date().toISOString(),
          });
          return JSON.stringify(outcome);
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "record-outcome", output: `Error: ${res.error}` };
        return { title: "record-outcome", output: bounded(res as string) };
      },
    }),

    cortex_plan_tasks: tool({
      description:
        "Plan parallel task execution: infer dependencies, detect write conflicts and duplicate work, and produce execution waves with per-task file ownership and context budgets. Recommends order; does not execute agents.",
      args: {
        tasks: z.array(
          z.object({
            id: z.string().optional(),
            title: z.string(),
            objective: z.string(),
            readScope: z.array(z.string()).optional(),
            writeScope: z.array(z.string()).optional(),
            suggestedAgentRole: z.string().optional(),
            dependencies: z.array(z.string()).optional(),
            completionCriteria: z.array(z.string()).optional(),
          }),
        ),
      },
      async execute(args) {
        const res = await guard(rt, async () => {
          if (!Array.isArray(args.tasks)) return { error: "tasks must be an array" };
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const plan = engine.planTasks(args.tasks);
          if (!plan) return "Parallel planning disabled.";
          return JSON.stringify(plan, null, 2);
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "plan-tasks", output: `Error: ${res.error}` };
        return { title: "plan-tasks", output: bounded(res as string) };
      },
    }),

    cortex_claim_files: tool({
      description:
        "Claim write-ownership of files for a task to prevent overlapping writes across parallel tasks. Returns granted and denied (already-owned) paths.",
      args: { taskId: z.string(), files: z.array(z.string()) },
      async execute(args) {
        const res = await guard(rt, async () => {
          if (!Array.isArray(args.files)) return { error: "files must be an array" };
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const r = await engine.claimFiles(args.taskId, args.files);
          return JSON.stringify(r);
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "claim-files", output: `Error: ${res.error}` };
        return { title: "claim-files", output: bounded(res as string) };
      },
    }),

    cortex_release_files: tool({
      description: "Release file ownership using the exact lease ID and fencing token returned by cortex_claim_files.",
      args: { taskId: z.string(), leaseId: z.string().uuid(), fencingToken: z.number().int().positive(), files: z.array(z.string()).optional() },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const result = await engine.releaseFiles(
            args.taskId,
            args.leaseId,
            args.fencingToken,
            toOptionalStringArray(args.files),
          );
          return JSON.stringify(result);
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "release-files", output: `Error: ${res.error}` };
        return { title: "release-files", output: bounded(res as string) };
      },
    }),

    cortex_validate_cache: tool({
      description:
        "Validate the local summary cache against current file hashes. Reports valid, stale, and missing entries and drops stale ones.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const r = await engine.validateCache();
          return `valid: ${r.valid.length}, stale (dropped): ${r.stale.length}, missing: ${r.missing.length}`;
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "validate-cache", output: `Error: ${res.error}` };
        return { title: "validate-cache", output: bounded(res as string) };
      },
    }),

    cortex_compact: tool({
      description:
        "Compact superseded/expired memory while preserving an audit trail. Never discards unresolved failures or active constraints.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const r = await engine.compactMemory();
          return `superseded: ${r.superseded}, expired: ${r.expired}, kept: ${r.kept.length}`;
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "compact", output: `Error: ${res.error}` };
        return { title: "compact", output: bounded(res as string) };
      },
    }),

    cortex_sweep: tool({
      description:
        "Run the time-based staleness sweep now: reap abandoned tasks, release expired file ownership, expire old sessions, prune stale cache, flag durable memory for re-verification, and trim the completed-task log. Idempotent and safe.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const r = await engine.sweep("manual-tool", { force: true });
          if (!r) return "Sweep skipped (disabled).";
          if (r.clean) return "System clean: nothing stale to sweep.";
          return [
            `abandoned tasks: ${r.abandonedTasks.length}`,
            `released ownership: ${r.releasedOwnership.length}`,
            `expired sessions: ${r.expiredSessions.length}`,
            `pruned cache: ${r.prunedCacheEntries}`,
            `memory flagged for reverify: ${r.memoryFlaggedForReverify.length}`,
            `pruned completed tasks: ${r.prunedCompletedTasks}`,
          ].join("\n");
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "sweep", output: `Error: ${res.error}` };
        return { title: "sweep", output: bounded(res as string) };
      },
    }),

    cortex_metrics: tool({
      description:
        "Show session metrics (estimates, not provider billing): files considered/opened, cache hits, duplicate detection, and estimated context reduction.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          return formatMetrics(engine.metricsSnapshot());
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "metrics", output: `Error: ${res.error}` };
        return { title: "metrics", output: bounded(res as string) };
      },
    }),

    cortex_sync_supraspace: tool({
      description:
        "Unify memory with SupraSpace: ingest human/agent notes from .supraspace/*.md as candidate memory (deduped, loop-safe) and project Cortex's structured memory back into marker-fenced managed blocks in those files. Idempotent; preserves human-authored text. No-op when there is no .supraspace directory.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const r = await engine.syncSupraSpace();
          if (r.skippedReason) return `Skipped: ${r.skippedReason}`;
          return [
            `files written: ${r.filesWritten.join(", ") || "none"}`,
            `projected entries: ${r.projectedEntries}`,
            `ingested candidates: ${r.ingestedCandidates}`,
            `ingested recorded: ${r.ingestedRecorded}`,
          ].join("\n");
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "sync-supraspace", output: `Error: ${res.error}` };
        return { title: "sync-supraspace", output: bounded(res as string) };
      },
    }),

    cortex_code_graph_status: tool({
      description: "Show the explicit local code graph's enablement, active generation, and bounded size. Read-only; no model or network call.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          return engine ? JSON.stringify(await engine.codeGraphStatus()) : DISABLED;
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "code-graph-status", output: `Error: ${res.error}` };
        return { title: "code-graph-status", output: bounded(res as string) };
      },
    }),

    cortex_code_graph_rebuild: tool({
      description: "Explicitly rebuild the local file/symbol/import graph from the confined project index. Does not execute code, use a model, or mutate Git.",
      args: { forceIndex: z.boolean().optional() },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const graph = await engine.rebuildCodeGraph(args.forceIndex === true);
          return JSON.stringify({ rebuilt: graph !== null, graph: await engine.codeGraphStatus() });
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "code-graph-rebuild", output: `Error: ${res.error}` };
        return { title: "code-graph-rebuild", output: bounded(res as string) };
      },
    }),

    cortex_code_graph_query: tool({
      description: "Query bounded neighboring deterministic code facts. Selector must be path:<file>, symbol:<file>#<symbol>, or node:<sha256>.",
      args: { selector: z.string().max(600), maxDepth: z.number().int().min(1).max(5).optional(), maxResults: z.number().int().min(1).max(50).optional(), maxFanout: z.number().int().min(1).max(200).optional() },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          return JSON.stringify(await engine.queryCodeGraphNeighbors(args.selector as import("@local/supracortex-core").CodeGraphSelector, args));
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "code-graph-query", output: `Error: ${res.error}` };
        return { title: "code-graph-query", output: bounded(res as string) };
      },
    }),

    cortex_code_graph_path: tool({
      description: "Find a bounded shortest dependency path between two exact code selectors.",
      args: { from: z.string().max(600), to: z.string().max(600), maxDepth: z.number().int().min(1).max(5).optional(), maxResults: z.number().int().min(1).max(50).optional(), maxFanout: z.number().int().min(1).max(200).optional() },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          return JSON.stringify(await engine.queryCodeGraphPath(args.from as import("@local/supracortex-core").CodeGraphSelector, args.to as import("@local/supracortex-core").CodeGraphSelector, args));
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "code-graph-path", output: `Error: ${res.error}` };
        return { title: "code-graph-path", output: bounded(res as string) };
      },
    }),

    cortex_code_graph_impact: tool({
      description: "Find bounded incoming dependents or outgoing dependencies for an exact code selector.",
      args: { selector: z.string().max(600), direction: z.enum(["incoming", "outgoing"]), maxDepth: z.number().int().min(1).max(5).optional(), maxResults: z.number().int().min(1).max(50).optional(), maxFanout: z.number().int().min(1).max(200).optional() },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          return JSON.stringify(await engine.queryCodeGraphImpact(args.selector as import("@local/supracortex-core").CodeGraphSelector, args.direction, args));
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "code-graph-impact", output: `Error: ${res.error}` };
        return { title: "code-graph-impact", output: bounded(res as string) };
      },
    }),

    cortex_code_graph_explain: tool({
      description: "Explain one exact deterministic code-graph node and its provenance.",
      args: { selector: z.string().max(600) },
      async execute(args) {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          return JSON.stringify(await engine.explainCodeGraphNode(args.selector as import("@local/supracortex-core").CodeGraphSelector));
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "code-graph-explain", output: `Error: ${res.error}` };
        return { title: "code-graph-explain", output: bounded(res as string) };
      },
    }),

    cortex_export_graph: tool({
      description:
        "Export the structured intelligence (memory + active tasks + file ownership) as a typed nodes/edges graph (JSON) for visualizers such as the SupraSpace galaxy graph. Read-only; no model call.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const engine = await rt.getEngine();
          if (!engine) return DISABLED;
          const g = await engine.exportGraph();
          if (!g) return DISABLED;
          return JSON.stringify(g);
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "export-graph", output: `Error: ${res.error}` };
        return { title: "export-graph", output: bounded(res as string, 60000) };
      },
    }),

    cortex_status: tool({
      description:
        "Report plugin status: enabled/disabled state and reason, whether it has failed, the target project root, and host capabilities (native vs tools-only, context injection, usage observation).",
      args: {},
      async execute() {
        const active = rt.gate.active;
        const caps = openCodeCapabilities();

        // Resolve provider cache policy from current host capabilities.
        const providerCachePolicy: ProviderCachePolicyIntent = active
          ? resolveProviderCachePolicy({
              host: caps.host,
              capability: caps,
              projectKey: rt.projectRoot,
              stablePrefix: "opencode/default",
            })
          : {
              mode: "observe-only",
              projectKeyDigest: "",
              stablePrefixDigest: "",
            };

        const adapterResult = processProviderCacheIntent(providerCachePolicy);

        const lines = [
          `active: ${active}`,
          `reason: ${rt.gate.statusReason}`,
          `failed: ${rt.gate.hasFailed}`,
          `projectRoot: ${rt.projectRoot}`,
          `host: ${caps.host}`,
          `integration: ${caps.integration}`,
          `readUserTask: ${caps.readUserTask}`,
          `injectRequestContext: ${caps.injectRequestContext}`,
          `observeUsage: ${caps.observeUsage}`,
          `observeCost: ${caps.observeCost}`,
          `observeCompaction: ${caps.observeCompaction}`,
          `setProviderOptions: ${caps.setProviderOptions}`,
          `setCacheBreakpoints: ${caps.setCacheBreakpoints}`,
          `lifecycleEvents: ${caps.lifecycleEvents}`,
          `providerCacheMode: ${providerCachePolicy.mode}`,
          `providerCacheApplied: ${adapterResult.applied}`,
          `providerCacheReason: ${adapterResult.reason}`,
          `providerCacheProjectDigest: ${providerCachePolicy.projectKeyDigest}`,
          `providerCachePrefixDigest: ${providerCachePolicy.stablePrefixDigest}`,
        ];
        return { title: "status", output: lines.join("\n") };
      },
    }),

    cortex_timeline: tool({ description: "Show a bounded chronological structural event timeline.", args: { since: z.string().optional(), until: z.string().optional(), kinds: z.array(z.string()).optional(), limit: z.number().int().min(1).max(100).optional() }, async execute(args) {
      const res = await guard(rt, async () => { const e = await rt.getEngine(); return e ? JSON.stringify(await e.timelineEvents({ ...args, kinds: toOptionalStringArray(args.kinds) })) : DISABLED; });
      if (isGuardDisabled(res)) return DISABLED;
      if (isGuardError(res)) return { title: "timeline", output: `Error: ${res.error}` };
      return { title: "timeline", output: bounded(res as string) };
    } }),
    cortex_detail: tool({ description: "Show one structural event by ID.", args: { id: z.string() }, async execute(args) {
      const res = await guard(rt, async () => { const e = await rt.getEngine(); return e ? JSON.stringify(await e.eventDetail(args.id)) : DISABLED; });
      if (isGuardDisabled(res)) return DISABLED;
      if (isGuardError(res)) return { title: "detail", output: `Error: ${res.error}` };
      return { title: "detail", output: bounded(res as string) };
    } }),
    cortex_handoff: tool({ description: "Create a bounded project handoff capsule.", args: { goal: z.string(), completedWork: z.array(z.string()).optional(), nextActions: z.array(z.string()).optional(), evidenceIds: z.array(z.string()).optional() }, async execute(args) {
      const res = await guard(rt, async () => {
        const e = await rt.getEngine(); if (!e) return DISABLED;
        const input = {
          ...args,
          completedWork: toOptionalStringArray(args.completedWork),
          nextActions: toOptionalStringArray(args.nextActions),
          evidenceIds: toOptionalStringArray(args.evidenceIds),
        };
        return JSON.stringify(await e.createHandoff(input));
      });
      if (isGuardDisabled(res)) return DISABLED;
      if (isGuardError(res)) return { title: "handoff", output: `Error: ${res.error}` };
      return { title: "handoff", output: bounded(res as string) };
    } }),
    cortex_resume: tool({ description: "Resume a project handoff capsule.", args: { id: z.string() }, async execute(args) {
      const res = await guard(rt, async () => { const e = await rt.getEngine(); return e ? JSON.stringify(await e.resumeHandoff(args.id)) : DISABLED; });
      if (isGuardDisabled(res)) return DISABLED;
      if (isGuardError(res)) return { title: "resume", output: `Error: ${res.error}` };
      return { title: "resume", output: bounded(res as string) };
    } }),
    cortex_review: tool({ description: "Review memory candidates: list, approve, edit, dispute, invalidate, pin, suppress, purge, or refresh-evidence (accept current file hashes without activating).", args: { action: z.enum(["list", "approve", "edit", "dispute", "invalidate", "pin", "suppress", "purge", "refresh-evidence"]), id: z.string().optional(), statuses: z.array(z.string()).optional(), limit: z.number().int().min(1).max(1000).optional(), content: z.string().optional(), confidence: z.number().min(0).max(1).optional(), tags: z.array(z.string()).optional() }, async execute(args) {
      const res = await guard(rt, async () => {
        const e = await rt.getEngine(); if (!e) return DISABLED;
        const statuses = toOptionalStringArray(args.statuses);
        const tags = toOptionalStringArray(args.tags);
        const action = args.action === "list"
          ? { type: "list" as const, statuses, limit: args.limit }
          : args.action === "edit"
            ? { type: "edit" as const, id: args.id ?? "", content: args.content, confidence: args.confidence, tags }
            : { type: args.action, id: args.id ?? "" };
        return JSON.stringify(await e.review(action as never));
      });
      if (isGuardDisabled(res)) return DISABLED;
      if (isGuardError(res)) return { title: "review", output: `Error: ${res.error}` };
      return { title: "review", output: bounded(res as string) };
    } }),
    cortex_safety: tool({ description: "Generate an observed-evidence safety brief (never executes tests or shells).", args: { changedFiles: z.array(z.string()).optional(), staged: z.array(z.string()).optional(), untracked: z.array(z.string()).optional(), branch: z.string().optional() }, async execute(args) {
      const res = await guard(rt, async () => {
        const e = await rt.getEngine(); if (!e) return DISABLED;
        const git = { changedFiles: toOptionalStringArray(args.changedFiles) ?? [], staged: toOptionalStringArray(args.staged) ?? [], untracked: toOptionalStringArray(args.untracked) ?? [], ...(args.branch ? { branch: args.branch } : {}) };
        return JSON.stringify(await e.generateSafetyBrief(git));
      });
      if (isGuardDisabled(res)) return DISABLED;
      if (isGuardError(res)) return { title: "safety", output: `Error: ${res.error}` };
      return { title: "safety", output: bounded(res as string) };
    } }),
    cortex_jev_status: tool({
      description: "Report whether the decision model (Jev by default; provider shown in output) is enabled and configured (API key present). Read-only; never calls the network.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const e = await rt.getEngine(); if (!e) return DISABLED;
          return JSON.stringify(e.jevStatus());
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "jev-status", output: `Error: ${res.error}` };
        return { title: "jev-status", output: bounded(res as string) };
      },
    }),
    cortex_jev_review: tool({
      description: "Ask the decision model whether supplied task evidence warrants a review/handoff. Advisory only; falls back to no-recommendation when the provider is off or uncertain.",
      args: {
        evidence: z.record(z.string(), z.unknown()).describe("Task evidence (status, failures, open risks...)"),
        taskQuery: z.string().optional().describe("Natural-language task summary for per-call isolation"),
      },
      async execute(args) {
        const res = await guard(rt, async () => {
          const e = await rt.getEngine(); if (!e) return DISABLED;
          return JSON.stringify(await e.jevReviewEvidence(args.evidence, args.taskQuery ?? ""));
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "jev-review", output: `Error: ${res.error}` };
        return { title: "jev-review", output: bounded(res as string) };
      },
    }),
    cortex_capabilities: tool({
      description: "Report MCP/skill capability health observed this process: per-server availability (configured/connected/tested/failed with cooldown), tested tools, and which servers offer web search/fetch. Read-only; never calls the network.",
      args: {},
      async execute() {
        const res = await guard(rt, async () => {
          const e = await rt.getEngine(); if (!e) return DISABLED;
          return JSON.stringify(e.capabilitySnapshot());
        });
        if (isGuardDisabled(res)) return DISABLED;
        if (isGuardError(res)) return { title: "capabilities", output: `Error: ${res.error}` };
        return { title: "capabilities", output: bounded(res as string) };
      },
    }),
  };
  // 6a single vocabulary: thin aliases, same handler reference, no logic fork.
  // Canonical names are the short MCP names; the longer OpenCode names keep
  // working as aliases. cortex_record has two facets (memory/outcome).
  tools.cortex_context = tools.cortex_prepare_context!;
  tools.cortex_search = tools.cortex_search_memory!;
  tools.cortex_record = tools.cortex_record_memory!;
  return tools;
}

/**
 * 6a alias/canonical contract — single source is src/protocol.ts (product
 * contract per D1). This module re-exports; do not redefine here.
 * NOTE for 7b: CORTEX_ALIAS_TABLE in cli-core.ts is display-only and should
 * import toolAliasTable() from here or src/protocol.ts instead of its copy.
 */
export {
  TOOL_ALIASES,
  CANONICAL_CORE_TOOLS,
  resolveCanonicalToolName,
  canonicalToolLog,
  canonicalToolList,
  toolAliasTable,
  MCP_TOOL_NAMES,
} from "../../../../src/protocol.ts";
