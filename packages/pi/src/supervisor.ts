/**
 * P05 supervised jobs: admission, bounded queue, cancellation, parent-bound
 * delivery, crash interruption. One process, no daemon: background means the
 * parent continues while the CLI lives. v1 children are read-only, so no two
 * jobs can collide on writes (overlap enforcement arrives with writers).
 */

import { createHash, randomUUID } from "node:crypto";
import { estimateWireTextTokens, type HostUsageObservation } from "@local/supracortex-core";
import type { AgentDefinition } from "./agents.ts";
import { renderPacket } from "./context.ts";
import type { CliConfig, ModelRef } from "./config.ts";
import { resolveContextCaps, resolveJobLimits } from "./config.ts";
import {
  DelegateRequestSchema,
  type ChildResult,
  type DelegateRequest,
  type JobRecord,
  type JobState,
} from "./contracts.ts";
import { runChild, type ChildHandoff, type ChildOutcome } from "./child-runner.ts";
import { JobStore, newJobId } from "./job-store.ts";
import { logDebug, logInfo, logWarn } from "./log.ts";
import { resolveRoleModel } from "./models.ts";
import { CortexService } from "./service.ts";
import { UsageLedger } from "./usage.ts";

export interface ParentContext {
  /** Stable parent identity: session file path (undefined when unavailable). */
  sessionFile: string | undefined;
  sessionId: string | undefined;
  cwd: string;
}

export interface DelegateWaitResult {
  jobId: string;
  state: "succeeded" | "failed" | "cancelled";
  result: ChildResult | null;
  textFallback: string | null;
  failureCode?: string;
}

export type ChildRunnerFn = (
  spec: Parameters<typeof runChild>[0],
  opts: Parameters<typeof runChild>[1],
) => Promise<ChildOutcome>;

export interface SupervisorOptions {
  store: JobStore;
  runId: string;
  service: CortexService;
  cli: CliConfig | null;
  agentDir: string;
  agents: Map<string, AgentDefinition>;
  roleModels?: Record<string, ModelRef>;
  mainModel?: ModelRef;
  now?: () => number;
  /** Injectable for tests (fake runner). Production always uses runChild. */
  runner?: ChildRunnerFn;
  /** Abort-settlement wait before declaring stuck (default 30000). */
  stuckAfterMs?: number;
}

interface LiveJob {
  record: JobRecord;
  controller: AbortController;
  settled: Promise<void>;
  notify?: (outcome: DelegateWaitResult) => void;
  delivered: boolean;
  result: ChildResult | null;
  textFallback: string | null;
  failureCode?: string;
  /** Frozen execution inputs (admission-time; never mutated after). */
  brief: string;
  hints: string[];
  handoff?: ChildHandoff;
}

function normalizeTask(task: string): string {
  return task.trim().replace(/\s+/g, " ");
}

