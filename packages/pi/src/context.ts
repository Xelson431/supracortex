/**
 * P03 context rendering + injection policy.
 *
 * - Renders a bounded evidence text from a built packet (V2-projected) and
 *   measures the FINAL rendered text (never selected-source sizes).
 * - Trims lowest-priority optional sections to fit; never emits invalid
 *   envelopes (plain text message, no JSON contract here).
 * - Installs at most one tagged message per task revision; returns null when
 *   the installed revision is current so the hook returns undefined and Pi
 *   keeps every system message in place (prompt-cache friendly).
 */

import { createHash } from "node:crypto";
import type { ContextPacket } from "@local/supracortex-core";
import { estimateWireTextTokens, projectContextPacketV2 } from "@local/supracortex-core";

export const PACKET_TAG_PREFIX = "[supracortex context rev=";

export interface RenderedPacket {
  text: string;
  revision: string;
  tokensEstimated: number;
  trimmed: boolean;
}

function section(title: string, lines: string[]): string {
  if (!lines.length) return "";
  return `## ${title}\n${lines.join("\n")}\n`;
}

/** Render packet evidence as labeled text (stable order, provenance kept). */
export function renderPacket(packet: ContextPacket, maxTokens: number): RenderedPacket {
  const v2 = projectContextPacketV2(packet);
  const memLines = v2.evidence.memory.map(
    (m) => `- [${m.kind}/${m.origin}/${m.evidenceState}] ${m.text} (${m.reason})`,
  );
  const fileLines = packet.selectedFiles.map(
    (f) => `- ${f.path} (${f.mode}, ~${f.estimatedTokens} tok)`,
  );
  const summaryLines = packet.selectedSummaries.map((s) => `- ${s.path}: ${s.summary}`);
  const omissionLines = packet.omissions.map((o) => `- ${o.path}: ${o.reason}`);
  const skillLines = packet.recommendedSkills.map((s) => `- ${s.name}: ${s.reason}`);
  const gitLines = packet.currentGitChanges
    ? [
        `branch: ${packet.currentGitChanges.branch ?? "unknown"}`,
        `changed: ${packet.currentGitChanges.changedFiles.slice(0, 20).join(", ") || "none"}`,
      ]
    : [];

  // Priority: memory > files > git > skills > summaries > omissions.
  const optional: Array<{ lines: string[]; text: string }> = [
    { lines: memLines, text: section("Project memory", memLines) },
    { lines: fileLines, text: section("Recommended reads (billed fresh on read)", fileLines) },
    { lines: gitLines, text: section("Working tree", gitLines) },
    { lines: skillLines, text: section("Recommended skills", skillLines) },
    { lines: summaryLines, text: section("File summaries", summaryLines) },
    { lines: omissionLines, text: section("Omitted (with reasons)", omissionLines) },
  ];
  const picked: string[] = [];
  let trimmed = false;
  const tag = (body: string) => {
    const revision = createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
    return `${PACKET_TAG_PREFIX}${revision}]${body ? `\n${body}` : ""}`;
  };
  const fits = (body: string): boolean => estimateWireTextTokens([tag(body)]).tokens <= Math.max(0, maxTokens);
  for (const part of optional) {
    if (!part.lines.length) continue;
    const candidate = [...picked, part.text].join("\n");
    if (fits(candidate)) {
      picked.push(part.text);
    } else {
      trimmed = true;
    }
  }
  // The complete rendered message, including its own marker, is what consumes
  // the context budget. Drop lowest-priority sections until that invariant holds.
  while (picked.length && !fits(picked.join("\n").trim())) {
    picked.pop();
    trimmed = true;
  }
  const body = picked.join("\n").trim();
  const revision = createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
  const text = tag(body);
  const { tokens } = estimateWireTextTokens([text]);
  return { text, revision, tokensEstimated: tokens, trimmed };
}

export interface PiMessageLike {
  role: string;
  [key: string]: unknown;
}

function messageText(message: PiMessageLike): string | null {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((block): block is { type: "text"; text: string } =>
      !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function isOwnPacketMessage(message: PiMessageLike): boolean {
  return message.role === "user" && (message as { supraCortexPacket?: unknown }).supraCortexPacket === true;
}

/**
 * Install the rendered packet into a conversation copy. Returns the new list,
 * or null when the installed revision is already current (caller must return
 * undefined so Pi treats the conversation as unchanged).
 */
export function installPacket(messages: PiMessageLike[], rendered: RenderedPacket): PiMessageLike[] | null {
  const existing = messages.find(isOwnPacketMessage);
  const existingText = existing ? messageText(existing) : null;
  if (existingText !== null && existingText.startsWith(`${PACKET_TAG_PREFIX}${rendered.revision}]`)) {
    return null;
  }
  const next = messages.filter((m) => !isOwnPacketMessage(m));
  next.push({ role: "user", content: rendered.text, timestamp: Date.now(), supraCortexPacket: true });
  return next;
}

/** Extract the latest user text as the packet query (empty string if none). */
export function latestUserText(messages: PiMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text === null) continue;
    if (!isOwnPacketMessage(message)) return text.slice(0, 2000);
  }
  return "";
}
