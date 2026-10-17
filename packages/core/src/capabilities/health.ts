/**
 * Capability health: per-server success/failure memory with cooldown.
 *
 * Hosts observe real tool executions (OpenCode `tool.execute.after`, Pi tool
 * hooks) and report outcomes here. Servers that fail repeatedly enter a short
 * cooldown during which selectors exclude them with an explicit reason;
 * the first success recovers immediately. State is in-memory per engine
 * process by design: a restart clears stale cooldowns rather than
 * blackholing tools over a transient outage.
 *
 * Only operational metadata is kept (counts, timestamps, short error
 * excerpts). Never credentials, arguments, or result payloads.
 */

export type CapabilityAvailability = "configured" | "connected" | "tested" | "failed";

export interface CapabilityOutcome {
  /** MCP server name the outcome is attributed to. */
  server: string;
  /** Tool name, when the outcome came from a specific tool call. */
  tool?: string;
  ok: boolean;
  /** Short sanitized error excerpt (callers must pre-trim, max ~200 chars). */
  error?: string;
}

export interface ServerHealth {
  availability: CapabilityAvailability;
  consecutiveFailures: number;
  successes: number;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

export interface CapabilityHealthSnapshot {
  servers: Record<string, ServerHealth>;
  testedTools: string[];
}

const DEFAULT_COOLDOWN_AFTER_FAILURES = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_TRACKED_SERVERS = 200;

export class CapabilityHealth {
  private readonly servers = new Map<string, ServerHealth>();
  private readonly testedTools = new Set<string>();
  private readonly cooldownAfterFailures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    opts: { cooldownAfterFailures?: number; cooldownMs?: number; now?: () => number } = {},
  ) {
    this.cooldownAfterFailures = opts.cooldownAfterFailures ?? DEFAULT_COOLDOWN_AFTER_FAILURES;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  private entry(server: string): ServerHealth {
    let entry = this.servers.get(server);
    if (!entry) {
      entry = { availability: "configured", consecutiveFailures: 0, successes: 0 };
      this.servers.set(server, entry);
      while (this.servers.size > MAX_TRACKED_SERVERS) {
        const oldest = this.servers.keys().next().value;
        if (oldest === undefined) break;
        this.servers.delete(oldest);
      }
    }
    return entry;
  }

  /** Host discovery reports a live connection (implies authenticated). */
  markConnected(server: string): void {
    const entry = this.entry(server);
    if (entry.availability !== "failed") entry.availability = "connected";
  }

  recordOutcome(outcome: CapabilityOutcome): void {
    const server = outcome.server.trim().slice(0, 128);
    if (!server) return;
    const entry = this.entry(server);
    if (outcome.tool) {
      this.testedTools.add(`${server}\0${outcome.tool}`.slice(0, 256));
      while (this.testedTools.size > 1000) {
        const oldest = this.testedTools.values().next().value;
        if (oldest === undefined) break;
        this.testedTools.delete(oldest);
      }
    }
    if (outcome.ok) {
      entry.consecutiveFailures = 0;
      entry.successes++;
      entry.lastOkAt = new Date(this.now()).toISOString();
      if (entry.availability === "failed") entry.availability = "tested";
      else if (entry.availability === "configured") entry.availability = "tested";
    } else {
      entry.consecutiveFailures++;
      entry.lastErrorAt = new Date(this.now()).toISOString();
      if (outcome.error) entry.lastError = outcome.error.slice(0, 200);
      if (entry.consecutiveFailures >= this.cooldownAfterFailures) {
        entry.availability = "failed";
      }
    }
  }

  /** True while a repeatedly-failing server serves its cooldown. */
  isCoolingDown(server: string): boolean {
    const entry = this.servers.get(server);
    if (!entry || entry.availability !== "failed") return false;
    if (!entry.lastErrorAt) return true;
    return this.now() - Date.parse(entry.lastErrorAt) < this.cooldownMs;
  }

  snapshot(): CapabilityHealthSnapshot {
    const servers: Record<string, ServerHealth> = {};
    for (const [name, entry] of this.servers) servers[name] = { ...entry };
    return { servers, testedTools: Array.from(this.testedTools).map((key) => key.replace("\0", ":")) };
  }
}
