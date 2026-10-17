/**
 * P02 agent definitions: Markdown files with validated frontmatter.
 * Layering: bundled -> user -> project; same-name higher layer replaces lower.
 * v1 children are read-only: frontmatter tools are restricted to the adapter's
 * read-only tool names plus the result-submission tool. Skill text never widens
 * tool permissions.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ModelRef } from "./config.ts";

export const AGENT_FILE_MAX_BYTES = 32 * 1024;
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

/** Tools a v1 child role may request. Everything else is rejected. */
export const CHILD_READONLY_TOOLS = ["read", "grep", "find", "ls", "cortex_submit_result"] as const;
export type ChildToolName = (typeof CHILD_READONLY_TOOLS)[number];

/** Tool names that are never allowed in child frontmatter. */
const FORBIDDEN_CHILD_TOOLS = ["bash", "edit", "write", "cortex_delegate", "cortex_job"];

const AgentFrontmatterSchema = z.object({
  name: z.string().regex(AGENT_NAME_PATTERN),
  description: z.string().min(1).max(2000),
  modelProvider: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(256).optional(),
  thinking: z.enum(["low", "medium", "high"]).optional(),
  tools: z.array(z.string().min(1).max(64)).max(32).optional(),
  skills: z.array(z.string().min(1).max(256)).max(32).optional(),
}).strict();

export interface AgentDefinition {
  name: string;
  description: string;
  /** Agent-file model (atomic pair); absent means "use resolved main model". */
  model?: ModelRef;
  thinking?: "low" | "medium" | "high";
  tools: string[];
  skills: string[];
  body: string;
  /** Which layer provided this definition (for /agents provenance). */
  layer: "bundled" | "user" | "project";
  path: string;
}

export class AgentDefinitionError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

function splitFrontmatter(text: string): { front: string; body: string } | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  return { front: text.slice(3, end).trim(), body: text.slice(end + 4).trim() };
}

/** Parse + validate one agent file. Throws AgentDefinitionError. */
export function parseAgentDefinition(text: string, path: string, layer: AgentDefinition["layer"]): AgentDefinition {
  if (text.length > AGENT_FILE_MAX_BYTES) {
    throw new AgentDefinitionError(path, `exceeds ${AGENT_FILE_MAX_BYTES} bytes`);
  }
  const split = splitFrontmatter(text);
  if (!split) throw new AgentDefinitionError(path, "missing YAML frontmatter (--- fences)");
  let raw: unknown;
  try {
    raw = parseYaml(split.front) as unknown;
  } catch (cause) {
    throw new AgentDefinitionError(path, `invalid YAML: ${cause instanceof Error ? cause.message : "parse error"}`);
  }
  const parsed = AgentFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AgentDefinitionError(
      path,
      `invalid frontmatter ${first ? first.path.join(".") : "(root)"}: ${first?.message ?? "schema mismatch"}`,
    );
  }
  const fm = parsed.data;
  let model: ModelRef | undefined;
  if (fm.model !== undefined || fm.modelProvider !== undefined) {
    if (fm.model === undefined || fm.modelProvider === undefined) {
      throw new AgentDefinitionError(path, "model and modelProvider must be set together (atomic pair)");
    }
    model = { provider: fm.modelProvider, id: fm.model };
  }
  const tools = fm.tools ?? [...CHILD_READONLY_TOOLS];
  for (const tool of tools) {
    if ((FORBIDDEN_CHILD_TOOLS as readonly string[]).includes(tool)) {
      throw new AgentDefinitionError(path, `tool "${tool}" is forbidden in v1 child roles`);
    }
    if (!(CHILD_READONLY_TOOLS as readonly string[]).includes(tool)) {
      throw new AgentDefinitionError(path, `unknown tool "${tool}" (allowed: ${CHILD_READONLY_TOOLS.join(", ")})`);
    }
  }
  return {
    name: fm.name,
    description: fm.description,
    ...(model ? { model } : {}),
    ...(fm.thinking ? { thinking: fm.thinking } : {}),
    tools,
    skills: fm.skills ?? [],
    body: split.body,
    layer,
    path,
  };
}

/** Load all `*.md` agent files from one directory (missing dir = empty). */
export async function loadAgentDir(dir: string, layer: AgentDefinition["layer"]): Promise<AgentDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) continue;
    const text = await readFile(path, "utf8");
    out.push(parseAgentDefinition(text, path, layer));
  }
  return out;
}

/**
 * Discover agent definitions across layers. Higher layer replaces same-name
 * lower entries. Throws on the first invalid file (fail closed).
 */
export async function discoverAgents(layers: Array<{ dir: string; layer: AgentDefinition["layer"] }>): Promise<Map<string, AgentDefinition>> {
  const merged = new Map<string, AgentDefinition>();
  for (const { dir, layer } of layers) {
    for (const def of await loadAgentDir(dir, layer)) {
      merged.set(def.name, def);
    }
  }
  return merged;
}
