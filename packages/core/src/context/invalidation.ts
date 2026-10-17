/**
 * Summary/cache invalidation logic driven by source content hashes.
 *
 * A cached summary is valid only if the current source hash matches the hash
 * the summary was derived from. This module provides pure predicates; the
 * engine wires them to the actual index + cache stores.
 */

import type { FileSummary, IndexedFile } from "../types.ts";

export interface InvalidationReport {
  valid: string[];
  stale: string[];
  missing: string[];
}

export function classifySummaries(
  summaries: Record<string, FileSummary>,
  index: Record<string, IndexedFile>,
): InvalidationReport {
  const valid: string[] = [];
  const stale: string[] = [];
  const missing: string[] = [];
  for (const [path, summary] of Object.entries(summaries)) {
    const current = index[path];
    if (!current) {
      missing.push(path);
    } else if (summary.sourceHash === current.hash) {
      valid.push(path);
    } else {
      stale.push(path);
    }
  }
  return { valid, stale, missing };
}
