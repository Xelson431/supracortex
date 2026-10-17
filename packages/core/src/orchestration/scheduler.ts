/**
 * Scheduler: turns a task graph + duplicate analysis into a concrete execution
 * plan (waves capped by max concurrency). This RECOMMENDS execution order; it
 * does not run agents. The host owns actual scheduling and execution.
 */

import type { PlannedTask, TaskDescriptor, TaskPlan } from "../types.ts";
import { buildTaskGraph } from "./task-graph.ts";
import { detectDuplicateTasks, detectDuplicateReads } from "./duplicate-detector.ts";
import { planOwnership } from "./ownership.ts";

export interface ScheduleOptions {
  maxConcurrentTasks: number;
  defaultBudgetTokens: number;
}

export function planTasks(
  descriptors: TaskDescriptor[],
  opts: ScheduleOptions,
): TaskPlan {
  const graph = buildTaskGraph(descriptors, opts.defaultBudgetTokens);
  const warnings = [...graph.warnings];
  if (graph.errors.length) {
    return { tasks: graph.tasks, waves: [], duplicateGroups: [], warnings: [...warnings, ...graph.errors.map((error) => `Invalid task graph: ${error}`)] };
  }

  const dupTasks = detectDuplicateTasks(graph.tasks);
  const duplicateGroups = dupTasks.map((d) => d.taskIds);
  for (const d of dupTasks) {
    warnings.push(`Duplicate work: tasks [${d.taskIds.join(", ")}] — ${d.reason}.`);
  }

  const dupReads = detectDuplicateReads(graph.tasks);
  for (const r of dupReads) {
    warnings.push(
      `File ${r.path} is read by ${r.taskIds.length} tasks [${r.taskIds.join(", ")}]; consider sharing one context packet.`,
    );
  }

  // Cap each wave by max concurrency, splitting oversized waves.
  const cappedWaves = capWaves(graph.waves, opts.maxConcurrentTasks);

  // Ownership sanity check per wave.
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  for (const wave of cappedWaves) {
    const plan = planOwnership(
      wave.map((id) => ({ id, writeScope: byId.get(id)?.writeScope ?? [] })),
    );
    for (const c of plan.conflicts) {
      warnings.push(
        `Wave conflict on ${c.path} between [${c.taskIds.join(", ")}]; serialize these tasks.`,
      );
    }
  }

  return {
    tasks: graph.tasks,
    waves: cappedWaves,
    duplicateGroups,
    warnings,
  };
}

function capWaves(waves: string[][], maxConcurrent: number): string[][] {
  if (maxConcurrent <= 0) return waves;
  const out: string[][] = [];
  for (const wave of waves) {
    for (let i = 0; i < wave.length; i += maxConcurrent) {
      out.push(wave.slice(i, i + maxConcurrent));
    }
  }
  return out;
}

export type { PlannedTask };
