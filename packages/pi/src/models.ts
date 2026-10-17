/**
 * P02 model selection: explicit precedence, frozen per-job models, no silent
 * fallbacks. Uses Pi's public `resolveCliModel` against a ModelRuntime at
 * child-creation time (P04); this module owns the SupraCortex-side precedence.
 */

import type { ModelRef } from "./config.ts";

export class ModelSelectionError extends Error {}

export type ModelProvenance = "request" | "role" | "agent" | "main";

export interface ResolvedRoleModel {
  ref: ModelRef;
  provenance: ModelProvenance;
}

/**
 * Resolve a role's model. Precedence: request override > roleModels entry >
 * agent-definition model > configured main model. Throws when nothing is
 * configured — the caller must require selection, never silently use Pi's
 * first available model. Provider/model are atomic (never mixed halves).
 */
export function resolveRoleModel(opts: {
  role: string;
  requestModel?: ModelRef;
  roleModels?: Record<string, ModelRef>;
  agentModel?: ModelRef;
  mainModel?: ModelRef;
}): ResolvedRoleModel {
  if (opts.requestModel) return { ref: opts.requestModel, provenance: "request" };
  const roleEntry = opts.roleModels?.[opts.role];
  if (roleEntry) return { ref: roleEntry, provenance: "role" };
  if (opts.agentModel) return { ref: opts.agentModel, provenance: "agent" };
  if (opts.mainModel) return { ref: opts.mainModel, provenance: "main" };
  throw new ModelSelectionError(
    `No model configured for role "${opts.role}" and no main model set. ` +
      `Configure mainModel, roleModels["${opts.role}"], or pass an explicit model.`,
  );
}

/** Parse a "provider/model-id" CLI token into an atomic ModelRef. */
export function parseModelToken(token: string): ModelRef {
  const slash = token.indexOf("/");
  if (slash <= 0 || slash === token.length - 1) {
    throw new ModelSelectionError(
      `Model must be "provider/id", got ${JSON.stringify(token.slice(0, 64))}`,
    );
  }
  return { provider: token.slice(0, slash), id: token.slice(slash + 1) };
}
