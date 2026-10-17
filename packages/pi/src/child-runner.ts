/**
 * P04 read-only child runner: independent SDK sessions with explicit,
 * ambient-free configuration. Fresh transcript; no raw parent history.
 * Writers, delegation, and shell/network tools are excluded by construction.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  formatSkillsForPrompt,
  loadProjectContextFiles,
  loadSkills,
  resolveCliModel,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { estimateWireTextTokens, type HostUsageObservation } from "@local/supracortex-core";
import { logDebug, logInfo, logWarn } from "./log.ts";
import type { AgentDefinition } from "./agents.ts";
import type { ModelRef } from "./config.ts";
import { type ChildResult } from "./contracts.ts";
import type { UsageLedger } from "./usage.ts";
import { ModelSelectionError } from "./models.ts";
import { cortexSubmitResultTool, createResultCollector } from "./result-tool.ts";

export interface ChildHandoff {
  text: string;
  evidenceIds: string[];
}

export interface ChildSpec {
  role: string;
  brief: string;
  agent: AgentDefinition;
  /** Resolved + frozen model (precedence applied by caller). */
  model: ModelRef;
  cwd: string;
  /**
   * Pi agent dir. Authentication and the model catalog resolve from this
   * directory, so it MUST be the host's real agent dir (auth sharing is
   * intentional and documented; the key never enters any transcript).
   * Isolation comes from the ambient-free loader flags, the tool allowlist,
   * and in-memory session/settings — not from this path.
   */
  agentDir: string;
  /** The child's own rendered Cortex packet text. */
  packetText: string;
  handoff?: ChildHandoff;
  timeoutMs: number;
  /**
   * Usage attribution (P08). When present, every authoritative assistant
   * message_end is reconciled exactly once (id-keyed) into the ledger and
   * projected to core host-usage. Aborts with no attributable usage record
   * zeros + complete:false in the ledger only (never invented billing).
   */
  usage?: {
    ledger: UsageLedger;
    runId: string;
    recordHostUsage: (observation: HostUsageObservation) => Promise<unknown>;
  };
}

export interface ChildReadEvidence {
  path: string;
  canonical: string;
  hash: string | null;
  atMs: number;
}

export interface ChildOutcome {
  result: ChildResult | null;
  /** Last assistant text when no structured result was submitted. */
  textFallback: string | null;
  reads: ChildReadEvidence[];
  failureCode?: "RESULT_MISSING" | "TIMEOUT" | "ABORTED" | "PROVIDER_ERROR" | "MODEL_UNAVAILABLE";
  /** Raw session events for P08 usage attribution. */
  events: unknown[];
}

export class ChildRunnerError extends Error {
  readonly code: NonNullable<ChildOutcome["failureCode"]>;
  constructor(code: NonNullable<ChildOutcome["failureCode"]>, message: string) {
    super(message);
    this.code = code;
  }
}

