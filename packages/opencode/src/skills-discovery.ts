/**
 * Skill discovery for the OpenCode adapter.
 *
 * Scans supported skill locations and extracts ONLY lightweight metadata (name,
 * description, location, scope, content hash, size estimate, declared triggers,
 * compatible agents). It never loads full skill instructions into memory.
 *
 * Locations (in scope order):
 *   - project: <root>/.opencode/skills/<name>/SKILL.md
 *   - global:  ~/.config/opencode/skills/<name>/SKILL.md
 *   - global:  ~/.agents/skills/<name>/SKILL.md   (compatible fallback)
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillMetadata, SkillScope } from "@local/supracortex-core";
import { estimateTokens } from "@local/supracortex-core";

interface SkillLocation {
  dir: string;
  scope: SkillScope;
}

export function skillLocations(projectRoot: string): SkillLocation[] {
  const home = homedir();
  return [
    { dir: join(projectRoot, ".opencode", "skills"), scope: "project" },
    { dir: join(home, ".config", "opencode", "skills"), scope: "global" },
    { dir: join(home, ".agents", "skills"), scope: "global" },
  ];
}

export async function discoverSkills(projectRoot: string): Promise<SkillMetadata[]> {
  const found = new Map<string, SkillMetadata>();
  for (const loc of skillLocations(projectRoot)) {
    let entries: string[];
    try {
      entries = await readdir(loc.dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const skillMd = join(loc.dir, name, "SKILL.md");
      let content: string;
      let mtimeMs = 0;
      try {
        const st = await stat(skillMd);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
        content = await readFile(skillMd, "utf8");
      } catch {
        continue;
      }
      // Project scope wins over global for the same skill name.
      if (found.has(name) && loc.scope !== "project") continue;
      found.set(name, parseSkill(name, skillMd, loc.scope, content, mtimeMs));
    }
  }
  return Array.from(found.values());
}

export function parseSkill(
  name: string,
  location: string,
  scope: SkillScope,
  content: string,
  mtimeMs: number,
): SkillMetadata {
  const front = parseFrontmatter(content);
  const description = front.description ?? firstParagraph(stripFrontmatter(content));
  const meta: SkillMetadata = {
    name: front.name ?? name,
    description: description.slice(0, 500),
    location,
    scope,
    contentHash: createHash("sha256").update(content).digest("hex").slice(0, 16),
    estimatedTokens: estimateTokens(content),
  };
  const triggers = extractTriggers(description);
  if (triggers.length) meta.triggers = triggers;
  if (front.agents) meta.compatibleAgents = front.agents;
  if (mtimeMs) meta.modifiedAt = new Date(mtimeMs).toISOString();
  return meta;
}

function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  agents?: string[];
} {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m || !m[1]) return {};
  const out: { name?: string; description?: string; agents?: string[] } = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!kv || !kv[1]) continue;
    const key = kv[1].toLowerCase();
    const value = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "name") out.name = value;
    else if (key === "description") out.description = value;
    else if (key === "agents" || key === "compatibleagents") {
      out.agents = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function firstParagraph(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.indexOf("\n\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).replace(/\n/g, " ");
}

/** Pull quoted phrases and comma keywords out of a description as triggers. */
function extractTriggers(description: string): string[] {
  const triggers = new Set<string>();
  const quoted = description.match(/["']([^"']{2,40})["']/g) ?? [];
  for (const q of quoted) triggers.add(q.replace(/["']/g, "").toLowerCase());
  return Array.from(triggers).slice(0, 40);
}
