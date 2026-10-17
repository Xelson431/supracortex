/**
 * Decision-provider health gate.
 *
 * SupraCortex uses the decision provider (Jev by default) only when it is
 * provably usable: a credential is present AND a real health request has
 * succeeded. Otherwise every caller transparently gets the deterministic path
 * — no turn ever waits on an unverified or dead provider.
 *
 *   disabled     jev.enabled is false
 *   no-key       provider requires a credential and none resolved
 *   checking     first health request in flight (callers use deterministic)
 *   active       last health request succeeded -> decisions are used
 *   unreachable  health request failed; retried after RECHECK_MS
 *
 * A decision call that fails at runtime (timeout, 5xx) demotes the gate to
 * `unreachable` too, so a provider that dies mid-session stops costing latency.
 */
import type { JevCallResult } from "./client.ts";

export type DecisionState = "disabled" | "no-key" | "checking" | "active" | "unreachable";

/** Re-probe interval after a failure. */
export const RECHECK_MS = 5 * 60_000;
/** Health request timeout (independent of the per-turn budget). */
export const PROBE_TIMEOUT_MS = 8_000;

/**
 * Runtime failures that mean "provider is down". A per-turn `timeout` is NOT
 * an outage: turns run on a tight budget (800 ms) that a healthy provider can
 * occasionally miss. Transport errors and non-2xx statuses are.
 */
const OUTAGE_REASONS = new Set(["http-error", "missing-key"]);

export interface HealthSnapshot {
  state: DecisionState;
  reason?: string;
  checkedAt?: string;
  latencyMs?: number;
}

export type Probe = () => Promise<JevCallResult>;

export class DecisionHealth {
  private state: DecisionState = "checking";
  private reason: string | undefined;
  private checkedAtMs = 0;
  private latencyMs: number | undefined;
  private inflight: Promise<void> | null = null;
  private readonly probe: Probe;
  private readonly now: () => number;

  constructor(probe: Probe, now: () => number = Date.now) {
    this.probe = probe;
    this.now = now;
  }

  /** True only when decisions may be used right now. Never blocks. */
  usable(): boolean {
    if (this.state === "active") return true;
    if (this.state === "unreachable" && this.now() - this.checkedAtMs >= RECHECK_MS) this.kick();
    if (this.state === "checking") this.kick();
    return false;
  }

  /** Start (or join) a health request. Resolves when it settles. */
  kick(): Promise<void> {
    if (this.inflight) return this.inflight;
    const started = this.now();
    this.inflight = (async () => {
      try {
        const r = await this.probe();
        this.latencyMs = this.now() - started;
        if (r.ok) this.set("active");
        else this.set("unreachable", `${r.reason}${r.detail ? `: ${r.detail}` : ""}`);
      } catch (err) {
        this.set("unreachable", (err as Error).message || "probe failed");
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Feed a real decision result back: outages demote, successes confirm. */
  observe(result: JevCallResult): void {
    if (result.ok) {
      if (this.state !== "active") this.set("active");
      return;
    }
    if (OUTAGE_REASONS.has(result.reason)) this.set("unreachable", `${result.reason}${result.detail ? `: ${result.detail}` : ""}`);
  }

  snapshot(): HealthSnapshot {
    return {
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.checkedAtMs ? { checkedAt: new Date(this.checkedAtMs).toISOString() } : {}),
      ...(this.latencyMs !== undefined ? { latencyMs: this.latencyMs } : {}),
    };
  }

  private set(state: DecisionState, reason?: string): void {
    this.state = state;
    this.reason = state === "active" ? undefined : reason;
    this.checkedAtMs = this.now();
  }
}
