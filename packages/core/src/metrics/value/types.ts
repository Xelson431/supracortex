/**
 * Value measurement event schema (CORRELATIONAL ONLY).
 *
 * Phase 1 records whether a task succeeded, how many retries happened, how long
 * tools took, and how many tokens were used, segmented by whether SupraCortex
 * context was injected. It NEVER claims causation — every report is labelled
 * correlational and under-powered comparisons are refused.
 *
 * Privacy: local-only, no network, no prompts/responses/tool arguments/results.
 * Only a stable hash of tool arguments is stored (for retry detection). Every
 * free-text field is run through the existing secret sanitization before it is
 * persisted.
 *
 * Naming: where an OpenTelemetry GenAI semantic convention exists we use the
 * exact key string under a `genAi` sub-object. Otherwise we namespace under
 * `supracortex.*`. Any approximated value carries `estimated: true` and is
 * listed in `estimatedFields`; an estimate is never presented as measured.
 */

import type { OutcomeStatus } from "../../types.ts";

export const VALUE_EVENTS_SCHEMA_VERSION = 1;

export type ValueEventType =
  | "context_injection"
  | "tool_execution"
  | "provider_usage_link"
  | "task_outcome";

interface ValueEventBase {
  schemaVersion: typeof VALUE_EVENTS_SCHEMA_VERSION;
  eventType: ValueEventType;
  /** ISO-8601 UTC timestamp of when the row was recorded. */
  recordedAt: string;
  /** Correlation key (taskId, incarnationId). Present "where known". */
  taskId?: string;
  incarnationId?: string;
  sessionId?: string;
  /**
   * Present ONLY when at least one value in this row is approximated. An
   * approximation is never presented as a measurement.
   */
  estimated?: true;
  /** The dotted keys that are approximated (when `estimated` is true). */
  estimatedFields?: string[];
}

/** One record per turn: whether context was injected this turn (not merely enabled). */
export interface ContextInjectionEvent extends ValueEventBase {
  eventType: "context_injection";
  supracortex: {
    "supracortex.context.injected": boolean;
  };
}

/**
 * A tool execution. Latency is measured. Retry count is a heuristic (repeated
 * execution of the same tool with the same arguments hash within one task) and
 * is therefore always marked `estimated: true`.
 */
export interface ToolExecutionEvent extends ValueEventBase {
  eventType: "tool_execution";
  genAi?: {
    "gen_ai.operation.name": string;
    "gen_ai.request.model"?: string;
    "gen_ai.response.model"?: string;
    "gen_ai.provider.name"?: string;
    "gen_ai.usage.input_tokens"?: number;
    "gen_ai.usage.output_tokens"?: number;
    "gen_ai.response.finish_reasons"?: string[];
  };
  supracortex: {
    "supracortex.latency_ms": number;
    "supracortex.retry.count"?: number;
    "supracortex.context.injected"?: boolean;
    /**
     * Agent role where known by the recorder ("main" vs "subagent").
     * Absent = unattributed; the report never guesses.
     */
    "supracortex.agent.role"?: "main" | "subagent";
    /**
     * Labeled-estimate token traffic for this execution (estimator path).
     * Billed tokens come from the provider-usage ledger only.
     */
    "supracortex.tokens.estimated"?: number;
  };
  /** Stable sha256 of the (sorted) tool arguments. NEVER the raw arguments. */
  argumentsHash?: string;
}

/**
 * Lightweight link row correlating `(taskId, incarnationId)` to the existing
 * `metrics/provider-usage.jsonl` ledger via `eventKey`/`messageId`.
 *
 * `ProviderUsageEvent` carries NO task identity (no taskId/incarnationId), which
 * is exactly why this link row exists: the report joins on `eventKey` to recover
 * token/cost totals for a task without duplicating the provider-usage ledger.
 */
export interface ProviderUsageLinkEvent extends ValueEventBase {
  eventType: "provider_usage_link";
  eventKey: string;
  messageId: string;
}

/** A task outcome. An `inferred` outcome is never evidence of verified success. */
export interface TaskOutcomeEvent extends ValueEventBase {
  eventType: "task_outcome";
  source?: "agent" | "inferred";
  supracortex: {
    "supracortex.task.status": OutcomeStatus;
  };
}

export type ValueEvent =
  | ContextInjectionEvent
  | ToolExecutionEvent
  | ProviderUsageLinkEvent
  | TaskOutcomeEvent;

export function isValueEvent(value: unknown): value is ValueEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<ValueEvent>;
  if (event.schemaVersion !== VALUE_EVENTS_SCHEMA_VERSION) return false;
  if (typeof event.eventType !== "string") return false;
  if (typeof event.recordedAt !== "string") return false;
  switch (event.eventType) {
    case "context_injection":
      return typeof event.supracortex?.["supracortex.context.injected"] === "boolean";
    case "tool_execution":
      return typeof event.supracortex?.["supracortex.latency_ms"] === "number";
    case "provider_usage_link":
      return typeof event.eventKey === "string" && typeof event.messageId === "string";
    case "task_outcome":
      return typeof event.supracortex?.["supracortex.task.status"] === "string";
    default:
      return false;
  }
}