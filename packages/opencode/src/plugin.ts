/**
 * OpenCode plugin entry for supracortex.
 *
 * Registers tools and lifecycle hooks. Design guarantees:
 *   - When disabled (config, mode=off, or SUPRACORTEX_DISABLE), the
 *     plugin returns a minimal hook set that does no IO and consumes no tokens.
 *   - Initialization never throws to OpenCode; failures degrade to a no-op and
 *     are surfaced via status/doctor.
 *   - The supported `experimental.chat.messages.transform` hook captures the
 *     latest explicit user task; `experimental.chat.system.transform` then
 *     injects a compact packet for that request when automatic preparation is
 *     enabled. A host-provided subagent is optional guidance, not a prerequisite.
 *
 * OpenCode plugin API reference (v1.17.x): Plugin = (input, options?) => Hooks.
 * PluginInput = { client, project, directory, worktree, serverUrl, $ }.
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config-loader.ts";
import { FeatureGate } from "./feature-gate.ts";
import { PluginRuntime } from "./runtime.ts";
import { buildTools, resolveCanonicalToolName } from "./tools/index.ts";
import { renderPacketForPrompt, PACKET_MARKER } from "./packet-rendering.ts";
import { boundedAdd, MAX_TRACKED_SESSIONS } from "./bounded-set.ts";
import type { LifecycleContext } from "./lifecycle.ts";
import { PACKAGE_VERSION } from "../../../src/version.ts";
import type { HostUsageObservation } from "@local/supracortex-core";
import { hashToolArguments, resolveProjectStorageDirectory } from "@local/supracortex-core";

/** @deprecated Use PACKAGE_VERSION. Kept as an adapter compatibility export. */
export const PLUGIN_VERSION = PACKAGE_VERSION;

// ---------------------------------------------------------------------------
// Injection gate observability (spec 5b). Every exit from the automatic
// context-injection path emits a frozen InjectionDecision ({inject, reason,
// lastInjectionAt, requestId}), persists lastSkipReason / lastInjectionAt on
// the shared injectionGateState (also mirrored onto the runtime instance so
// status readers via rt can observe it), and best-effort mirrors the decision
// to <storage>/state/injection.json so cross-process status CLI readers see
// it too. Reason codes are closed: unknown is forbidden and fails closed to
// "gate-below-threshold". Dedup (1 injection/request) and gating thresholds
// are unchanged; this only adds observability.
// ---------------------------------------------------------------------------

/** Closed set of skip reasons. Unknown reasons are forbidden. */
export type InjectionSkipReason =
  | "no-query"
  | "empty-packet"
  | "dedup"
  | "disabled"
  | "gate-below-threshold";

/** Full reason set: skips plus the successful-injection marker. */
export type InjectionReason = InjectionSkipReason | "injected";

/** Packet knowledge available to the gate classifier. */
export type InjectionPacketState = "not-requested" | "empty" | "below-threshold" | "renderable";

/** Frozen per-exit decision emitted by shouldInject(). */
export interface InjectionDecision {
  inject: boolean;
  reason: InjectionReason;
  lastInjectionAt: string | null;
  requestId: string;
}

/** Persisted gate observability read by status. */
export interface InjectionGateState {
  lastSkipReason: InjectionSkipReason | null;
  lastInjectionAt: string | null;
  injections: number;
  skips: number;
}

/** Shared gate observability. Module-level so every plugin instance and the
 * status read path observe the same writer. */
export const injectionGateState: InjectionGateState = {
  lastSkipReason: null,
  lastInjectionAt: null,
  injections: 0,
  skips: 0,
};

/** Reset gate observability (tests/harness only). File mirror is untouched. */
export function resetInjectionGateState(): void {
  injectionGateState.lastSkipReason = null;
  injectionGateState.lastInjectionAt = null;
  injectionGateState.injections = 0;
  injectionGateState.skips = 0;
}

/** Remind-nudge threshold: consecutive skipped requests without a cortex call
 * before one advisory nudge (at most once per session — see the nudge guard).
 * Deliberately high so the advisory is rare noise, not per-turn nagging.
 * Env override SUPRACORTEX_REMIND_AFTER_N. */
export function remindThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SUPRACORTEX_REMIND_AFTER_N?.trim();
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  }
  return 25;
}

/** Pure helper: true when `skips` reaches the remind threshold. */
export function shouldRemind(skips: number, threshold: number): boolean {
  return skips >= threshold;
}

