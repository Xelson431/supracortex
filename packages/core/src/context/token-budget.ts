/**
 * Token budget accounting for context packet construction.
 *
 * Measurement contract: `tryConsume`/`forceConsume` take numeric charges as
 * before. `tryConsumeText`/`forceConsumeText` measure real text via
 * `measureTokens` (tiktoken primary) and tag the heuristic fallback path with
 * `estimated: true` — never presented as measured.
 */

import type { ContextBudget } from "../types.ts";
import { measureTokens } from "../metrics/token-estimator.ts";

export class TokenBudget {
  private readonly max: number;
  private used = 0;
  private estimatedFlag = false;

  constructor(maxTokens: number) {
    this.max = Math.max(0, maxTokens);
  }

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  get usedTokens(): number {
    return this.used;
  }

  /** True once any heuristic-estimate charge has passed through this budget. */
  get estimated(): boolean {
    return this.estimatedFlag;
  }

  /** Tag this budget's charges as estimated (heuristic path, not measured). */
  markEstimated(): void {
    this.estimatedFlag = true;
  }

  /** Attempt to reserve `n` tokens. Returns true if it fit. */
  tryConsume(n: number): boolean {
    if (n <= 0) return true;
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }

  /** Force-consume even if it exceeds (used for mandatory items). */
  forceConsume(n: number): void {
    this.used += Math.max(0, n);
  }

  /**
   * Measure `text` via `measureTokens` (tiktoken primary) and try to consume
   * the measured count. Returns the charged tokens. When the estimator falls
   * back to the chars/4 heuristic the budget is tagged `estimated: true`.
   */
  tryConsumeText(text: string, modelHint?: string): { charged: number; estimated: boolean; fitted: boolean } {
    const m = measureTokens(text, modelHint);
    if (m.estimated) this.markEstimated();
    return { charged: m.tokens, estimated: m.estimated, fitted: this.tryConsume(m.tokens) };
  }

  /** Measured variant of `forceConsume` for mandatory text. */
  forceConsumeText(text: string, modelHint?: string): { charged: number; estimated: boolean } {
    const m = measureTokens(text, modelHint);
    if (m.estimated) this.markEstimated();
    this.forceConsume(m.tokens);
    return { charged: m.tokens, estimated: m.estimated };
  }

  snapshot(): ContextBudget & { estimated: boolean } {
    return {
      maxTokens: this.max,
      usedTokens: this.used,
      remainingTokens: this.remaining,
      estimated: this.estimatedFlag,
    };
  }
}
