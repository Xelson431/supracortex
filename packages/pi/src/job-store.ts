/**
 * P05 job persistence: confined, atomic, validated. Layout under an existing
 * project storage root:
 *   cli/runs/<runId>/jobs/<jobId>.json
 *   cli/runs/<runId>/results/<jobId>.json
 * IDs are UUIDs generated internally; filenames are validated so model input
 * can never escape the store. Malformed records are quarantined, never loaded.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobRecordSchema, parseChildResult, type ChildResult, type JobRecord } from "./contracts.ts";

export function newJobId(): string {
  return randomUUID();
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function assertSafeName(name: string, what: string): void {
  if (!SAFE_NAME.test(name)) throw new Error(`unsafe ${what} name: ${name.slice(0, 64)}`);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  // Unique tmp per writer: concurrent saves of the same record (admission +
  // start/finish racing on one job) must never share a tmp name.
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

export class JobStore {
  readonly root: string;
  private constructor(root: string) {
    this.root = root;
  }

  /** Create + ensure cli/ subtree is git-ignored (our artifacts only). */
  static async create(storageRoot: string): Promise<JobStore> {
    const root = join(storageRoot, "cli");
    await mkdir(join(root, "runs"), { recursive: true });
    const ignorePath = join(root, ".gitignore");
    try {
      await readFile(ignorePath, "utf8");
    } catch {
      await writeFile(ignorePath, "*\n", "utf8");
    }
    return new JobStore(root);
  }

  private jobPath(runId: string, jobId: string): string {
    assertSafeName(runId, "run");
    assertSafeName(jobId, "job");
    return join(this.root, "runs", runId, "jobs", `${jobId}.json`);
  }

  private resultPath(runId: string, jobId: string): string {
    assertSafeName(runId, "run");
    assertSafeName(jobId, "job");
    return join(this.root, "runs", runId, "results", `${jobId}.json`);
  }

  async saveJob(record: JobRecord, runId: string): Promise<void> {
    await atomicWriteJson(this.jobPath(runId, record.id), record);
  }

  /** Load + validate; quarantine malformed files as .corrupt (never throw data away silently). */
  async loadJob(runId: string, jobId: string): Promise<JobRecord | null> {
    const path = this.jobPath(runId, jobId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      await rename(path, `${path}.corrupt`).catch(() => undefined);
      return null;
    }
    const parsed = JobRecordSchema.safeParse(data);
    if (!parsed.success) {
      await rename(path, `${path}.corrupt`).catch(() => undefined);
      return null;
    }
    return parsed.data;
  }

  async saveResult(runId: string, jobId: string, result: ChildResult): Promise<string> {
    const path = this.resultPath(runId, jobId);
    await atomicWriteJson(path, result);
    return path;
  }

  /** Directory for one run's jobs/results/usage (created on demand). */
  runDir(runId: string): string {
    assertSafeName(runId, "run");
    return join(this.root, "runs", runId);
  }

  /** List run ids present in the store (safe names only). */
  async listRuns(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(join(this.root, "runs"));
    } catch {
      return [];
    }
    return entries.filter((e) => SAFE_NAME.test(e)).sort();
  }

  /** List job records of one run; malformed files are quarantined on load. */
  async listJobs(runId: string): Promise<JobRecord[]> {
    assertSafeName(runId, "run");
    let entries: string[];
    try {
      entries = await readdir(join(this.root, "runs", runId, "jobs"));
    } catch {
      return [];
    }
    const out: JobRecord[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.loadJob(runId, entry.slice(0, -5));
      if (record) out.push(record);
    }
    return out;
  }

  async loadResult(runId: string, jobId: string): Promise<ChildResult | null> {
    const path = this.resultPath(runId, jobId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      return parseChildResult(JSON.parse(raw) as unknown);
    } catch {
      await rename(path, `${path}.corrupt`).catch(() => undefined);
      return null;
    }
  }
}
