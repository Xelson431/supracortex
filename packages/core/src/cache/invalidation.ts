/**
 * Cache invalidation helpers. Thin re-exports plus a combined validation pass
 * that reports which cached summaries are usable given the current index.
 */

import type { FileSummary, IndexedFile } from "../types.ts";
import { classifySummaries, type InvalidationReport } from "../context/invalidation.ts";

export function validateCache(
  summaries: Record<string, FileSummary>,
  index: Record<string, IndexedFile>,
): InvalidationReport {
  return classifySummaries(summaries, index);
}

export type { InvalidationReport };
