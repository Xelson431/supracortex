/**
 * Insertion-order-bounded Set helper.
 *
 * The plugin process is long-lived and tracks session ids in Sets that only
 * shrink on lifecycle events (e.g. session.deleted). If such an event is ever
 * missed (crash, dropped event, forced kill), the Set would grow without bound.
 * `boundedAdd` caps a Set at `max` entries by evicting the oldest (Sets preserve
 * insertion order, so the first key is the oldest) — guaranteeing O(max) memory
 * regardless of how many sessions a process sees over its lifetime.
 */

export function boundedAdd(set: Set<string>, value: string, max: number): void {
  if (max <= 0) return;
  if (set.has(value)) return;
  while (set.size >= max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
  set.add(value);
}

/** Max tracked sessions per plugin process (bounds worst-case memory). */
export const MAX_TRACKED_SESSIONS = 2000;
