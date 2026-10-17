/**
 * Append-only, bounded, local-only storage for value measurement events.
 *
 * Never written to `metrics/session-YYYY-MM-DD.json` (that file is reserved for
 * the periodic session snapshot owned by `Engine.persistMetrics`, called only
 * from PluginRuntime.dispose — never on a hot path). Aggregation happens ON
 * READ (see report.ts), never on write.
 *
 * Locking: this store has its OWN lock name `"value-metrics"` and is not
 * overloaded onto an existing lock. `"value-metrics"` is a LEAF lock: it may be
 * acquired while `"provider-usage"` (or another lock) is still held — e.g.
 * `recordHostUsage` calls `recordProviderUsageLink` inside the `"provider-usage"`
 * try block, before its `finally` release — and nothing may acquire any other
 * lock while holding `"value-metrics"`. This ordering extends the documented
 * global lock order (`active-tasks` -> `ownership` -> `task-outcomes`) to:
 * `active-tasks` -> `ownership` -> `task-outcomes` -> `value-metrics` (leaf).
 * Preserve this invariant: `"value-metrics"` may be acquired while another lock
 * is held, but while it is held no other lock may be acquired.
 */

import type { StorageAdapter } from "../../storage/storage-adapter.ts";
import type { ValueMeasurementConfig } from "../../config.ts";
import { redactSecrets } from "../../memory/validation.ts";
import { createHash } from "node:crypto";
import { isValueEvent, type ValueEvent } from "./types.ts";

export const VALUE_EVENTS_FILE = "metrics/value-events.jsonl";
export const VALUE_EVENTS_LOCK = "value-metrics";

export interface ValueMetricsStoreOptions {
  storage: StorageAdapter;
  /** Live config lookup so a runtime config change is honored without rebuild. */
  config: () => ValueMeasurementConfig;
  now?: () => number;
}

/** Free-text fields are run through existing secret sanitization before persisting. */
function sanitizeText(value: string, max = 512): string {
  return redactSecrets(value).text.replace(/[\r\n]+/g, " ").slice(0, max);
}

/** Stable sha256 hash of tool arguments. NEVER stores the raw arguments. */
export function hashToolArguments(args: unknown): string {
  const normalized = JSON.stringify(args, (key, value) =>
    value !== undefined && typeof value === "object" && value !== null
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  return createHash("sha256").update(normalized ?? "null").digest("hex");
}

/** Deep-sanitize every string field and confine the row to the value schema. */
export function sanitizeValueEvent(event: ValueEvent): ValueEvent {
  const sanitizeNested = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") out[key] = sanitizeText(value);
      else if (typeof value === "boolean" || typeof value === "number" || value === null) out[key] = value;
      else if (Array.isArray(value)) out[key] = value.map((item) => typeof item === "string" ? sanitizeText(item) : item);
      else if (typeof value === "object") out[key] = sanitizeNested(value as Record<string, unknown>);
    }
    return out;
  };
  const out: Record<string, unknown> = { ...event };
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "string") out[key] = sanitizeText(value);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizeNested(value as Record<string, unknown>);
    }
  }
  if (out.taskId !== undefined) out.taskId = sanitizeText(out.taskId as string, 200);
  if (out.incarnationId !== undefined) out.incarnationId = sanitizeText(out.incarnationId as string, 200);
  if (out.sessionId !== undefined) out.sessionId = sanitizeText(out.sessionId as string, 200);
  return out as unknown as ValueEvent;
}

export class ValueMetricsStore {
  private readonly storage: StorageAdapter;
  private readonly config: () => ValueMeasurementConfig;
  private readonly now: () => number;

  constructor(opts: ValueMetricsStoreOptions) {
    this.storage = opts.storage;
    this.config = opts.config;
    this.now = opts.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.config().enabled;
  }

  /**
   * Best-effort append. Never throws to the host: any measurement failure is
   * swallowed and the host path continues unchanged.
   */
  async append(event: ValueEvent): Promise<ValueEvent | null> {
    try {
      const cfg = this.config();
      if (!cfg.enabled) return null;
      // Free-text fields are sanitized at persist time before anything touches disk.
      const sanitized = sanitizeValueEvent(event);
      const committed = await this.appendLocked(sanitized, cfg);
      return committed ? sanitized : null;
    } catch {
      return null;
    }
  }

  /** Read the bounded tail of the value-events file (aggregation happens on read). */
  async readTail(): Promise<ValueEvent[]> {
    try {
      const tail = await this.storage.readJsonlTail<ValueEvent>(VALUE_EVENTS_FILE, 2000);
      return tail.entries.filter(isValueEvent);
    } catch {
      return [];
    }
  }

  private async appendLocked(
    event: ValueEvent,
    cfg: ValueMeasurementConfig,
  ): Promise<boolean> {
    if (cfg.maxEvents < 1 || cfg.maxAgeDays < 1) return false;
    const release = await this.storage.acquireLock(VALUE_EVENTS_LOCK);
    try {
      await this.storage.ensureDir("metrics");
      const ledger = await this.storage.readJsonl<ValueEvent>(VALUE_EVENTS_FILE);
      const validEvents = ledger.entries.filter(isValueEvent);
      const now = this.now();
      const cutoff = now - cfg.maxAgeDays * 86_400_000;
      const clean: ValueEvent[] = [];
      for (const existing of validEvents) {
        const timestamp = Date.parse(existing.recordedAt);
        if (Number.isFinite(timestamp) && timestamp >= cutoff) clean.push(existing);
      }
      clean.push(event);
      const bounded = clean.slice(-cfg.maxEvents);
      const needsRewrite =
        ledger.corruptLines > 0 ||
        validEvents.length !== ledger.entries.length ||
        bounded.length !== validEvents.length + 1;
      if (needsRewrite) {
        await this.storage.rewriteJsonl(VALUE_EVENTS_FILE, bounded);
      } else {
        await this.storage.appendJsonl(VALUE_EVENTS_FILE, [event]);
      }
      return true;
    } finally {
      await release();
    }
  }
}
