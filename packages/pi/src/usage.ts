/**
 * P08 usage ledger: additive, id-keyed, restart-safe.
 *
 * Rules (established against Pi 0.87.1 behavior, see VALIDATION_LOG P08):
 * - Only `message_end` (authoritative final) feeds accounting. Streaming
 *   `message_update` snapshots are cumulative UI state — summing them as
 *   deltas double-counts. Each assistant `message_end` is one billed request.
 * - `responseId` is NOT unique per request (observed constant
 *   "omniroute-keepAlive" across messages). Identity is caller-supplied:
 *   session entry ids for main sessions, per-session ordinals for children.
 * - Costs come only from provider-reported `usage.cost`. Absent cost objects
 *   stay unknown (never fabricated, never priced from a catalog silently).
 * - Aborts/timeouts with no attributable usage record zeros + complete:false.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { UsageRecordSchema, type UsageRecord } from "./contracts.ts";

export interface PiUsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown } | unknown;
}

export type UsageSource = UsageRecord["source"];

export interface ReconcileInput {
  runId: string;
  sessionId: string;
  /** Stable id: session entry id (main) or per-session ordinal key (child). */
  requestKey: string;
  source: Exclude<UsageSource, "jev">;
  provider: string;
  modelId: string;
  usage: PiUsageLike | null;
  /** False when the attempt produced no attributable usage (abort/timeout). */
  complete: boolean;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function toUsageRecord(input: ReconcileInput): UsageRecord {
  const costTotal = (input.usage?.cost as { total?: unknown } | undefined)?.total;
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    requestId: input.requestKey.slice(0, 256),
    source: input.source,
    model: { provider: input.provider.slice(0, 128) || "unknown", id: input.modelId.slice(0, 256) || "unknown" },
    input: num(input.usage?.input),
    output: num(input.usage?.output),
    cacheRead: num(input.usage?.cacheRead),
    cacheWrite: num(input.usage?.cacheWrite),
    ...(typeof costTotal === "number" && Number.isFinite(costTotal) && costTotal >= 0
      ? { cost: costTotal, costSource: "provider" as const }
      : {}),
    complete: input.complete,
  };
}

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of provider-reported costs only (absent costs excluded, not zeroed). */
  providerCost: number;
  pricedRequests: number;
  incomplete: number;
}

export function emptyTotals(): UsageTotals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, providerCost: 0, pricedRequests: 0, incomplete: 0 };
}

export class UsageLedger {
  readonly runId: string;
  private readonly file: string;
  private readonly seen: Set<string>;
  private records: UsageRecord[];

  private constructor(runId: string, file: string, seen: Set<string>, records: UsageRecord[]) {
    this.runId = runId;
    this.file = file;
    this.seen = seen;
    this.records = records;
  }

  private chain: Promise<void> = Promise.resolve();

  static async open(runId: string, dir: string): Promise<{ ledger: UsageLedger; skipped: number }> {
    await mkdir(dir, { recursive: true });
    const file = join(dir, "usage.jsonl");
    const seen = new Set<string>();
    const records: UsageRecord[] = [];
    let skipped = 0;
    let raw = "";
    try {
      raw = await readFile(file, "utf8");
    } catch {
      raw = "";
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = UsageRecordSchema.parse(JSON.parse(line) as unknown);
        const key = `${parsed.sessionId}\0${parsed.requestId}`;
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        seen.add(key);
        records.push(parsed);
      } catch {
        skipped++;
      }
    }
    return { ledger: new UsageLedger(runId, file, seen, records), skipped };
  }

  /**
   * Record once per (sessionId, requestKey). Returns the record, or null when
   * already reconciled (exactly-once across restarts: keys persist in JSONL).
   */
  async record(input: ReconcileInput): Promise<UsageRecord | null> {
    const record = toUsageRecord(input);
    const key = `${record.sessionId}\0${record.requestId}`;
    return this.append(key, record);
  }

  private append(key: string, record: UsageRecord): Promise<UsageRecord | null> {
    const next = this.chain.then(async () => {
      if (this.seen.has(key)) return null;
      this.seen.add(key);
      this.records.push(record);
      await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
      return record;
    });
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  totals(source?: UsageSource): UsageTotals {
    const out = emptyTotals();
    for (const r of this.records) {
      if (source && r.source !== source) continue;
      out.requests++;
      if (!r.complete) {
        out.incomplete++;
        continue;
      }
      out.input += r.input;
      out.output += r.output;
      out.cacheRead += r.cacheRead ?? 0;
      out.cacheWrite += r.cacheWrite ?? 0;
      if (r.cost !== undefined && r.costSource === "provider") {
        out.providerCost += r.cost;
        out.pricedRequests++;
      }
    }
    return out;
  }

  count(): number {
    return this.records.length;
  }
}
