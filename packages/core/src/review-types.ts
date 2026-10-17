/**
 * Review workflow and safety brief types (Phase 4). No runtime imports; these
 * describe the discriminated review action union and the observed-evidence
 * safety brief shape. Nothing here executes code or shells out.
 */

export type ReviewAction =
  | { type: "list"; statuses?: string[]; limit?: number }
  | { type: "approve"; id: string }
  | { type: "edit"; id: string; content?: string; confidence?: number; tags?: string[] }
  | { type: "dispute"; id: string }
  /** Explicit human-triggered invalidation; never inferred from memory text. */
  | { type: "invalidate"; id: string }
  | { type: "pin"; id: string }
  | { type: "suppress"; id: string }
  | { type: "purge"; id: string }
  /** Explicitly accept the current file state as evidence; never activates. */
  | { type: "refresh-evidence"; id: string };

export interface SafetyBrief {
  generatedAt: string;
  changedFiles: string[];
  dependencyManifestChanges: string[];
  secretRiskFiles: string[];
  unresolvedFailures: Array<{ id: string; content: string }>;
  staleEvidence: Array<{ id: string; content: string }>;
  openTasks: string[];
  /** True only when test.observed/task.completed events exist; never inferred. */
  testsObserved: boolean;
}