export const REMIND_LINE =
  "Project memory: recall before multi-file work — delegate recall to @cortex when the host provides it; otherwise call cortex_context.";

// ---------------------------------------------------------------------------
// File mirror for cross-process status readers. In-memory state stays primary
// for the hot path; this best-effort mirror lets `status` (cli-core, which
// reads <storage>/state/injection.json) observe lastInjectionAt/reason written
// by the gate in another process. Writes are atomic (tmp+rename), create the
// state dir, and never throw: on any failure they warn and the gate stays
// fail-closed on its in-memory decision.
// ---------------------------------------------------------------------------

/** Directory holding the injection.json mirror (<storage>/state). Null = disabled. */
let injectionGateStateDir: string | null = null;
let injectionMirrorWrites: Promise<void> = Promise.resolve();
let injectionMirrorSequence = 0;

/** Point the file mirror at a state dir (plugin init; tests use a temp dir). */
export function setInjectionGateStateDir(dir: string | null): void {
  injectionGateStateDir = dir;
}

/** Current mirror dir, or null when mirroring is disabled. */
export function getInjectionGateStateDir(): string | null {
  return injectionGateStateDir;
}

/** Stable, non-reversible request id. Never persist the raw session id or
 * query text: the mirror is readable by other local processes. */
function digestRequestId(sessionId: string, query: string | null): string {
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\u0000")
    .update(query ?? "")
    .digest("hex")
    .slice(0, 32);
  return `ctx-${digest}`;
}

/** True when a parsed JSON value contains a NUL character in any string.
 * Legacy mirrors were written with JSON.stringify, so the NUL in
 * "session\0query" was persisted as the six-character escape `\u0000`: the raw
 * byte check misses it and JSON.parse succeeds. */
function containsNulString(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNulString);
  if (value && typeof value === "object") {
    return (
      Object.keys(value).some(containsNulString) ||
      Object.values(value as Record<string, unknown>).some(containsNulString)
    );
  }
  return false;
}

let legacyPurgeWarned = false;

/** Best-effort purge of a legacy injection.json that embedded raw
 * session/query text (as a raw NUL byte or the stringified `\u0000` escape) or
 * is unreadable JSON. Never throws and performs at most one read. ENOENT is
 * silent.
 *
 * The purge is chained onto injectionMirrorWrites so an init-time purge always
 * completes before any subsequent mirror write and can never unlink a freshly
 * written sanitized mirror. Returns the chained promise. */
export function sanitizeLegacyInjectionMirror(dir: string | null): Promise<void> {
  if (!dir) return Promise.resolve();
  const target = join(dir, "injection.json");
  const run = injectionMirrorWrites
    .catch(() => undefined)
    .then(async () => {
      // Never operate through a symlinked state directory: a repo-shipped
      // `.supracortex/state` link could redirect the purge outside the project.
      try {
        const info = await lstat(dir);
        if (!info.isDirectory()) return;
      } catch {
        return; // Missing dir: nothing to purge.
      }
      let raw: Buffer;
      let readMtime: number;
      try {
        raw = await readFile(target);
        readMtime = (await stat(target)).mtimeMs;
      } catch {
        // ENOENT (nothing to purge) or any read failure: best-effort only.
        return;
      }
      let purge = raw.includes(0);
      if (!purge) {
        try {
          purge = containsNulString(JSON.parse(raw.toString("utf8")));
        } catch {
          purge = true; // Unreadable JSON: legacy or corrupt, remove it.
        }
      }
      if (!purge) return;
      try {
        // Cross-process guard: another host may have atomically replaced the
        // mirror with a sanitized one since we read it. Never delete a newer
        // write. (The in-process write queue already serializes our own writes.)
        const now = await stat(target);
        if (now.mtimeMs !== readMtime || now.size !== raw.length) return;
        await unlink(target);
      } catch (err) {
        // A concurrent purge removing the file first is harmless.
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
        if (!legacyPurgeWarned) {
          legacyPurgeWarned = true;
          // Redacted: no path, file contents, or query text in the log line.
          console.warn("[supracortex:injection-gate] legacy mirror purge failed");
        }
      }
    });
  injectionMirrorWrites = run;
  return run;
}

/** Best-effort, ordered atomic mirror of the latest decision. This is
 * deliberately asynchronous: synchronous mkdir/write/rename ran on every
 * request's system-transform hook and stalled the host event loop on storage. */
