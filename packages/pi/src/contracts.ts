/**
 * P04 transport-neutral contracts. Runtime validation (zod) — TypeScript types
 * alone are insufficient for model-generated and persisted input.
 */

import { z } from "zod";

export const ModelRefSchema = z.object({
  provider: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
});
export type ContractModelRef = z.infer<typeof ModelRefSchema>;

const FindingSchema = z.object({
  text: z.string().min(1).max(2000),
  files: z.array(z.string().min(1).max(512)).max(20),
  evidenceIds: z.array(z.string().min(1).max(128)).max(20),
});

export const ChildResultSchema = z.object({
  schemaVersion: z.literal(1),
  summary: z.string().min(1).max(4000),
  findings: z.array(FindingSchema).max(20),
  recommendedActions: z.array(z.string().min(1).max(500)).max(20),
  unresolved: z.array(z.string().min(1).max(500)).max(20),
});
export type ChildResult = z.infer<typeof ChildResultSchema>;

export const CHILD_RESULT_JSON_MAX_BYTES = 32 * 1024;

export function parseChildResult(raw: unknown): ChildResult {
  const json = JSON.stringify(raw ?? null);
  if (json.length > CHILD_RESULT_JSON_MAX_BYTES) {
    throw new Error(`child result exceeds ${CHILD_RESULT_JSON_MAX_BYTES} bytes`);
  }
  const parsed = ChildResultSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `invalid child result ${first ? first.path.join(".") : "(root)"}: ${first?.message ?? "schema mismatch"}`,
    );
  }
  return parsed.data;
}

export const JobStateSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const JobRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  runId: z.string().min(1).max(128),
  parentSessionId: z.string().min(1).max(256),
  taskHash: z.string().min(1).max(128),
  role: z.string().min(1).max(64),
  model: ModelRefSchema,
  state: JobStateSchema,
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  resultPath: z.string().optional(),
  failureCode: z.string().max(64).optional(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const DelegateRequestSchema = z.object({
  role: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  task: z.string().min(1).max(8000),
  hintFiles: z.array(z.string().min(1).max(512)).max(50).optional(),
  model: ModelRefSchema.optional(),
  mode: z.enum(["wait", "background"]),
  inheritance: z
    .object({
      kind: z.literal("handoff"),
      text: z.string().min(1).max(8000),
      evidenceIds: z.array(z.string().min(1).max(128)).max(20),
    })
    .optional(),
});
export type DelegateRequest = z.infer<typeof DelegateRequestSchema>;

export const UsageRecordSchema = z.object({
  runId: z.string().min(1).max(128),
  jobId: z.string().uuid().optional(),
  sessionId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  source: z.enum(["main", "child", "jev", "compaction"]),
  model: ModelRefSchema,
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cacheRead: z.number().int().min(0).optional(),
  cacheWrite: z.number().int().min(0).optional(),
  cost: z.number().min(0).optional(),
  costSource: z.enum(["provider", "catalog-estimate"]).optional(),
  complete: z.boolean(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
