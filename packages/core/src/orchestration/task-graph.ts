/** Deterministic task graph construction with enforced conflict ordering. */

import type { PlannedTask, TaskDescriptor } from "../types.ts";
import { detectOverlaps, parallelSafety, scopesOverlap } from "./parallel-safety.ts";

export interface GraphResult {
  tasks: PlannedTask[];
  waves: string[][];
  warnings: string[];
  /** Invalid input is never converted into a plausible executable graph. */
  errors: string[];
}

export function buildTaskGraph(descriptors: TaskDescriptor[], defaultBudget: number): GraphResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const tasks = descriptors.map((d, i) => normalize(d, i, defaultBudget, errors));
  const byId = new Map<string, PlannedTask>();
  for (const task of tasks) {
    if (byId.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
    else byId.set(task.id, task);
  }
  for (const task of tasks) {
    task.dependencies = Array.from(new Set(task.dependencies));
    for (const dependency of task.dependencies) if (!byId.has(dependency)) errors.push(`task ${task.id} depends on unknown task ${dependency}`);
  }
  if (errors.length) return { tasks, waves: [], warnings, errors: Array.from(new Set(errors)).sort() };

  // Read-after-write ordering. If several writers exist, declaration order is
  // deterministic; a later writer is serialised after an earlier writer.
  for (let i = 0; i < tasks.length; i++) {
    const current = tasks[i]!;
    for (let j = 0; j < i; j++) {
      const prior = tasks[j]!;
      if (scopesOverlap(prior.writeScope, current.writeScope)) current.dependencies.push(prior.id);
      if (scopesOverlap(prior.writeScope, current.readScope)) current.dependencies.push(prior.id);
      if (scopesOverlap(current.writeScope, prior.readScope)) prior.dependencies.push(current.id);
    }
    current.dependencies = Array.from(new Set(current.dependencies)).sort();
  }

  const layered = layer(tasks);
  if (layered.cycle.length) {
    errors.push(`dependency cycle: ${layered.cycle.join(" -> ")}`);
    return { tasks, waves: [], warnings, errors };
  }

  for (const task of tasks) {
    const safety = parallelSafety(task, tasks);
    task.parallelSafe = safety.safe;
    task.parallelSafetyReason = safety.reason;
  }
  for (const overlap of detectOverlaps(tasks)) warnings.push(`Tasks ${overlap.a} and ${overlap.b} write overlapping scope ${overlap.files.join(", ")}; serialized by graph.`);
  return { tasks, waves: layered.waves, warnings, errors };
}

function normalize(d: TaskDescriptor, i: number, defaultBudget: number, errors: string[]): PlannedTask {
  const clean = (values: string[] | undefined, label: string): string[] => {
    const result: string[] = [];
    for (const value of values ?? []) {
      const scope = normalizeScope(value);
      if (scope === null) errors.push(`task ${d.id ?? `task-${i + 1}`} has invalid ${label} scope: ${value}`);
      else if (!result.includes(scope)) result.push(scope);
    }
    return result;
  };
  const dependencies = Array.from(new Set((d.dependencies ?? []).map((id) => id.trim()).filter(Boolean)));
  return { id: d.id?.trim() || `task-${i + 1}`, title: d.title, objective: d.objective, dependencies, readScope: clean(d.readScope, "read"), writeScope: clean(d.writeScope, "write"), suggestedAgentRole: d.suggestedAgentRole, contextBudgetTokens: defaultBudget, parallelSafe: false, parallelSafetyReason: "not evaluated", completionCriteria: d.completionCriteria ?? [] };
}

export function normalizeScope(value: string): string | null {
  const path = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").includes("..")) return null;
  return path.replace(/^\.\//, "");
}

function layer(tasks: PlannedTask[]): { waves: string[][]; cycle: string[] } {
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const children = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) for (const dependency of task.dependencies) { children.get(dependency)!.push(task.id); indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1); }
  const waves: string[][] = [];
  let frontier = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id).sort();
  const processed = new Set<string>();
  while (frontier.length) {
    waves.push(frontier);
    const next: string[] = [];
    for (const id of frontier) { processed.add(id); for (const child of children.get(id) ?? []) { indegree.set(child, (indegree.get(child) ?? 0) - 1); if (indegree.get(child) === 0) next.push(child); } }
    frontier = next.sort();
  }
  return { waves, cycle: tasks.filter((task) => !processed.has(task.id)).map((task) => task.id).sort() };
}