function mirrorGateDecision(reason: InjectionReason, requestId: string): void {
  const dir = injectionGateStateDir;
  if (!dir) return;
  const target = join(dir, "injection.json");
  const tmp = `${target}.${process.pid}.${++injectionMirrorSequence}.tmp`;
  const payload = JSON.stringify({
    reason,
    lastSkipReason: injectionGateState.lastSkipReason,
    lastInjectionAt: injectionGateState.lastInjectionAt,
    requestId,
  });
  injectionMirrorWrites = injectionMirrorWrites
    .catch(() => undefined)
    .then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, target);
      } catch (err) {
        // Disk full, read-only FS, concurrent removal: warn only, never block.
        console.warn(
          `[supracortex:injection-gate] mirror write failed: ${(err as Error)?.message ?? err}`,
        );
      }
    });
}

/** Wait for queued mirror writes; useful to consumers that need a fresh status
 * snapshot immediately after observing the in-memory decision. */
export async function flushInjectionGateMirror(): Promise<void> {
  await injectionMirrorWrites;
}

const INJECTION_REASONS: ReadonlySet<string> = new Set([
  "no-query",
  "empty-packet",
  "dedup",
  "disabled",
  "gate-below-threshold",
  "injected",
]);

/**
 * Host tools that mutate files on disk. Completing one can stale the in-memory
 * repository index, so the TTL cache is dropped and the next context request
 * re-walks. Read-only and `cortex_*` tools are deliberately absent.
 */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
  "apply_patch",
  "create",
]);

/** Pure classifier: map gate inputs to a closed reason code. Unknown input
 * fails closed to "gate-below-threshold" (unknown reasons are forbidden). */
export function getReason(state: {
  gateActive: boolean;
  hasQuery: boolean;
  dedupHit: boolean;
  packetState: InjectionPacketState;
  unknownError?: boolean;
}): InjectionReason {
  if (state.unknownError) return state.gateActive ? "gate-below-threshold" : "disabled";
  if (!state.gateActive) return "disabled";
  if (!state.hasQuery) return "no-query";
  if (state.dedupHit) return "dedup";
  switch (state.packetState) {
    case "renderable": return "injected";
    case "empty": return "empty-packet";
    default: return "gate-below-threshold";
  }
}

/**
 * Single emitting writer for the injection gate. Classifies via getReason(),
 * persists lastSkipReason (+skips) or lastInjectionAt (+injections) on
 * injectionGateState, mirrors the decision to state/injection.json for
 * cross-process status readers (best-effort, never throws), logs the decision
 * on the canonical telemetry path, and returns the frozen decision. Every gate
 * exit must go through here so no skip is unexplained.
 *
 * The closed 5-value reason set (+ "injected") is preserved on the return
 * value and the file mirror. `detail` carries free-form debug context
 * (engine-missing, pre-injected, session-known, error text) in the log line
 * only, never in the persisted reason.
 */
export function shouldInject(input: {
  sessionId?: string;
  query?: string | null;
  gateActive: boolean;
  dedupHit?: boolean;
  packetState?: InjectionPacketState;
  unknownError?: boolean;
  detail?: string;
}): InjectionDecision {
  const sessionId = input.sessionId ?? "";
  const query = input.query ?? null;
  const packetState = input.packetState ?? "not-requested";
  const detailSuffix = input.detail ? ` detail=${JSON.stringify(input.detail)}` : "";
  const reason = getReason({
    gateActive: input.gateActive,
    hasQuery: typeof query === "string" && query.length > 0,
    dedupHit: input.dedupHit ?? false,
    packetState,
    ...(input.unknownError !== undefined ? { unknownError: input.unknownError } : {}),
  });
  if (!INJECTION_REASONS.has(reason)) {
    // Defense in depth: the closed set above must hold; fail closed loudly.
    console.warn(`[supracortex:injection-gate] unknown reason blocked, failing closed`);
    injectionGateState.lastSkipReason = "gate-below-threshold";
    injectionGateState.skips += 1;
    const fallbackRequestId = digestRequestId(sessionId, query);
    mirrorGateDecision("gate-below-threshold", fallbackRequestId);
    return Object.freeze({
      inject: false,
      reason: "gate-below-threshold" as InjectionReason,
      lastInjectionAt: injectionGateState.lastInjectionAt,
      requestId: fallbackRequestId,
    });
  }
  if (reason === "injected") {
    injectionGateState.lastInjectionAt = new Date().toISOString();
    injectionGateState.injections += 1;
  } else {
    injectionGateState.lastSkipReason = reason;
    injectionGateState.skips += 1;
  }
  const requestId = digestRequestId(sessionId, query);
  mirrorGateDecision(reason, requestId);
  // Gate decisions are routine per-request traffic, not warnings. Logging
  // every skip at warn level overwhelms OpenCode logs and made bulk sessions
  // needlessly slow. Detailed reasons remain in the state mirror; exceptional
  // hook/mirror failures are still logged at their catch sites.
  return Object.freeze({
    inject: reason === "injected",
    reason,
    lastInjectionAt: injectionGateState.lastInjectionAt,
    requestId,
  });
}

