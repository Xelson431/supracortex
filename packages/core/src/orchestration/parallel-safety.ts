/**
 * Parallel-safety analysis. A task is parallel-safe if its write scope does not
 * overlap the write scope of any other task in the candidate set, and it has no
 * unmet dependencies within the same wave.
 */

import type { PlannedTask } from "../types.ts";

export interface SafetyResult {
  safe: boolean;
  reason: string;
}

export interface OverlapReport {
  a: string;
  b: string;
  files: string[];
}

/**
 * Determine whether a single task can safely run alongside the others. Overlap
 * on write scope, or a write on one side that another reads, makes it unsafe.
 */
export function parallelSafety(task: PlannedTask, all: PlannedTask[]): SafetyResult {
  const others = all.filter((t) => t.id !== task.id);
  const myWrites = task.writeScope;
  const myReads = task.readScope;

  for (const other of others) {
    // Write/write overlap.
    const ww = overlappingScopes(other.writeScope, myWrites);
    if (ww.length) {
      return {
        safe: false,
        reason: `overlapping write scope with ${other.id} on ${ww.join(", ")}`,
      };
    }
    // Write/read overlap (other writes something I read -> ordering dependency).
    const wr = overlappingScopes(other.writeScope, myReads);
    if (wr.length) {
      return {
        safe: false,
        reason: `reads ${wr.join(", ")} which ${other.id} writes (ordering dependency)`,
      };
    }
  }

  if (task.dependencies.length) {
    return {
      safe: false,
      reason: `has dependencies [${task.dependencies.join(", ")}]; safe only after they complete`,
    };
  }

  return { safe: true, reason: "no write conflicts and no dependencies" };
}

/** All pairwise write-scope overlaps across the task set. */
export function detectOverlaps(tasks: PlannedTask[]): OverlapReport[] {
  const reports: OverlapReport[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      const files = overlappingScopes(a.writeScope, b.writeScope);
      if (files.length) reports.push({ a: a.id, b: b.id, files });
    }
  }
  return reports;
}

export function scopesOverlap(left: string[], right: string[]): boolean { return overlappingScopes(left, right).length > 0; }
function overlappingScopes(left: string[], right: string[]): string[] {
  const result: string[] = [];
  for (const a of left) for (const b of right) if (scopeOverlap(a, b)) result.push(a === b ? a : `${a} <-> ${b}`);
  return Array.from(new Set(result));
}
function scopeOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes("*") || b.includes("*")) return a === "**" || b === "**" || a.replace(/\*\*/g, "").replace(/\*/g, "") === b.replace(/\*\*/g, "").replace(/\*/g, "");
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
