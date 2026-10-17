/**
 * P04 `cortex_submit_result`: the only way a child reports completion.
 * First schema-valid submission wins; later ones are acknowledged but ignored.
 * Invalid submissions return a tool-level validation error so the existing
 * turn can continue within budget (no hidden model call repairs JSON).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseChildResult, type ChildResult } from "./contracts.ts";

const SubmitParams = Type.Object({
  summary: Type.String(),
  findings: Type.Array(
    Type.Object({
      text: Type.String(),
      files: Type.Array(Type.String()),
      evidenceIds: Type.Array(Type.String()),
    }),
  ),
  recommendedActions: Type.Array(Type.String()),
  unresolved: Type.Array(Type.String()),
});

export interface ResultCollector {
  accepted: ChildResult | null;
  submissions: number;
}

export function createResultCollector(): ResultCollector {
  return { accepted: null, submissions: 0 };
}

export function cortexSubmitResultTool(collector: ResultCollector): ToolDefinition<typeof SubmitParams> {
  return {
    name: "cortex_submit_result",
    label: "Submit child result",
    description:
      "Submit your single structured result. First valid submission is final. " +
      "Findings must cite files you actually read. Never invent file contents.",
    parameters: SubmitParams,
    async execute(_id, params) {
      collector.submissions++;
      if (collector.accepted) {
        return {
          content: [{ type: "text", text: "Result already accepted; this submission was ignored." }],
          details: {},
        };
      }
      try {
        collector.accepted = parseChildResult({ schemaVersion: 1, ...params });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Result rejected: ${err instanceof Error ? err.message : "invalid"}. Fix and resubmit within this turn.`,
            },
          ],
          details: {},
        };
      }
      return { content: [{ type: "text", text: "Result accepted." }], details: {} };
    },
  };
}