/** Mirror shared gate state onto the runtime so status readers via rt see it. */
function exposeGateState(runtime: PluginRuntime): void {
  (runtime as unknown as { injectionGate?: InjectionGateState }).injectionGate = injectionGateState;
}

/**
 * The plugin. Exported as a named export per OpenCode conventions.
 */
export const SupraCortex: Plugin = async (input) => {
  const heartbeatSeen = new Map<string, number>();
  const projectRoot = input.directory ?? input.worktree ?? process.cwd();

  // 1. Resolve config with full precedence. This is cheap (a couple of reads).
  let gate: FeatureGate;
  let runtime: PluginRuntime | null = null;
  let autoPrepare = false;
  // Local value measurement (correlational only). Default ON; when false the
  // measurement hooks below are pure no-ops that change nothing.
  let vmEnabled = false;

  try {
    const loaded = await loadConfig({ projectRoot, env: process.env });
    gate = new FeatureGate(loaded.config.enabled, loaded.reason);

    // Point the gate file mirror at the same <storage>/state dir that status
    // reads (cli-core: state/injection.json). Best-effort: a bad configured
    // directory falls back to .supracortex/state, never breaks startup.
    try {
      setInjectionGateStateDir(
        join(resolveProjectStorageDirectory(projectRoot, loaded.config.storage.directory), "state"),
      );
    } catch {
      setInjectionGateStateDir(join(projectRoot, ".supracortex", "state"));
    }
    // Purge any legacy mirror (raw session/query text or unreadable JSON).
    // Fire-and-forget: sanitization must never delay or break plugin init.
    void sanitizeLegacyInjectionMirror(getInjectionGateStateDir()).catch(() => undefined);

    // If disabled, return the minimal safe hook set immediately. No engine, no
    // discovery, no indexing. Tools still register but respond "disabled".
    const lifecycle: LifecycleContext = {
      config: loaded.config,
      projectRoot,
      worktree: input.worktree ?? projectRoot,
      pluginVersion: PLUGIN_VERSION,
      client: input.client as unknown as LifecycleContext["client"],
      shell: input.$ as unknown as LifecycleContext["shell"],
    };
    runtime = new PluginRuntime({ gate, lifecycle });
    exposeGateState(runtime);

    // Native OpenCode context is a host capability, not a subagent feature.
    // The actual task is captured by messages.transform below because the
    // system-transform input intentionally contains no prompt text.
    autoPrepare = gate.active && loaded.config.integration.automaticContextPreparation;
    vmEnabled = gate.active && loaded.config.telemetry.valueMeasurement.enabled;
  } catch (err) {
    // Fail open: never break OpenCode startup.
    gate = new FeatureGate(false, "Disabled after config load error.");
    gate.markFailed((err as Error).message);
    return minimalHooks();
  }

  // The model sees each capability once. buildTools also returns legacy long
  // names as aliases of the same handlers (cortex_prepare_context ->
  // cortex_context, ...); registering both doubled those schemas in every
  // request. Set SUPRACORTEX_LEGACY_TOOL_NAMES=1 to expose the aliases too.
  const allTools = buildTools(runtime);
  const exposeLegacy = /^(1|true|yes|on)$/i.test(process.env.SUPRACORTEX_LEGACY_TOOL_NAMES ?? "");
  const tools = exposeLegacy
    ? allTools
    : Object.fromEntries(
        Object.entries(allTools).filter(([name, def]) => {
          const canonical = resolveCanonicalToolName(name);
          // Keep: canonicals, names outside the alias table, and aliases whose
          // handler differs (e.g. cortex_record_outcome is a distinct facet).
          return canonical === null || canonical === name || allTools[canonical] !== def;
        }),
      );

  // Track OpenCode session lifecycle so the staleness sweep can reap state for
  // sessions that have ended. OpenCode has no timer hook, so we sweep on
  // session.idle / session.deleted (and engine init). Session ids seen alive
  // are remembered; a deleted session is removed and triggers a targeted sweep.
  const liveSessions = new Set<string>();
  // OpenCode's system-transform hook intentionally exposes only session/model.
  // Capture the latest real user message from the supported messages-transform
  // hook, keyed by session, so automatic context has an actual task query.
  const requestState = new Map<string, { query: string; agent?: string }>();
  // Remind nudge: per-session skip counter + single-nudge guard per request.
  // Advisory only, never blocks; reset on any cortex_* tool call success path.
  const remindSkips = new Map<string, number>();
  const remindNudged = new Set<string>();
  const remindAfterN = remindThreshold();

  // Per-request mute ends when the session shows a cortex call, starts over,
  // injects fresh context, or ends: clear the skip counter plus every nudged
  // requestKey belonging to the session (keys are `${sessionId}\0${query}`).
  const clearRemindForSession = (sessionId: string): void => {
    try {
      remindSkips.delete(sessionId);
      const prefix = `${sessionId}\u0000`;
      for (const key of remindNudged) {
        if (key === sessionId || key.startsWith(prefix)) remindNudged.delete(key);
      }
    } catch { /* advisory only */ }
  };

  const rememberRequest = (sessionId: string, state: { query: string; agent?: string }) => {
    if (requestState.has(sessionId)) requestState.delete(sessionId);
    requestState.set(sessionId, state);
    while (requestState.size > MAX_TRACKED_SESSIONS) {
      const oldest = requestState.keys().next().value as string | undefined;
      if (!oldest) break;
      requestState.delete(oldest);
    }
  };

  // -------------------------------------------------------------------------
  // Value measurement state (used only when vmEnabled). All maps are bounded so
  // memory stays fixed regardless of host traffic.
  // callID -> start time + arguments hash + seen count for that tool call.
  const toolExecState = new Map<string, { startedAt: number; argsHash: string; seen: number }>();
  // `${sessionID}\0${tool}\0${argsHash}` -> executions seen (retry heuristic).
  const toolSeenCounts = new Map<string, number>();
  // sessionID -> last taskId observed via cortex_claim_files (best-effort).
  const sessionTask = new Map<string, string>();
  // requestKey -> measured (so we emit exactly one context_injection per request).
  const injectionRecorded = new Set<string>();
  const boundedMapTrim = <K, V>(map: Map<K, V>, max: number): void => {
    while (map.size > max) {
      const first = map.keys().next().value;
      if (first === undefined) break;
      map.delete(first);
    }
  };
  // -------------------------------------------------------------------------

  const hooks: Hooks = {
    tool: tools,

    async "tool.execute.before"(input, output) {
      // Remind reset: any cortex_* tool call clears the session skip counter
      // (advisory; independent of value-measurement opt-in).
      try {
        if (typeof input.tool === "string" && input.tool.startsWith("cortex_") && input.sessionID) {
          clearRemindForSession(input.sessionID);
        }
      } catch { /* never block */ }
      if (!vmEnabled || !input.callID) return;
      try {
        const argsHash = hashToolArguments(output.args);
        const seenKey = `${input.sessionID ?? ""}\u0000${input.tool}\u0000${argsHash}`;
        const seen = (toolSeenCounts.get(seenKey) ?? 0) + 1;
        toolSeenCounts.set(seenKey, seen);
        boundedMapTrim(toolSeenCounts, 5000);
        toolExecState.set(input.callID, { startedAt: Date.now(), argsHash, seen });
        boundedMapTrim(toolExecState, 5000);
        // cortex_claim_files is the task-establishing tool: remember the taskId
        // for later correlation (best-effort). args is the arguments object.
        const rawArgs = output.args as Record<string, unknown> | undefined;
        if (input.tool === "cortex_claim_files" && typeof rawArgs?.taskId === "string" && input.sessionID) {
          sessionTask.set(input.sessionID, rawArgs.taskId);
          boundedMapTrim(sessionTask, MAX_TRACKED_SESSIONS);
        }
      } catch (err) {
        // never break the tool call; the failure is logged for debuggability
        console.debug(`[supracortex:injection-gate] tool.execute.before error: ${(err as Error)?.message ?? err}`);
      }
    },

    async "tool.execute.after"(input, output) {
      // A completed file-mutating tool can change source bytes on disk. Drop the
      // Engine's in-memory index so the next context request re-walks instead of
      // serving the TTL cache. Fail-open: invalidation must never block the tool
      // result. Skips silently when the engine is unavailable (null).
      try {
        if (typeof input.tool === "string" && FILE_MUTATING_TOOLS.has(input.tool)) {
          const engine = await runtime!.getEngine();
          engine?.invalidateIndexCache();
        }
      } catch {
        // never break the host path
      }
      // Capability health observation (operational, independent of value
      // measurement): attribute MCP-pattern tool results to their server so
      // failing servers cool down instead of being recommended forever.
      // Error detection is an explicit heuristic — result text starting with
      // "Error:" or a metadata error marker. Anything else counts as tested.
      try {
        if (typeof input.tool === "string" && input.tool.includes("_") && !input.tool.startsWith("cortex_")) {
          const engine = await runtime!.getEngine();
          if (engine) {
            const text = typeof output?.output === "string" ? output.output : "";
            const meta = (output as { metadata?: unknown } | undefined)?.metadata;
            const metaError =
              !!meta && typeof meta === "object" && "error" in (meta as Record<string, unknown>);
            const failed = metaError || /^\s*error:/i.test(text);
            engine.recordCapabilityOutcome({
              tool: input.tool,
              ok: !failed,
              ...(failed ? { error: text.slice(0, 200) || "tool reported an error" } : {}),
            });
          }
        }
      } catch {
        // Observation must never break the host path.
      }
      if (!vmEnabled || !input.callID) return;
      let state: { startedAt: number; argsHash: string; seen: number } | undefined;
      try {
        state = toolExecState.get(input.callID);
        if (state) toolExecState.delete(input.callID);
        if (!state) return;
        const latencyMs = Date.now() - state.startedAt;
        const engine = await runtime!.getEngine();
        if (!engine) return;
        const taskId = input.sessionID ? sessionTask.get(input.sessionID) : undefined;
        await engine.recordToolExecution({
          tool: input.tool,
          latencyMs,
          retryCount: Math.max(0, state.seen - 1),
          argumentsHash: state.argsHash,
          sessionId: input.sessionID,
          ...(taskId ? { taskId } : {}),
        });
      } catch (err) {
        // never break the host path; the failure is logged for debuggability
        console.debug(`[supracortex:injection-gate] tool.execute.after error: ${(err as Error)?.message ?? err}`);
      }
    },

    async "experimental.chat.messages.transform"(_input, output) {
      try {
        // The host supplies the current message list; walk backwards so the
        // latest explicit user request wins. Never derive a task from system,
        // assistant, tool, reasoning, or synthetic text.
        for (let i = output.messages.length - 1; i >= 0; i--) {
          const message = output.messages[i] as unknown as {
            info?: { role?: unknown; sessionID?: unknown; agent?: unknown };
            parts?: unknown[];
          };
          if (message.info?.role !== "user" || typeof message.info.sessionID !== "string") continue;
          const query = extractUserTaskFromMessageParts(message.parts);
          if (!query) continue;
          const agent = typeof message.info.agent === "string" && message.info.agent.trim()
            ? message.info.agent.trim().slice(0, 256)
            : undefined;
          rememberRequest(message.info.sessionID, agent ? { query, agent } : { query });
          break;
        }
      } catch (err) {
        // Context preparation is optional; never break a model request.
        console.debug(`[supracortex:injection-gate] messages.transform error: ${(err as Error)?.message ?? err}`);
      }
    },

    async event(input) {
      if (!gate.active) return;
      try {
        const evt = (input as { event?: { type?: string; properties?: Record<string, unknown> } })
          .event;
        if (!evt?.type) return;
        const props = evt.properties ?? {};
        const info = (props.info ?? {}) as { id?: string };
        const sessionId =
          (props.sessionID as string | undefined) ?? info.id ?? undefined;

        if (evt.type === "message.updated") {
          const now = Date.now();
          const interval = Math.max(1_000, 60_000 / 10);
          const lastHeartbeat = sessionId ? heartbeatSeen.get(sessionId) : undefined;
          if (sessionId && lastHeartbeat !== undefined && now - lastHeartbeat < interval) return;
          const engine = await runtime!.getEngine();
          if (engine && sessionId) {
            const active = await engine.activeTasks();
            heartbeatSeen.set(sessionId, now);
            for (const task of active.filter((t) => t.sessionId === sessionId)) {
              await engine.heartbeat(task.taskId, { sessionId }).catch(() => undefined);
            }
          }
          const usage = extractCompletedAssistantUsage(props.info);
          if (usage) {
            if (engine) await engine.recordHostUsage(usage);
          }
          return;
        }

        if (evt.type === "session.created" && sessionId) {
          boundedAdd(liveSessions, sessionId, MAX_TRACKED_SESSIONS);
          // Activate: reset the per-session nudge state at session start.
          // Intentionally silent — the previous session-start log line was pure
          // console noise and is not emitted (lazy engine init preserved).
          clearRemindForSession(sessionId);
          return;
        }
        if (evt.type === "session.idle") {
          const engine = await runtime!.getEngine();
          if (engine) await engine.sweep("session.idle", { liveSessionIds: new Set(liveSessions), censusComplete: false });
          return;
        }
        if (evt.type === "session.deleted") {
          if (sessionId) {
            liveSessions.delete(sessionId);
            requestState.delete(sessionId);
            clearRemindForSession(sessionId);
          }
          const engine = await runtime!.getEngine();
          // Force a sweep on deletion so a dead session's tasks/claims are reaped
          // promptly, passing the now-reduced live set.
          if (engine)
            await engine.sweep("session.deleted", {
              terminalSessionId: sessionId,
              force: true,
            });
          return;
        }
      } catch (err) {
        // Never let event handling break the host.
        console.debug(`[supracortex:injection-gate] event error: ${(err as Error)?.message ?? err}`);
      }
    },

    async dispose() {
      await runtime?.dispose();
    },
  };

  // Wire only when automatic preparation is enabled. The hook is deliberately
  // a no-op when OpenCode does not expose a real user request: system text is
  // not a task and must never be used as a substitute.
  if (gate.active && autoPrepare) {
    const injectedRequests = new Set<string>();
    hooks["experimental.chat.system.transform"] = async (hookInput, output) => {
      const sessionId = hookInput.sessionID ?? "";
      try {
        if (!gate.active) { shouldInject({ sessionId, gateActive: false, detail: "kill-switch-mid-session" }); return; } // re-check kill switch mid-session
        const request = requestState.get(sessionId);
        // Keep the legacy explicit-field extraction as a compatibility path
        // for hosts that provide it, but use the SDK-supported message state by
        // default because this hook's official input has no prompt field.
        const props = (hookInput as Record<string, unknown>).properties ?? hookInput;
        const query = request?.query ?? extractOpenCodeUserTask(props);
        // Session-ID miss and absent query share the no-query reason; the log
        // detail records whether the session was known for debuggability.
        if (!query) {
          shouldInject({ sessionId, query: null, gateActive: true, detail: `session-known:${requestState.has(sessionId)}` });
          return;
        }
        const requestKey = `${sessionId}\u0000${query}`;
        // Idempotent per actual request, not permanently once per session.
        if (injectedRequests.has(requestKey) || injectionRecorded.has(requestKey)) {
          shouldInject({ sessionId, query, gateActive: true, dedupHit: true, detail: "duplicate-request" });
          return;
        }
        if (output.system.some((s) => s.includes(PACKET_MARKER))) {
          boundedAdd(injectedRequests, requestKey, MAX_TRACKED_SESSIONS);
          // Closed reason stays dedup; detail notes the packet was pre-injected.
          shouldInject({ sessionId, query, gateActive: true, dedupHit: true, detail: "pre-injected" });
          return;
        }
        const engine = await runtime!.getEngine();
        if (!engine) { shouldInject({ sessionId, query, gateActive: gate.active, detail: "engine-missing" }); return; }
        const target = request?.agent ?? extractOpenCodeAgent(props);
        const gather = await runtime!.gather(target, []);
        const packet = await engine.prepareContext({ query }, gather);
        const decision = shouldInject({
          sessionId,
          query,
          gateActive: true,
          packetState: !packet ? "empty" : hasRenderableContext(packet) ? "renderable" : "below-threshold",
        });
        if (decision.inject) {
          output.system.push(renderPacketForPrompt(packet!));
          boundedAdd(injectedRequests, requestKey, MAX_TRACKED_SESSIONS);
          clearRemindForSession(sessionId);
        } else {
          // Remind: count successive non-injected requests per session and emit
          // at most ONE advisory line per session. The guard is keyed by
          // session (not request) so that once the threshold is crossed the
          // advisory does not repeat on every following turn. It is cleared by
          // a fresh injection, a cortex_* tool call, or a new session, so the
          // nudge can resurface only after the agent has stopped skipping
          // again. Never blocks; includes the reason code explicitly.
          try {
            const skips = (remindSkips.get(sessionId) ?? 0) + 1;
            remindSkips.set(sessionId, skips);
            while (remindSkips.size > MAX_TRACKED_SESSIONS) {
              const oldest = remindSkips.keys().next().value as string | undefined;
              if (!oldest) break;
              remindSkips.delete(oldest);
            }
            if (shouldRemind(skips, remindAfterN) && !remindNudged.has(sessionId)) {
              const line = `[supracortex:remind] reason=${decision.reason}: ${REMIND_LINE}`;
              output.system.push(line);
              boundedAdd(remindNudged, sessionId, MAX_TRACKED_SESSIONS);
              console.warn(line);
            }
          } catch { /* advisory only */ }
        }
        // Value measurement: record exactly once per request whether context was
        // actually injected this turn (not merely whether it is enabled).
        if (vmEnabled) {
          boundedAdd(injectionRecorded, requestKey, MAX_TRACKED_SESSIONS);
          const taskId = sessionId ? sessionTask.get(sessionId) : undefined;
          await engine.recordContextInjection({
            injected: decision.inject,
            sessionId,
            ...(taskId ? { taskId } : {}),
          });
        }
      } catch (err) {
        // Never fail the model call because of the plugin; the skip is logged
        // with a closed reason instead of exiting silently.
        const message = (err as Error)?.message ?? String(err);
        shouldInject({ sessionId, gateActive: gate.active, unknownError: true, detail: message.slice(0, 200) });
        console.warn(`[supracortex:injection-gate] system.transform error: ${message}`);
      }
    };
  }

  return hooks;
};

