/**
 * OpenCode 2 beta adapter.
 *
 * This module deliberately has no dependency on the V1 plugin types. OpenCode
 * 2's beta API registers a plugin object through `define`, while V1 loads a
 * hook factory. Keeping the contracts in separate entry points prevents an
 * incompatible host from evaluating the other generation's adapter.
 */

import { loadConfig } from "./config-loader.ts";
import { FeatureGate } from "./feature-gate.ts";
import { PluginRuntime } from "./runtime.ts";
import { PACKAGE_VERSION } from "../../../src/version.ts";
import type { LifecycleContext } from "./lifecycle.ts";
import { renderPacketForPrompt } from "./packet-rendering.ts";

/**
 * V2 session context (verified against @opencode/plugin 2.0.16:
 * SessionRequest has mutable `system: SystemPart[]` plus `messages`).
 * Intentionally structural (no V2-only imports) so V1 builds never evaluate
 * the other generation's adapter.
 */
export interface OpenCodeV2SystemPart {
  type: "text";
  text: string;
}

export interface OpenCodeV2MessagePart {
  type?: unknown;
  text?: unknown;
}

export interface OpenCodeV2Message {
  role?: unknown;
  /** Real V2 shape: content is always a parts array. */
  content?: unknown;
  /** Legacy tolerance: pre-release shapes carried info.role / parts. */
  info?: { role?: unknown };
  parts?: unknown;
}

export interface OpenCodeV2SessionContext {
  readonly sessionID: unknown;
  system: OpenCodeV2SystemPart[];
  messages: readonly OpenCodeV2Message[];
}

export interface OpenCodeV2Registration {
  dispose(): Promise<void>;
}

export interface OpenCodeV2Context {
  session: {
    hook(name: "context", callback: (session: OpenCodeV2SessionContext) => Promise<void> | void): Promise<OpenCodeV2Registration>;
  };
  tool: {
    hook(
      name: "execute.after",
      callback: (input: {
        tool: string;
        status: "completed" | "error";
        error?: unknown;
        result?: unknown;
      }) => Promise<void> | void,
    ): Promise<OpenCodeV2Registration>;
  };
}

export interface OpenCodeV2Plugin {
  readonly id: string;
  setup(context: OpenCodeV2Context): Promise<(() => Promise<void>) | void>;
}

export const OPENCODE_V2_PLUGIN_ID = "supracortex";

/** Remind threshold shared with V1 (env override SUPRACORTEX_REMIND_AFTER_N).
 * High by default and applied with a per-session guard, so the advisory stays
 * rare instead of firing on every skipped turn. */
function v2RemindThreshold(): number {
  const raw = process.env.SUPRACORTEX_REMIND_AFTER_N?.trim();
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  }
  return 25;
}

export const V2_REMIND_LINE =
  "Project memory: recall before multi-file work — delegate recall to @cortex when the host provides it; otherwise call cortex_context.";

/**
 * Host tools that mutate files on disk. Completing one can stale the in-memory
 * repository index, so the TTL cache is dropped and the next context request
 * re-walks. Mirrors the V1 set in plugin.ts; read-only and `cortex_*` tools are
 * deliberately absent.
 */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
  "apply_patch",
  "create",
]);

function hasRenderableContextV2(packet: unknown): boolean {
  // Mirrors V1 hasRenderableContext five-array check (plugin.ts).
  const p = packet as {
    selectedMemory?: unknown[];
    constraints?: unknown[];
    knownFailures?: unknown[];
    selectedFiles?: unknown[];
    selectedSummaries?: unknown[];
  } | null;
  if (!p || typeof p !== "object") return false;
  return (
    (p.selectedMemory?.length ?? 0) > 0 ||
    (p.constraints?.length ?? 0) > 0 ||
    (p.knownFailures?.length ?? 0) > 0 ||
    (p.selectedFiles?.length ?? 0) > 0 ||
    (p.selectedSummaries?.length ?? 0) > 0
  );
}

/** Best-effort cortex_* reset for V2: V2 exposes no tool hooks, so inspect a
 * bounded slice of recent history for a tool invocation/result. Never
 * stringify whole messages: one large tool result must not block every next
 * context request just to clear an advisory counter. */
export function hasCortexToolUse(messages: readonly unknown[]): boolean {
  let remaining = 32_000;
  const seen = new WeakSet<object>();
  const preferredKeys = ["tool", "toolName", "name", "type", "role", "parts", "content", "input", "arguments", "result", "output"];
  const visit = (value: unknown, depth: number): boolean => {
    if (remaining <= 0 || depth > 6 || value === null || value === undefined) return false;
    if (typeof value === "string") {
      const text = value.slice(0, remaining);
      remaining -= text.length;
      return text.includes("cortex_");
    }
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 16)) if (visit(item, depth + 1)) return true;
      return false;
    }
    const record = value as Record<string, unknown>;
    const prioritized = preferredKeys.filter((key) => Object.hasOwn(record, key));
    const ordered = [...prioritized];
    let extras = 0;
    for (const key in record) {
      if (!Object.hasOwn(record, key) || preferredKeys.includes(key)) continue;
      ordered.push(key);
      if (++extras >= 24) break;
    }
    for (const key of ordered) {
      if (remaining <= 0) break;
      if (key.includes("cortex_")) return true;
      if (visit(record[key], depth + 1)) return true;
    }
    return false;
  };
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - 10); index--) {
    if (visit(messages[index], 0)) return true;
    if (remaining <= 0) break;
  }
  return false;
}
function textParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("\n")
    .trim();
}

