/**
 * MCP server/tool selection (core, pure).
 *
 * Records only operational metadata (never credentials) and recommends the
 * minimal set of MCP tools per task. The adapter discovers servers via the
 * OpenCode client; this module scores and applies agent-role policy.
 *
 * Honesty note: recommending fewer MCP tools only reduces model *schema* context
 * if the runtime actually excludes unused tool schemas from the request. This
 * module reports estimated schema overhead separately from call/result savings.
 */

import type {
  McpExclusion,
  McpServerMetadata,
  McpToolRecommendation,
} from "../types.ts";

/** Default per-agent MCP capability profiles (narrow by default). */
export const AGENT_MCP_PROFILE: Record<string, { allow: "all" | "none" | "read-only" }> = {
  explorer: { allow: "read-only" },
  librarian: { allow: "read-only" },
  oracle: { allow: "none" },
  fixer: { allow: "read-only" },
  designer: { allow: "read-only" },
  observer: { allow: "read-only" },
  orchestrator: { allow: "all" },
};

export interface McpSelectInput {
  servers: McpServerMetadata[];
  queryTokens: string[];
  targetAgent?: string;
  /** When true, mutating tools require explicit approval regardless of role. */
  requireApprovalForMutating?: boolean;
  maxTools?: number;
  /**
   * Live health (see capabilities/health.ts). Servers in failure cooldown are
   * excluded with an explicit reason instead of being recommended again.
   */
  health?: { isCoolingDown(server: string): boolean };
}

export interface McpSelectResult {
  recommended: McpToolRecommendation[];
  excludedServers: McpExclusion[];
  serversConsidered: number;
  serversSelected: number;
  toolsSelected: number;
}

export function selectMcpTools(input: McpSelectInput): McpSelectResult {
  const max = input.maxTools ?? 8;
  const profile = input.targetAgent ? AGENT_MCP_PROFILE[input.targetAgent] : undefined;
  const allow = profile?.allow ?? "all";

  const recommended: McpToolRecommendation[] = [];
  const excludedServers: McpExclusion[] = [];
  const selectedServers = new Set<string>();

  if (allow === "none") {
    for (const s of input.servers) {
      excludedServers.push({
        server: s.name,
        reason: `agent "${input.targetAgent}" profile allows no MCP access`,
      });
    }
    return {
      recommended: [],
      excludedServers,
      serversConsidered: input.servers.length,
      serversSelected: 0,
      toolsSelected: 0,
    };
  }

  // Rank tools across enabled servers.
  const candidates: Array<{
    server: McpServerMetadata;
    tool: McpServerMetadata["tools"][number];
    score: number;
  }> = [];

  for (const server of input.servers) {
    if (!server.enabled) {
      excludedServers.push({ server: server.name, reason: "server disabled" });
      continue;
    }
    if (input.health?.isCoolingDown(server.name)) {
      excludedServers.push({
        server: server.name,
        reason: "cooling down after repeated failures (transient; retries resume automatically)",
      });
      continue;
    }
    for (const tool of server.tools) {
      if (allow === "read-only" && tool.mutating) continue;
      const score = scoreTool(server, tool, input.queryTokens);
      candidates.push({ server, tool, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const c of candidates) {
    if (recommended.length >= max) break;
    if (c.score < 0.15) continue;
    selectedServers.add(c.server.name);
    const requiresApproval =
      c.tool.mutating && (input.requireApprovalForMutating ?? true);
    const rec: McpToolRecommendation = {
      server: c.server.name,
      tool: c.tool.name,
      purpose: buildPurpose(c.tool, input.queryTokens),
      mutating: c.tool.mutating,
      requiresApproval,
    };
    if (c.tool.estimatedSchemaTokens != null) {
      rec.estimatedSchemaTokens = c.tool.estimatedSchemaTokens;
    }
    recommended.push(rec);
  }

  // Servers with no selected tool are excluded (with reason).
  for (const server of input.servers) {
    if (!server.enabled) continue;
    if (!selectedServers.has(server.name)) {
      excludedServers.push({
        server: server.name,
        reason: "no tool matched the task within budget",
      });
    }
  }

  return {
    recommended,
    excludedServers,
    serversConsidered: input.servers.length,
    serversSelected: selectedServers.size,
    toolsSelected: recommended.length,
  };
}

function scoreTool(
  server: McpServerMetadata,
  tool: McpServerMetadata["tools"][number],
  queryTokens: string[],
): number {
  const hay = `${server.name} ${tool.name} ${tool.description ?? ""}`.toLowerCase();
  let hits = 0;
  for (const t of queryTokens) if (hay.includes(t)) hits++;
  let score = queryTokens.length ? hits / queryTokens.length : 0;
  if (tool.sensitive) score -= 0.1;
  // Prefer servers the host has actually seen live over config-only entries.
  if (server.availability === "connected" || server.availability === "tested") score += 0.1;
  if (server.connected) score += 0.05;
  return score;
}

function buildPurpose(
  tool: McpServerMetadata["tools"][number],
  queryTokens: string[],
): string {
  const desc = tool.description?.slice(0, 80) ?? tool.name;
  const matched = queryTokens.filter((t) => desc.toLowerCase().includes(t)).slice(0, 2);
  return matched.length ? `${desc} (matches ${matched.join(", ")})` : desc;
}
