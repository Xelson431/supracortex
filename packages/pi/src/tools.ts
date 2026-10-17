/**
 * P03 Cortex tools for the main Pi session. Thin adapters over CortexService;
 * Engine policy and validation stay in core. TypeBox schemas (Pi convention).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CortexService } from "./service.ts";

/**
 * Tools resolve their service per call (main session cwd), because
 * registration happens once per process but calls carry their own cwd.
 */
export type ServiceResolver = (cwd: string) => Promise<CortexService>;

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text: text.slice(0, 8000) }], details: {} };
}

const ContextParams = Type.Object({
  query: Type.String({ description: "Task query" }),
  hintFiles: Type.Optional(Type.Array(Type.String())),
});

export function cortexContextTool(resolve: ServiceResolver): ToolDefinition<typeof ContextParams> {
  return {
    name: "cortex_context",
    label: "Cortex context",
    description: "Retrieve bounded SupraCortex project context (memory, reads, skills) for a task query.",
    parameters: ContextParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const service = await resolve(ctx.cwd);
      const packet = await service.prepare(params.query, params.hintFiles ?? []);
      if (!packet) return textResult("Cortex disabled: no context available.");
      const lines = [
        `task: ${packet.taskSummary}`,
        `memory: ${packet.selectedMemory.map((m) => `[${m.entry.kind}] ${m.entry.content.slice(0, 200)}`).join(" | ") || "none"}`,
        `reads: ${packet.selectedFiles.map((f) => `${f.path} (${f.mode})`).join(", ") || "none"}`,
        `skills: ${packet.recommendedSkills.map((s) => s.name).join(", ") || "none"}`,
        `omissions: ${packet.omissions.length}`,
      ];
      return textResult(lines.join("\n"));
    },
  };
}

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
});

export function cortexSearchTool(resolve: ServiceResolver): ToolDefinition<typeof SearchParams> {
  return {
    name: "cortex_search",
    label: "Cortex search",
    description: "Search SupraCortex project memory.",
    parameters: SearchParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const service = await resolve(ctx.cwd);
      const hits = (await service.searchMemory(params.query)) as Array<{ entry?: { kind?: string; content?: string } }>;
      if (!hits.length) return textResult("No memory hits.");
      return textResult(hits.map((h) => `[${h.entry?.kind ?? "?"}] ${(h.entry?.content ?? "").slice(0, 300)}`).join("\n---\n"));
    },
  };
}

const MEMORY_KINDS = ["fact", "decision", "convention", "failure", "constraint", "task-outcome"] as const;

const RecordParams = Type.Object({
  kind: Type.Union(MEMORY_KINDS.map((k) => Type.Literal(k))),
  content: Type.String({ description: "Memory content (<=8000 chars)" }),
  confidence: Type.Optional(Type.Number()),
});

export function cortexRecordTool(resolve: ServiceResolver): ToolDefinition<typeof RecordParams> {
  return {
    name: "cortex_record",
    label: "Cortex record",
    description: "Record a project memory. Durable kinds require evidence; secrets are redacted; existing evidence/approval policy applies.",
    parameters: RecordParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const service = await resolve(ctx.cwd);
      const result = (await service.recordMemory({
        kind: params.kind,
        content: params.content,
        ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
      })) as { status?: string; reason?: string };
      return textResult(`status: ${result.status ?? "unknown"}${result.reason ? ` (${result.reason})` : ""}`);
    },
  };
}

export function cortexTools(resolve: ServiceResolver): ToolDefinition[] {
  return [cortexContextTool(resolve), cortexSearchTool(resolve), cortexRecordTool(resolve)];
}

const DelegateParams = Type.Object({
  role: Type.String(),
  task: Type.String(),
  hintFiles: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
  mode: Type.Union([Type.Literal("wait"), Type.Literal("background")]),
  inheritance: Type.Optional(
    Type.Object({
      kind: Type.Literal("handoff"),
      text: Type.String(),
      evidenceIds: Type.Array(Type.String()),
    }),
  ),
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JobParams = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("result"), Type.Literal("cancel")]),
  jobId: Type.String(),
});

export interface SupervisorLike {
  delegate(raw: unknown, parent: { sessionFile: string | undefined; sessionId: string | undefined; cwd: string }): Promise<
    | { jobId: string; state: string; result?: unknown; textFallback?: string | null; failureCode?: string }
    | { jobId: string; state: string }
  >;
  lookup(jobId: string): Promise<{ record: { id: string; role: string; state: string; failureCode?: string; resultPath?: string } }>;
  cancel(jobId: string): Promise<string>;
  loadResultText(runId: string, jobId: string): Promise<string | null>;
  currentRunId: string;
}

/** Delegation + job control tools. Supervisor is wired by the extension. */
export function cortexDelegateTool(getSupervisor: (cwd: string) => Promise<SupervisorLike>): ToolDefinition<typeof DelegateParams> {
  return {
    name: "cortex_delegate",
    label: "Cortex delegate",
    description:
      "Delegate a read-only subtask to a SupraCortex child role. wait mode returns the terminal result; background returns a job id and notifies on completion. Children cannot write, run shell, or delegate further.",
    parameters: DelegateParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const supervisor = await getSupervisor(ctx.cwd);
      const outcome = await supervisor.delegate(params, {
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
      });
      return textResult(JSON.stringify(outcome).slice(0, 6000));
    },
  };
}

export function cortexJobTool(getSupervisor: (cwd: string) => Promise<SupervisorLike>): ToolDefinition<typeof JobParams> {
  return {
    name: "cortex_job",
    label: "Cortex job",
    description: "Inspect or cancel a SupraCortex background job (status/result/cancel).",
    parameters: JobParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!UUID_PATTERN.test(params.jobId)) return textResult("invalid jobId (must be a UUID)");
      const supervisor = await getSupervisor(ctx.cwd);
      if (params.action === "cancel") {
        const state = await supervisor.cancel(params.jobId);
        return textResult(`job ${params.jobId.slice(0, 8)}: ${state}`);
      }
      const { record } = await supervisor.lookup(params.jobId);
      if (params.action === "status") {
        return textResult(`job ${record.id.slice(0, 8)} (${record.role}): ${record.state}${record.failureCode ? ` [${record.failureCode}]` : ""}`);
      }
      const text = await supervisor.loadResultText(supervisor.currentRunId, params.jobId);
      return textResult(text ?? `no stored result for job ${record.id.slice(0, 8)} (state: ${record.state})`);
    },
  };
}
