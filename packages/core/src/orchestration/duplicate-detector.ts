/**
 * Duplicate detection for tasks and reads.
 *
 * - Duplicate task objectives: near-identical objective text or identical
 *   read/write scope pairs suggest redundant delegation.
 * - Duplicate reads: the same file assigned to be read by many tasks can be
 *   consolidated (read once, share context).
 */

import type { PlannedTask } from "../types.ts";

export interface DuplicateGroup {
  taskIds: string[];
  reason: string;
}

export function detectDuplicateTasks(tasks: PlannedTask[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < tasks.length; i++) {
    if (seen.has(i)) continue;
    const a = tasks[i]!;
    const dupIds = [a.id];
    for (let j = i + 1; j < tasks.length; j++) {
      if (seen.has(j)) continue;
      const b = tasks[j]!;
      const sim = objectiveSimilarity(a.objective, b.objective);
      const sameScope =
        setEqual(a.writeScope, b.writeScope) && setEqual(a.readScope, b.readScope);
      if (sim >= 0.85 || (sameScope && sim >= 0.5)) {
        dupIds.push(b.id);
        seen.add(j);
      }
    }
    if (dupIds.length > 1) {
      seen.add(i);
      groups.push({
        taskIds: dupIds,
        reason: "near-identical objective/scope; likely duplicate work",
      });
    }
  }
  return groups;
}

export interface DuplicateReadReport {
  path: string;
  taskIds: string[];
}

export function detectDuplicateReads(
  tasks: PlannedTask[],
  threshold = 2,
): DuplicateReadReport[] {
  const byFile = new Map<string, string[]>();
  for (const t of tasks) {
    for (const r of t.readScope) {
      const list = byFile.get(r) ?? [];
      list.push(t.id);
      byFile.set(r, list);
    }
  }
  const reports: DuplicateReadReport[] = [];
  for (const [path, ids] of byFile) {
    if (ids.length >= threshold) reports.push({ path, taskIds: ids });
  }
  return reports;
}

function objectiveSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3);
}

function setEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}
