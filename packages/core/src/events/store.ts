import type { Config } from "../config.ts";
import type { StorageAdapter } from "../storage/storage-adapter.ts";
import { normalizeEvent } from "./normalizer.ts";
import type { StructuralEvent } from "./types.ts";

const FILE = "events/events.jsonl";
export class EventStore {
  private readonly store: StorageAdapter;
  private readonly config: Config["events"];
  private readonly now: () => number;
  constructor(store: StorageAdapter, config: Config["events"], now = () => Date.now()) { this.store = store; this.config = config; this.now = now; }
  async append(input: Partial<StructuralEvent> & { kind: string }): Promise<StructuralEvent | null> {
    if (!this.config.enabled) return null;
    const event = normalizeEvent({ ...input, at: input.at ?? new Date(this.now()).toISOString() }); if (!event) return null;
    const release = await this.store.acquireLock("events");
    try { await this.store.ensureDir("events"); await this.store.appendJsonl(FILE, [event]); await this.trimLocked(); return event; } catch { return null; } finally { await release(); }
  }
  async list(opts: { since?: string; until?: string; kinds?: string[]; limit?: number } = {}): Promise<StructuralEvent[]> {
    if (!this.config.enabled) return [];
    try { const rows = (await this.store.readJsonl<StructuralEvent>(FILE)).entries; const limit = Math.min(100, Math.max(1, opts.limit ?? 100)); return rows.filter((e) => (!opts.since || e.at >= opts.since) && (!opts.until || e.at <= opts.until) && (!opts.kinds?.length || opts.kinds.includes(e.kind))).slice(-limit); } catch { return []; }
  }
  async detail(id: string): Promise<StructuralEvent | null> { return (await this.list({ limit: 100 })).find((e) => e.id === id) ?? null; }
  async trim(): Promise<void> { if (!this.config.enabled) return; const release = await this.store.acquireLock("events"); try { await this.trimLocked(); } catch {} finally { await release(); } }
  private async trimLocked(): Promise<void> {
    const rows = (await this.store.readJsonl<StructuralEvent>(FILE)).entries;
    const cutoff = this.now() - this.config.maxAgeDays * 86400000;
    let keep = rows.filter((e) => Date.parse(e.at) >= cutoff).slice(-this.config.maxEvents);
    const maxBytes = this.config.maxSizeMb * 1024 * 1024;
    while (keep.length && JSON.stringify(keep).length > maxBytes) keep.shift();
    if (keep.length !== rows.length) await this.store.rewriteJsonl(FILE, keep);
  }
}
