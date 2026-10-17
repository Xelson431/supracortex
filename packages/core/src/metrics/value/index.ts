/**
 * Value measurement (correlational only). Opt-in, local-only. See report.ts for
 * the aggregation + refusal semantics and store.ts for bounded storage.
 */
export {
  VALUE_EVENTS_FILE,
  VALUE_EVENTS_LOCK,
  ValueMetricsStore,
  hashToolArguments,
  sanitizeValueEvent,
} from "./store.ts";
export type { ValueMetricsStoreOptions } from "./store.ts";
export {
  buildValueReport,
  formatValueTokenLine,
  MIN_SEGMENT_SAMPLE,
  VALUE_CORRELATION_LABEL,
} from "./report.ts";
export type {
  ValueReport,
  ValueSegmentStat,
  OutcomeCounts,
} from "./report.ts";
export {
  VALUE_EVENTS_SCHEMA_VERSION,
  isValueEvent,
} from "./types.ts";
export type {
  ValueEvent,
  ValueEventType,
  ContextInjectionEvent,
  ToolExecutionEvent,
  ProviderUsageLinkEvent,
  TaskOutcomeEvent,
} from "./types.ts";