async function hashFile(path: string): Promise<string | null> {
  try {
    const data = await readFile(path);
    return createHash("sha256").update(data).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

async function canonicalPath(cwd: string, path: string): Promise<string> {
  const resolved = resolve(cwd, path);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function wrapReadWithEvidence(
  readDef: ToolDefinition,
  cwd: string,
  reads: ChildReadEvidence[],
): ToolDefinition {
  const original = readDef.execute.bind(readDef) as (...args: never[]) => Promise<AgentToolResult>;
  return {
    ...readDef,
    execute: (async (...args: never[]) => {
      const out = await original(...args);
      try {
        const path = (args[1] as { path?: unknown } | undefined)?.path;
        if (typeof path === "string" && path.length <= 512) {
          const canonical = await canonicalPath(cwd, path);
          reads.push({ path, canonical, hash: await hashFile(canonical), atMs: Date.now() });
        }
      } catch {
        // Evidence is best-effort; the read itself already succeeded.
      }
      return out;
    }) as ToolDefinition["execute"],
  };
}

/** Exported for unit tests: prompt composition only, no execution. */
export function assemblePrompt(spec: ChildSpec, repoContext: string, skillsText: string): string {
  const parts = [
    `# Role: ${spec.agent.name}`,
    spec.agent.body,
    `## Repository instructions (binding)`,
    repoContext || "(none)",
  ];
  if (skillsText) parts.push(`## Skills\n${skillsText}`);
  if (spec.handoff) {
    parts.push(
      `## Parent handoff (bounded, evidence by id only — re-read files yourself)`,
      spec.handoff.text,
      `evidence ids: ${spec.handoff.evidenceIds.join(", ") || "none"}`,
    );
  }
  parts.push(`## Project context\n${spec.packetText}`, `## Task\n${spec.brief}`);
  parts.push(
    `## Reporting`,
    `When done, call cortex_submit_result exactly once with your structured result. ` +
      `If you cannot complete the brief, submit findings so far with unresolved entries.`,
  );
  return parts.join("\n\n");
}

export async function runChild(spec: ChildSpec, opts: { signal?: AbortSignal } = {}): Promise<ChildOutcome> {
  if (!spec.brief || spec.brief.length > 8000) {
    throw new ChildRunnerError("PROVIDER_ERROR", "brief must be 1..8000 chars");
  }
  // Abort may arrive while the supervisor prepares context, before the
  // provider call starts. Never start work on a dead signal.
  if (opts.signal?.aborted) {
    return { result: null, textFallback: null, reads: [], failureCode: "ABORTED", events: [] };
  }
  if (spec.handoff) {
    const { tokens } = estimateWireTextTokens([spec.handoff.text]);
    if (tokens > 2000 || spec.handoff.evidenceIds.length > 20) {
      throw new ChildRunnerError("PROVIDER_ERROR", "handoff exceeds 2000 tokens / 20 evidence ids");
    }
  }

  // Model: explicit resolution only. resolveCliModel may report a warning or
  // fall back; for an explicit request either is a hard error (no silent swap).
  const modelRuntime = await ModelRuntime.create();
  const resolved = resolveCliModel({
    cliProvider: spec.model.provider,
    cliModel: spec.model.id,
    cliThinking: spec.agent.thinking,
    modelRuntime,
  });
  if (!resolved.model || resolved.error) {
    throw new ChildRunnerError(
      "MODEL_UNAVAILABLE",
      `Model unavailable for role "${spec.role}": ${resolved.error ?? "unresolved"} (requested ${spec.model.provider}/${spec.model.id})`,
    );
  }
  if (resolved.warning) {
    throw new ModelSelectionError(
      `Model fallback refused for role "${spec.role}": ${resolved.warning}`,
    );
  }

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: spec.cwd,
    agentDir: spec.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const reads: ChildReadEvidence[] = [];
  const allowed = new Set(spec.agent.tools);
  // Factories are heterogeneous ToolDefinition specializations; the runner
  // never touches their render functions, so a single loose type is honest.
  const asLoose = (fn: (cwd: string) => ToolDefinition): ((cwd: string) => ToolDefinition) => fn;
  const factories: Record<string, (cwd: string) => ToolDefinition> = {
    read: asLoose(createReadToolDefinition as unknown as (cwd: string) => ToolDefinition),
    grep: asLoose(createGrepToolDefinition as unknown as (cwd: string) => ToolDefinition),
    find: asLoose(createFindToolDefinition as unknown as (cwd: string) => ToolDefinition),
    ls: asLoose(createLsToolDefinition as unknown as (cwd: string) => ToolDefinition),
  };
  const childTools: ToolDefinition[] = [];
  for (const [name, factory] of Object.entries(factories)) {
    if (!allowed.has(name)) continue;
    const def = factory(spec.cwd);
    childTools.push(name === "read" ? wrapReadWithEvidence(def, spec.cwd, reads) : def);
  }
  const collector = createResultCollector();
  childTools.push(cortexSubmitResultTool(collector));
  const toolNames = childTools.map((t) => t.name);

  const repoFiles = loadProjectContextFiles({ cwd: spec.cwd, agentDir: spec.agentDir });
  const repoContext = repoFiles.map((f) => `### ${f.path}\n${f.content}`).join("\n\n").slice(0, 8000);
  let skillsText = "";
  try {
    const { skills } = loadSkills({ cwd: spec.cwd, agentDir: spec.agentDir, skillPaths: [], includeDefaults: true });
    const wanted = new Set(spec.agent.skills);
    skillsText = formatSkillsForPrompt(skills.filter((s) => wanted.has(s.name)));
  } catch {
    skillsText = "";
  }

  const { session } = await createAgentSession({
    cwd: spec.cwd,
    agentDir: spec.agentDir,
    model: resolved.model,
    ...(spec.agent.thinking ? { thinkingLevel: spec.agent.thinking } : {}),
    tools: toolNames,
    customTools: childTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  const sessionId =
    typeof (session as { sessionId?: unknown }).sessionId === "string"
      ? (session as { sessionId: string }).sessionId
      : undefined;
  const invocationId = randomUUID();
  const events: unknown[] = [];
  const unsubscribes: Array<() => void> = [];
  let outcome: ChildOutcome;
  try {
    unsubscribes.push(session.subscribe((event) => void events.push(event)));
    const promptText = assemblePrompt(spec, repoContext, skillsText);
    const onOuterAbort = (): void => {
      void session.abort();
    };
    let timedOut = false;
    const finishPrompt = async (): Promise<ChildOutcome> => {
      const timer = setTimeout(() => {
        timedOut = true;
        onOuterAbort();
      }, Math.max(1000, spec.timeoutMs));
      try {
        // PromptOptions carries no signal; cancellation goes through abort().
        await session.prompt(promptText);
      } catch {
        if (timedOut) {
          return { result: null, textFallback: lastAssistantText(session), reads, failureCode: "TIMEOUT", events };
        }
        if (opts.signal?.aborted) {
          return { result: null, textFallback: lastAssistantText(session), reads, failureCode: "ABORTED", events };
        }
        return {
          result: null,
          textFallback: lastAssistantText(session),
          reads,
          failureCode: "PROVIDER_ERROR",
          events,
        };
      } finally {
        clearTimeout(timer);
      }
      if (collector.accepted) {
        return { result: collector.accepted, textFallback: null, reads, events };
      }
      return { result: null, textFallback: lastAssistantText(session), reads, failureCode: "RESULT_MISSING", events };
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        outcome = { result: null, textFallback: null, reads, failureCode: "ABORTED", events };
      } else {
        opts.signal.addEventListener("abort", onOuterAbort, { once: true });
        try {
          outcome = await finishPrompt();
        } finally {
          opts.signal.removeEventListener("abort", onOuterAbort);
        }
      }
    } else {
      outcome = await finishPrompt();
    }
  } finally {
    for (const unsub of unsubscribes) {
      try {
        unsub();
      } catch {
        // Ignore unsubscribe errors during teardown.
      }
    }
    try {
      session.dispose();
    } catch {
      // Ignore dispose errors during teardown.
    }
  }
  if (spec.usage) {
    await reconcileChildUsage(spec.usage, sessionId ?? invocationId, invocationId, outcome);
  }
  if (outcome.result) {
    logInfo("child", "child succeeded", { role: spec.role, model: `${spec.model.provider}/${spec.model.id}`, reads: outcome.reads.length });
  } else {
    logWarn("child", "child failed", {
      role: spec.role,
      model: `${spec.model.provider}/${spec.model.id}`,
      failure: outcome.failureCode ?? "unknown",
    });
  }
  logDebug("child", "child settled", { role: spec.role, session: (sessionId ?? invocationId).slice(0, 16) });
  return outcome;
}

interface UsageSink {
  ledger: UsageLedger;
  runId: string;
  recordHostUsage: (observation: HostUsageObservation) => Promise<unknown>;
}

/**
 * Reconcile authoritative assistant message_end usage exactly once per
 * invocation (id-keyed). Attempts that produced no attributable usage record
 * zeros + complete:false in the ledger only.
 */
export async function reconcileChildUsage(
  sink: UsageSink,
  sessionId: string,
  invocationId: string,
  outcome: ChildOutcome,
): Promise<number> {
  let reconciled = 0;
  let ordinal = 0;
  for (const event of outcome.events) {
    const message = (event as { type?: unknown; message?: unknown })?.type === "message_end"
      ? (event as { message?: unknown }).message
      : undefined;
    if (!message || typeof message !== "object") continue;
    const m = message as { role?: unknown; usage?: unknown; provider?: unknown; model?: unknown };
    if (m.role !== "assistant" || !m.usage || typeof m.usage !== "object") continue;
    const usage = m.usage as Record<string, unknown>;
    if (typeof usage["input"] !== "number" || typeof usage["output"] !== "number") continue;
    const requestKey = `${invocationId}#m${ordinal++}`;
    const provider = typeof m.provider === "string" ? m.provider : "unknown";
    const modelId = typeof m.model === "string" ? m.model : "unknown";
    const recorded = await sink.ledger.record({
      runId: sink.runId,
      sessionId,
      requestKey,
      source: "child",
      provider,
      modelId,
      usage: usage as never,
      complete: true,
    });
    if (recorded) {
      reconciled++;
      const costTotal = (usage["cost"] as { total?: unknown } | undefined)?.total;
      try {
        await sink.recordHostUsage({
          messageId: requestKey,
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
        // Host-usage projection is best-effort; the ledger is authoritative.
      }
    }
  }
  if (reconciled === 0 && outcome.failureCode) {
    await sink.ledger.record({
      runId: sink.runId,
      sessionId,
      requestKey: `${invocationId}#attempt`,
      source: "child",
      provider: "unknown",
      modelId: "unknown",
      usage: null,
      complete: false,
    });
  }
  return reconciled;
}

function lastAssistantText(session: { sessionManager?: { buildSessionContext?: () => { messages?: unknown[] } } }): string | null {
  try {
    const context = session.sessionManager?.buildSessionContext?.();
    const messages = context?.messages;
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as { role?: unknown; content?: unknown };
      if (message?.role !== "assistant") continue;
      const content = message.content;
      if (typeof content === "string") return content.slice(0, 4000) || null;
      if (Array.isArray(content)) {
        const text = content
          .map((block) => (block as { type?: unknown; text?: unknown }).text)
          .filter((t): t is string => typeof t === "string")
          .join("\n")
          .slice(0, 4000);
        if (text) return text;
      }
    }
    return null;
  } catch {
    return null;
  }
}