function confineHints(hints: string[] | undefined): string[] {
  const out: string[] = [];
  for (const hint of hints ?? []) {
    if (hint.length > 512 || hint.startsWith("/") || hint.includes("..") || hint.includes("\0")) {
      throw new Error(`hint file rejected (must be a confined relative path): ${hint.slice(0, 64)}`);
    }
    const cleaned = hint.replace(/^\.\//, "");
    if (!cleaned || cleaned.startsWith("/")) throw new Error(`hint file rejected: ${hint.slice(0, 64)}`);
    out.push(cleaned);
  }
  return [...new Set(out)].sort();
}

export function taskHash(input: {
  parentSessionFile: string | undefined;
  role: string;
  model: ModelRef;
  task: string;
  hints: string[];
  handoffText: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.parentSessionFile ?? "",
        input.role,
        input.model.provider,
        input.model.id,
        normalizeTask(input.task),
        [...input.hints].sort(),
        input.handoffText,
      ]),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

export class Supervisor {
  private readonly store: JobStore;
  private readonly runId: string;
  private readonly service: CortexService;
  private readonly cli: CliConfig | null;
  private readonly agentDir: string;
  private readonly agents: Map<string, AgentDefinition>;
  private readonly roleModels?: Record<string, ModelRef>;
  private readonly mainModel?: ModelRef;
  private readonly now: () => number;
  private readonly live = new Map<string, LiveJob>();
  private admissions = new Promise<void>((resolve) => resolve());
  private admissionsBlocked = false;
  private running = 0;
  private readonly runner: ChildRunnerFn;
  private readonly stuckAfterMs: number;
  private ledgerPromise: Promise<UsageLedger> | null = null;

  constructor(opts: SupervisorOptions) {
    this.store = opts.store;
    this.runId = opts.runId;
    this.service = opts.service;
    this.cli = opts.cli;
    this.agentDir = opts.agentDir;
    this.agents = opts.agents;
    this.roleModels = opts.roleModels;
    this.mainModel = opts.mainModel;
    this.now = opts.now ?? Date.now;
    this.runner = opts.runner ?? runChild;
    this.stuckAfterMs = opts.stuckAfterMs ?? 30000;
  }

  limits(): { maxRunning: number; maxQueued: number; timeoutMs: number } {
    return resolveJobLimits(this.cli);
  }

  get currentRunId(): string {
    return this.runId;
  }

  /** Additive per-run usage ledger (restart-safe, id-keyed). */
  usageLedger(): Promise<UsageLedger> {
    if (!this.ledgerPromise) {
      this.ledgerPromise = (async () => {
        const { ledger } = await UsageLedger.open(this.runId, this.store.runDir(this.runId));
        return ledger;
      })();
    }
    return this.ledgerPromise;
  }

  private recordHostUsage(observation: HostUsageObservation): Promise<unknown> {
    return this.service.runExclusive(() => this.service.engine.recordHostUsage(observation));
  }

  /**
   * Reconcile main-session entries (P08): unseen assistant message entries
   * with usage are recorded exactly once (entry-id keyed) and projected to
   * core host-usage. Called from the extension context hook.
   */
  async reconcileMainEntries(
    sessionId: string,
    entries: Array<{ id?: unknown; type?: unknown; message?: unknown }>,
  ): Promise<number> {
    const ledger = await this.usageLedger();
    let reconciled = 0;
    for (const entry of entries) {
      if (!entry || entry.type !== "message" || typeof entry.id !== "string") continue;
      const message = entry.message as
        | { role?: unknown; usage?: unknown; provider?: unknown; model?: unknown }
        | undefined;
      if (!message || message.role !== "assistant" || !message.usage || typeof message.usage !== "object") continue;
      const usage = message.usage as Record<string, unknown>;
      if (typeof usage["input"] !== "number" || typeof usage["output"] !== "number") continue;
      const provider = typeof message.provider === "string" ? message.provider : "unknown";
      const modelId = typeof message.model === "string" ? message.model : "unknown";
      const recorded = await ledger.record({
        runId: this.runId,
        sessionId,
        requestKey: entry.id,
        source: "main",
        provider,
        modelId,
        usage: usage as never,
        complete: true,
      });
      if (!recorded) continue;
      reconciled++;
      const costTotal = (usage["cost"] as { total?: unknown } | undefined)?.total;
      try {
        await this.recordHostUsage({
          messageId: entry.id,
          sessionId,
          provider,
          model: modelId,
          reportedCost: typeof costTotal === "number" ? costTotal : 0,
          inputTokens: usage["input"] as number,
          outputTokens: usage["output"] as number,
          reasoningTokens: 0,
          cacheReadTokens: typeof usage["cacheRead"] === "number" ? (usage["cacheRead"] as number) : 0,
          cacheWriteTokens: typeof usage["cacheWrite"] === "number" ? (usage["cacheWrite"] as number) : 0,
        });
      } catch {
        // Best-effort projection; the ledger is authoritative.
      }
    }
    return reconciled;
  }

  /** Full stored result as bounded text (for cortex_job result). */
  async loadResultText(runId: string, jobId: string): Promise<string | null> {
    const result = await this.store.loadResult(runId, jobId);
    if (!result) return null;
    const lines = [
      `summary: ${result.summary}`,
      ...result.findings.map((f) => `- finding: ${f.text} [${f.files.join(", ")}]`),
      ...result.recommendedActions.map((a) => `- action: ${a}`),
      ...result.unresolved.map((u) => `- unresolved: ${u}`),
    ];
    return lines.join("\n").slice(0, 6000);
  }

  /** Serialize admission decisions (not execution). */
  private async admit<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.admissions.then(fn, fn);
    this.admissions = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Live-job snapshot for status surfaces (no mutation). */
  listLive(): Array<{ id: string; role: string; state: JobState; stuck: boolean }> {
    return [...this.live.values()].map((job) => ({
      id: job.record.id,
      role: job.record.role,
      state: job.record.state,
      stuck: job.record.state === "cancelling" && this.admissionsBlocked,
    }));
  }

  isAdmissionsBlocked(): boolean {
    return this.admissionsBlocked;
  }

  async delegate(raw: unknown, parent: ParentContext): Promise<DelegateWaitResult | { jobId: string; state: JobState }> {
    const parsed = DelegateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(
        `invalid delegation ${first ? first.path.join(".") : "(root)"}: ${first?.message ?? "schema mismatch"}`,
      );
    }
    const req: DelegateRequest = parsed.data;
    return this.admit(async () => this.delegateInner(req, parent));
  }

  private async delegateInner(
    req: DelegateRequest,
    parent: ParentContext,
  ): Promise<DelegateWaitResult | { jobId: string; state: JobState }> {
    if (this.admissionsBlocked) throw new Error("admissions blocked: a previous abort did not settle (stuck child)");
    const agent = this.agents.get(req.role);
    if (!agent) throw new Error(`unknown role "${req.role}"`);
    const { ref: model } = resolveRoleModel({
      role: req.role,
      requestModel: req.model,
      roleModels: this.roleModels,
      agentModel: agent.model,
      mainModel: this.mainModel,
    });
    const hints = confineHints(req.hintFiles);
    const task = normalizeTask(req.task);
    let handoff: ChildHandoff | undefined;
    if (req.inheritance) {
      const { tokens } = estimateWireTextTokens([req.inheritance.text]);
      if (tokens > 2000) throw new Error("handoff exceeds 2000 tokens");
      handoff = { text: req.inheritance.text, evidenceIds: req.inheritance.evidenceIds };
    }
    const hash = taskHash({
      parentSessionFile: parent.sessionFile,
      role: req.role,
      model,
      task,
      hints,
      handoffText: handoff?.text ?? "",
    });
    for (const job of this.live.values()) {
      if (job.record.taskHash === hash && (job.record.state === "queued" || job.record.state === "running")) {
        if (req.mode === "wait") return this.awaitJob(job);
        return { jobId: job.record.id, state: job.record.state };
      }
    }
    const limits = this.limits();
    const queued = [...this.live.values()].filter((j) => j.record.state === "queued").length;
    if (queued >= limits.maxQueued) {
      throw new Error(`job queue full (${limits.maxQueued} queued); cancel or await existing jobs`);
    }
    const id = newJobId();
    const at = new Date(this.now()).toISOString();
    const record: JobRecord = {
      schemaVersion: 1,
      id,
      runId: this.runId,
      parentSessionId: parent.sessionFile ?? parent.sessionId ?? "unknown-parent",
      taskHash: hash,
      role: req.role,
      model: { provider: model.provider, id: model.id },
      state: "queued",
      createdAt: at,
    };
    await this.store.saveJob(record, this.runId);
    logInfo("supervisor", "job admitted", { job: id.slice(0, 8), role: req.role, mode: req.mode, model: `${model.provider}/${model.id}` });
    const controller = new AbortController();
    let notify: ((outcome: DelegateWaitResult) => void) | undefined;
    const live: LiveJob = {
      record,
      controller,
      settled: Promise.resolve(),
      delivered: false,
      result: null,
      textFallback: null,
      brief: task,
      hints,
      ...(handoff ? { handoff } : {}),
    };
    if (req.mode === "wait") {
      const outcome = new Promise<DelegateWaitResult>((resolve) => {
        notify = resolve;
      });
      live.notify = notify;
      this.live.set(id, live);
      this.pump();
      return outcome;
    }
    this.live.set(id, live);
    this.pump();
    return { jobId: id, state: "queued" as JobState };
  }

  /** Start queued jobs while slots are free (re-entrant, serialized by admit). */
  private pump(): void {
    const limits = this.limits();
    for (const job of this.live.values()) {
      if (this.running >= limits.maxRunning) break;
      if (job.record.state !== "queued") continue;
      void this.startJob(job);
    }
  }

  private async startJob(job: LiveJob): Promise<void> {
    const limits = this.limits();
    this.running++;
    // Install the in-flight completion promise BEFORE publishing "running".
    // cancel() can race on the state while saveJob/prepare are awaiting; if it
    // observes the old initially-resolved placeholder, it falsely treats an
    // active runner as settled and persists a fake "cancelled" outcome.
    let resolveSettled!: () => void;
    job.settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    job.record.state = "running";
    job.record.startedAt = new Date(this.now()).toISOString();
    await this.store.saveJob(job.record, this.runId);
    const agent = this.agents.get(job.record.role);
    try {
      if (!agent) throw new Error(`role disappeared: ${job.record.role}`);
      const packet = await this.service.prepare(job.brief, job.hints, job.record.role);
      const caps = resolveContextCaps(this.cli);
      const packetText = packet ? renderPacket(packet, caps.childMaxTokens).text : "(cortex unavailable)";
      const ledger = await this.usageLedger();
      const outcome = await this.runner(
        {
          role: job.record.role,
          brief: job.brief,
          agent,
          model: job.record.model,
          cwd: this.service.projectRoot,
          agentDir: this.agentDir,
          packetText,
          ...(job.handoff ? { handoff: job.handoff } : {}),
          timeoutMs: limits.timeoutMs,
          usage: {
            ledger,
            runId: this.runId,
            recordHostUsage: (observation) => this.recordHostUsage(observation),
          },
        },
        { signal: job.controller.signal },
      );
      job.result = outcome.result;
      job.textFallback = outcome.textFallback;
      if (outcome.result) {
        await this.finishJob(job, { state: "succeeded" });
        // NOTE: cancel() may concurrently move running -> cancelling; read
        // through a widened type so TS narrowing (which cannot see the
        // concurrent writer) does not lie about the comparison.
      } else if (outcome.failureCode === "ABORTED" && (job.record.state as string) === "cancelling") {
        await this.finishJob(job, { state: "cancelled" });
      } else {
        await this.finishJob(job, {
          state: "failed",
          failureCode: outcome.failureCode ?? "RESULT_MISSING",
        });
      }
    } catch (err) {
      await this.finishJob(job, {
        state: "failed",
        failureCode: err instanceof Error ? err.message.slice(0, 64) : "error",
      });
    } finally {
      this.running--;
      resolveSettled();
      this.pump();
    }
  }

  private async finishJob(
    job: LiveJob,
    terminal: { state: "succeeded" | "failed" | "cancelled"; failureCode?: string },
  ): Promise<void> {
    // Compare-and-set: only a live (non-terminal) job may transition.
    if (job.record.state !== "running" && job.record.state !== "queued" && job.record.state !== "cancelling") {
      return;
    }
    job.record.state = terminal.state;
    job.record.endedAt = new Date(this.now()).toISOString();
    if (terminal.failureCode) job.record.failureCode = terminal.failureCode;
    logInfo("supervisor", "job terminal", {
      job: job.record.id.slice(0, 8),
      state: terminal.state,
      ...(terminal.failureCode ? { failure: terminal.failureCode } : {}),
    });
    await this.store.saveJob(job.record, this.runId);
    if (job.result) {
      job.record.resultPath = await this.store.saveResult(this.runId, job.record.id, job.result);
      await this.store.saveJob(job.record, this.runId);
    }
    job.notify?.({
      jobId: job.record.id,
      state: terminal.state,
      result: job.result,
      textFallback: job.textFallback,
      ...(terminal.failureCode ? { failureCode: terminal.failureCode } : {}),
    });
  }

  private awaitJob(job: LiveJob): Promise<DelegateWaitResult> {
    if (job.record.state === "succeeded" || job.record.state === "failed" || job.record.state === "cancelled") {
      return Promise.resolve({
        jobId: job.record.id,
        state: job.record.state,
        result: job.result,
        textFallback: job.textFallback,
        ...(job.record.failureCode ? { failureCode: job.record.failureCode } : {}),
      });
    }
    return new Promise<DelegateWaitResult>((resolve) => {
      const prev = job.notify;
      job.notify = (outcome) => {
        prev?.(outcome);
        resolve(outcome);
      };
    });
  }

  /** Cancel: queued settles immediately; running aborts and waits (stuck detection). */
  async cancel(jobId: string): Promise<JobState> {
    return this.admit(async () => {
      const job = this.live.get(jobId);
      if (!job) throw new Error(`unknown job ${jobId.slice(0, 16)}`);
      if (job.record.state === "queued") {
        await this.finishJob(job, { state: "cancelled" });
        return job.record.state;
      }
      if (job.record.state !== "running") return job.record.state;
      job.record.state = "cancelling";
      await this.store.saveJob(job.record, this.runId);
      job.controller.abort();
      const settled = await Promise.race([
        job.settled.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.stuckAfterMs)),
      ]);
      if (!settled) {
        // The SDK offers no force-kill for in-process children. Report stuck,
        // stop admissions, and let the operator exit. Never fake cancellation.
        this.admissionsBlocked = true;
        logWarn("supervisor", "abort unsettled, admissions blocked", { job: job.record.id.slice(0, 8) });
        return job.record.state;
      }
      // finishJob is compare-and-set: if the runner already settled the job
      // (e.g. ABORTED -> cancelled), this is a safe no-op.
      await this.finishJob(job, { state: "cancelled" });
      return job.record.state;
    });
  }

  /**
   * Deliver completed background results to their ORIGINAL parent only, at a
   * safe input boundary. Called from the extension context hook: the caller
   * passes the CURRENT session file (fresh ctx) and a sender bound to the
   * current session. Records whose parent differs are left for explicit
   * `/jobs` retrieval — never injected into a newly selected session.
   */
  async deliverPending(delivery: {
    currentSessionFile: string | undefined;
    send: (text: string) => void;
  }): Promise<number> {
    let delivered = 0;
    for (const job of this.live.values()) {
      if (job.delivered || job.notify) continue; // wait-mode outcomes go to the waiter, not the chat
      if (job.record.state !== "succeeded" && job.record.state !== "failed") continue;
      if (job.record.parentSessionId !== delivery.currentSessionFile) continue;
      const text = this.deliveryText(job);
      try {
        delivery.send(text);
      } catch {
        continue;
      }
      job.delivered = true;
      delivered++;
    }
    return delivered;
  }

  private deliveryText(job: LiveJob): string {
    const summary = job.result?.summary ?? job.textFallback ?? "(no output)";
    const findings = job.result?.findings.length ?? 0;
    const unresolved = job.result?.unresolved.length ?? 0;
    let text =
      `[supracortex job ${job.record.id.slice(0, 8)} ${job.record.role} ${job.record.state}] ${summary} ` +
      `(findings: ${findings}, unresolved: ${unresolved})`;
    const { tokens } = estimateWireTextTokens([text]);
    if (tokens > 1500) {
      const keep = Math.max(200, 1500 - 100);
      text = `${text.slice(0, keep * 4)}… (trimmed; use cortex_job result for full output)`;
    }
    return text;
  }

  /**
   * Startup recovery: nonterminal records from PRIOR runs become
   * `interrupted`. Never reruns provider calls or mutations. Current-run
   * jobs are always live (in-memory) — the store is authoritative only for
   * runs that are no longer alive.
   */
  async recover(): Promise<{ interrupted: number }> {
    let interrupted = 0;
    for (const runId of await this.store.listRuns()) {
      if (runId === this.runId) continue;
      for (const record of await this.store.listJobs(runId)) {
        if (record.state === "queued" || record.state === "running" || record.state === "cancelling") {
          record.state = "interrupted";
          record.endedAt = new Date(this.now()).toISOString();
          await this.store.saveJob(record, runId);
          interrupted++;
        }
      }
    }
    return { interrupted };
  }

  /** Look up a live job of this run, or load a persisted record. */
  async lookup(jobId: string): Promise<{ record: JobRecord; live: boolean }> {
    const live = this.live.get(jobId);
    if (live) return { record: live.record, live: true };
    const record = await this.store.loadJob(this.runId, jobId);
    if (!record) throw new Error(`unknown job ${jobId.slice(0, 16)}`);
    return { record, live: false };
  }

  /** Cancel owned live jobs on shutdown; bound waits, then report. */
  async shutdown(): Promise<void> {
    const live = [...this.live.values()];
    for (const job of live) {
      try {
        await this.cancel(job.record.id);
      } catch {
        // Best-effort shutdown.
      }
    }
  }
}