/** Latest explicit user request text (pure; exported for tests and reuse). */
export function userTask(messages: readonly OpenCodeV2Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message) continue;
    // Real V2 shape: { role: "user", content: [{ type: "text", text }] }.
    if (message.role === "user") {
      if (typeof message.content === "string" && message.content.trim()) {
        return message.content.trim().slice(0, 8_000);
      }
      const text = textParts(message.content);
      if (text) return text.slice(0, 8_000);
      continue;
    }
    // Legacy tolerance: pre-release shapes carried info.role / parts.
    if (message.info?.role === "user") {
      const text = textParts(message.parts);
      if (text) return text.slice(0, 8_000);
    }
  }
  return undefined;
}

/**
 * Register V2 lifecycle hooks. V2 does not expose V1's native tool factory,
 * so MCP remains the stable tool surface while this adapter owns lifecycle and
 * context preparation. Every callback is best-effort and never blocks a host
 * request.
 */
export const SupraCortexV2: OpenCodeV2Plugin = {
  id: OPENCODE_V2_PLUGIN_ID,
  async setup(context) {
    const projectRoot = process.env.SUPRACORTEX_ROOT || process.cwd();
    let runtime: PluginRuntime | undefined;
    let automaticContext = false;

    try {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const gate = new FeatureGate(loaded.config.enabled, loaded.reason);
      const lifecycle: LifecycleContext = {
        config: loaded.config,
        projectRoot,
        worktree: projectRoot,
        pluginVersion: PACKAGE_VERSION,
      };
      runtime = new PluginRuntime({ gate, lifecycle });
      automaticContext = gate.active && loaded.config.integration.automaticContextPreparation;
    } catch {
      return;
    }

    if (!runtime.gate.active || !automaticContext) {
      await runtime.dispose();
      return;
    }

    let registration: OpenCodeV2Registration;
    let toolRegistration: OpenCodeV2Registration | undefined;
    // Remind nudge (advisory, single nudge per session at threshold).
    const v2Skips = new Map<string, number>();
    const v2Nudged = new Set<string>();
    const v2Threshold = v2RemindThreshold();
    // V1 parity: ending the per-request mute clears the skip counter plus
    // every nudged requestKey belonging to the session.
    const clearV2RemindForSession = (sessionKey: string): void => {
      try {
        v2Skips.delete(sessionKey);
        const prefix = `${sessionKey}\u0000`;
        for (const key of v2Nudged) {
          if (key === sessionKey || key.startsWith(prefix)) v2Nudged.delete(key);
        }
      } catch { /* advisory only */ }
    };
    try {
      registration = await context.session.hook("context", async (session) => {
        try {
          const task = userTask(session.messages);
          if (!task) return;
          const sessionKey = String((session as { sessionID?: unknown }).sessionID ?? task.slice(0, 64));
          // V2 parity with V1 tool.execute.before: any cortex_* tool call
          // clears the session skip counter (advisory; never blocks).
          try {
            if (hasCortexToolUse(session.messages)) clearV2RemindForSession(sessionKey);
          } catch { /* advisory only */ }
          const engine = await runtime?.getEngine();
          if (!engine) return;
          const packet = await engine.prepareContext({ query: task, maxTokens: 1_500 }, await runtime.gather(undefined, []));
          const renderable = hasRenderableContextV2(packet);
          if (!packet || !renderable) {
            // Propagate the actual gate reason (mirrors V1 closed reason set).
            const reason = !packet ? "empty-packet" : "gate-below-threshold";
            const skips = (v2Skips.get(sessionKey) ?? 0) + 1;
            v2Skips.set(sessionKey, skips);
            // Session-keyed guard (V1 parity): at most one advisory per session
            // until a fresh injection / cortex_* use / new session resets it.
            if (skips >= v2Threshold && !v2Nudged.has(sessionKey)) {
              v2Nudged.add(sessionKey);
              const line = `[supracortex:remind] reason=${reason}: ${V2_REMIND_LINE}`;
              session.system.push({ type: "text", text: line } as never);
            }
            if (packet) return;
            return;
          }
          clearV2RemindForSession(sessionKey);
          session.system.push({ type: "text", text: renderPacketForPrompt(packet) } as never);
        } catch {
          // Context injection is optional and must fail open.
        }
      });
      toolRegistration = await context.tool.hook("execute.after", async (input) => {
        try {
          // V2 plugin SDK identifies tool errors structurally. Only the tool
          // name + short redacted error are retained; never arguments/results.
          const errorText =
            input.status === "error"
              ? typeof input.error === "string"
                ? input.error
                : input.error instanceof Error
                  ? input.error.message
                  : "tool reported an error"
              : undefined;
          const engine = await runtime?.getEngine();
          engine?.recordCapabilityOutcome({
            tool: input.tool,
            ok: input.status === "completed",
            ...(errorText ? { error: errorText.slice(0, 200) } : {}),
          });
          // A completed file-mutating tool can change source bytes on disk. Drop
          // the Engine's in-memory index so the next prepareContext re-walks
          // instead of serving the TTL cache. Fail-open: invalidation must never
          // block the tool result.
          if (typeof input.tool === "string" && FILE_MUTATING_TOOLS.has(input.tool)) {
            engine?.invalidateIndexCache();
          }
        } catch {
          // Health observation is optional and never blocks tool results.
        }
      });
    } catch {
      await runtime.dispose().catch(() => undefined);
      return;
    }

    return async () => {
      await toolRegistration?.dispose().catch(() => undefined);
      await registration.dispose().catch(() => undefined);
      await runtime?.dispose().catch(() => undefined);
    };
  },
};

export default SupraCortexV2;
