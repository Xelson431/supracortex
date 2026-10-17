/**
 * Per-request Jev enrichment budget (P06).
 *
 * One shared wall-clock deadline across the sequential Jev calls of a single
 * context request. Each call receives the *remaining* milliseconds as its own
 * timeout; calls are skipped entirely once exhausted. Cache hits are fast, so
 * they naturally consume ~0 budget — no separate call counting needed.
 * Time-based (not call-count-based): deterministic and immune to
 * fast-path/slow-path skew.
 */

export class DecisionBudget {
  private readonly startMs: number;
  private readonly totalMs: number;
  private readonly now: () => number;

  constructor(totalMs: number, now: () => number = Date.now) {
    this.now = now;
    this.startMs = now();
    this.totalMs = Math.max(0, totalMs);
  }

  /** Milliseconds left (never negative). */
  remainingMs(): number {
    return Math.max(0, this.startMs + this.totalMs - this.now());
  }

  exhausted(): boolean {
    return this.remainingMs() <= 0;
  }
}