/** The safe no-op hook set used when disabled or after a fatal init error. */
function minimalHooks(): Hooks {
  return {
    async dispose() {
      /* nothing to clean up */
    },
  };
}

/** Extract only explicitly supplied user-task fields; never inspect system text. */
export function extractOpenCodeUserTask(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const candidates = [source.userMessage, source.userInput, source.prompt, source.message, source.text];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const task = candidate.trim();
      if (task) return task.slice(0, 65_536);
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      for (const key of ["text", "content", "prompt"]) {
        if (typeof nested[key] === "string" && nested[key].trim()) return nested[key].trim().slice(0, 65_536);
      }
    }
  }
  return null;
}

/** Extract task text from OpenCode's messages-transform parts without trusting
 * system/assistant/tool/synthetic content as a user request. */
export function extractUserTaskFromMessageParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((part): part is { type?: unknown; text?: unknown; synthetic?: unknown; ignored?: unknown } =>
      Boolean(part) && typeof part === "object" && !Array.isArray(part))
    .filter((part) => part.type === "text" && part.synthetic !== true && part.ignored !== true)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
  return text ? text.slice(0, 65_536) : null;
}

/** Extract only numeric usage from a completed assistant message. */
export function extractCompletedAssistantUsage(value: unknown): HostUsageObservation | null {
  if (!value || typeof value !== "object") return null;
  const info = value as Record<string, unknown>;
  if (info.role !== "assistant" || typeof info.id !== "string" || typeof info.sessionID !== "string") {
    return null;
  }
  const time = info.time as Record<string, unknown> | undefined;
  if (typeof time?.completed !== "number" && typeof info.finish !== "string") return null;
  const tokens = info.tokens as Record<string, unknown> | undefined;
  const cache = tokens?.cache as Record<string, unknown> | undefined;
  if (!tokens || typeof info.providerID !== "string" || typeof info.modelID !== "string") return null;
  const n = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
  return {
    messageId: info.id,
    sessionId: info.sessionID,
    provider: info.providerID,
    model: info.modelID,
    observedAt: new Date(n(time?.completed) || Date.now()).toISOString(),
    reportedCost: n(info.cost),
    inputTokens: n(tokens.input),
    outputTokens: n(tokens.output),
    reasoningTokens: n(tokens.reasoning),
    cacheReadTokens: n(cache?.read),
    cacheWriteTokens: n(cache?.write),
  };
}

export function extractOpenCodeAgent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const agent = (value as Record<string, unknown>).agent;
  return typeof agent === "string" && agent.trim() ? agent.trim().slice(0, 256) : undefined;
}

function hasRenderableContext(packet: { selectedMemory: unknown[]; constraints: unknown[]; knownFailures: unknown[]; selectedFiles: unknown[]; selectedSummaries: unknown[] }): boolean {
  return packet.selectedMemory.length > 0 || packet.constraints.length > 0 || packet.knownFailures.length > 0 || packet.selectedFiles.length > 0 || packet.selectedSummaries.length > 0;
}

export default SupraCortex;
