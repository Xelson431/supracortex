export type StructuralEventKind =
  | "session.started" | "session.ended" | "tool.invoked" | "task.started"
  | "task.completed" | "file.changed" | "test.observed" | "error.observed"
  | "decision.recorded" | "handoff.created" | "resume.consumed";

export interface StructuralEvent {
  id: string;
  kind: StructuralEventKind;
  at: string;
  sessionId?: string;
  paths?: string[];
  toolCategory?: "read" | "write" | "search" | "exec" | "other";
  toolName?: string;
  status?: "success" | "failure" | "partial" | "blocked";
  durationMs?: number;
  testsPassed?: number;
  testsFailed?: number;
  testsSkipped?: number;
  errorClass?: string;
  memoryId?: string;
  note?: string;
}
