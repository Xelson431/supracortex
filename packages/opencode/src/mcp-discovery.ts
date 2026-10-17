/**
 * MCP server/tool discovery for the OpenCode adapter.
 *
 * Uses the OpenCode client's `mcp.status()` endpoint when available. Records
 * ONLY operational metadata: server name, type, enabled/connected state, auth
 * requirement, tool names/descriptions, and a mutating/sensitive classification.
 *
 * It NEVER records credentials, tokens, headers, or environment values. If the
 * client or endpoint is unavailable, it returns an empty list (fail open).
 */

import type {
  McpServerMetadata,
  McpServerType,
  McpToolMetadata,
} from "@local/supracortex-core";
import { estimateTokens } from "@local/supracortex-core";

/** Heuristic classification of tool names as mutating or sensitive. */
const MUTATING_HINTS = [
  "write", "create", "update", "delete", "remove", "insert", "drop", "put",
  "post", "patch", "deploy", "publish", "send", "exec", "run", "apply", "set",
  "add", "edit", "move", "rename", "commit", "push", "merge",
];
const SENSITIVE_HINTS = [
  "prod", "production", "secret", "key", "token", "password", "credential",
  "payment", "billing", "auth", "delete", "drop", "database",
];

export function classifyTool(name: string, description?: string): {
  mutating: boolean;
  sensitive: boolean;
} {
  const hay = `${name} ${description ?? ""}`.toLowerCase();
  const mutating = MUTATING_HINTS.some((h) => hay.includes(h));
  const sensitive = SENSITIVE_HINTS.some((h) => hay.includes(h));
  return { mutating, sensitive };
}

interface RawMcpTool {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
}

interface RawMcpServer {
  name?: string;
  type?: string;
  enabled?: boolean;
  connected?: boolean;
  status?: string;
  auth?: unknown;
  requiresAuth?: boolean;
  tools?: RawMcpTool[];
}

export function normalizeServers(raw: unknown): McpServerMetadata[] {
  const servers: McpServerMetadata[] = [];
  const list = extractServerList(raw);
  for (const s of list) {
    const type: McpServerType = s.type === "remote" ? "remote" : "local";
    const tools: McpToolMetadata[] = (s.tools ?? []).map((t) => {
      const cls = classifyTool(t.name ?? "", t.description);
      const tool: McpToolMetadata = {
        name: t.name ?? "unknown",
        mutating: cls.mutating,
        sensitive: cls.sensitive,
      };
      if (t.description) tool.description = t.description.slice(0, 200);
      const schema = t.inputSchema ?? t.parameters;
      if (schema) tool.estimatedSchemaTokens = estimateTokens(JSON.stringify(schema));
      return tool;
    });
    servers.push({
      name: s.name ?? "unknown",
      type,
      enabled: s.enabled !== false && s.status !== "disabled",
      connected: s.connected ?? s.status === "connected",
      requiresAuth: s.requiresAuth ?? Boolean(s.auth),
      tools,
      availability:
        s.status === "connected"
          ? "connected"
          : s.status === "failed" || s.status === "needs-auth" || s.status === "needs_auth"
            ? "failed"
            : "configured",
    });
  }
  return servers;
}

function extractServerList(raw: unknown): RawMcpServer[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as RawMcpServer[];
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Common shape: { servers: [...] } or a map { name: {...} }.
    if (Array.isArray(obj.servers)) return obj.servers as RawMcpServer[];
    const values = Object.entries(obj).map(([name, v]) => {
      const server = (typeof v === "object" && v ? v : {}) as RawMcpServer;
      return { name, ...server };
    });
    return values;
  }
  return [];
}

export async function discoverMcpServers(
  client?: { mcp?: { status?: () => Promise<{ data?: unknown }> } },
): Promise<McpServerMetadata[]> {
  if (!client?.mcp?.status) return [];
  try {
    const res = await client.mcp.status();
    return normalizeServers(res?.data ?? res);
  } catch {
    return [];
  }
}
