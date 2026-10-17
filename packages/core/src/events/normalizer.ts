import { randomUUID } from "node:crypto";
import { redactSecrets } from "../memory/validation.ts";
import type { StructuralEvent, StructuralEventKind } from "./types.ts";

const kinds = new Set<StructuralEventKind>([
  "session.started", "session.ended", "tool.invoked", "task.started", "task.completed",
  "file.changed", "test.observed", "error.observed", "decision.recorded", "handoff.created", "resume.consumed",
]);
const clean = (s: string, max: number) => redactSecrets(s.slice(0, max)).text;

export function normalizeEvent(input: Partial<StructuralEvent> & { kind: string }): StructuralEvent | null {
  if (!kinds.has(input.kind as StructuralEventKind)) return null;
  const out: StructuralEvent = { id: clean(String(input.id ?? randomUUID()), 120), kind: input.kind as StructuralEventKind, at: clean(String(input.at ?? new Date().toISOString()), 100) };
  if (input.sessionId) out.sessionId = clean(input.sessionId, 120);
  if (input.paths) out.paths = [...new Set(input.paths.map((p) => clean(p.replaceAll("\\", "/"), 500)).filter((p) => p && !p.startsWith("/")))].slice(0, 100);
  if (input.toolCategory) out.toolCategory = input.toolCategory;
  if (input.toolName) out.toolName = clean(input.toolName, 120);
  if (input.status) out.status = input.status;
  for (const key of ["durationMs", "testsPassed", "testsFailed", "testsSkipped"] as const) {
    const value = input[key]; if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.min(key === "durationMs" ? 86_400_000 : 1_000_000, Math.max(0, Math.floor(value)));
  }
  if (input.errorClass) out.errorClass = clean(input.errorClass, 200);
  if (input.memoryId) out.memoryId = clean(input.memoryId, 120);
  if (input.note) out.note = clean(input.note, 500);
  return out;
}
