/**
 * Feature gate: the single fast check every hook and tool consults before doing
 * any work. When disabled, this returns immediately with no IO, no indexing, no
 * memory access, and no token consumption.
 *
 * The gate caches the resolved enabled state so the disabled path is O(1). The
 * environment kill switch is re-checked cheaply on every call so a mid-session
 * `SUPRACORTEX_DISABLE=1` takes effect without a config reload.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function envFlag(v: string | undefined): boolean {
  return v != null && TRUTHY.has(v.trim().toLowerCase());
}

export class FeatureGate {
  private enabledByConfig: boolean;
  private reason: string;
  private failed = false;
  private failureMessage = "";

  constructor(enabledByConfig: boolean, reason: string) {
    this.enabledByConfig = enabledByConfig;
    this.reason = reason;
  }

  /** O(1) check used at the top of every hook/tool. */
  get active(): boolean {
    if (this.failed) return false;
    if (envFlag(process.env.SUPRACORTEX_DISABLE)) return false;
    return this.enabledByConfig;
  }

  get statusReason(): string {
    if (this.failed) return `Disabled after initialization failure: ${this.failureMessage}`;
    if (envFlag(process.env.SUPRACORTEX_DISABLE)) {
      return "Disabled by SUPRACORTEX_DISABLE environment variable.";
    }
    return this.reason;
  }

  /** Called when initialization throws: permanently disable for this session. */
  markFailed(message: string): void {
    this.failed = true;
    this.failureMessage = message;
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  /** Update the config-derived enabled state (e.g. after enable/disable command). */
  setEnabled(enabled: boolean, reason: string): void {
    this.enabledByConfig = enabled;
    this.reason = reason;
  }
}
