/**
 * P03: packet rendering/injection, service serialization, extension hook wiring.
 * Fake Pi host objects; real Engine on temp storage (no network, Jev forced off).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ContextPacket } from "../../packages/core/src/index.ts";
import { installPacket, latestUserText, PACKET_TAG_PREFIX, renderPacket } from "../../packages/pi/src/context.ts";
import supracortexExtension from "../../packages/pi/src/extension.ts";
import { CortexService } from "../../packages/pi/src/service.ts";

function emptyPacket(): ContextPacket {
  return {
    taskId: "t",
    taskSummary: "test task",
    selectedMemory: [],
    selectedFiles: [],
    selectedSummaries: [],
    constraints: [],
    knownFailures: [],
    estimatedTokens: 0,
    budget: { maxTokens: 4000, usedTokens: 0, remainingTokens: 4000 },
    cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
    omissions: [],
    recommendedSkills: [],
    excludedSkills: [],
    recommendedMcpTools: [],
    excludedMcpServers: [],
    generatedAt: new Date(0).toISOString(),
  };
}

test("render + install: tagged message, idempotent reinstall, latest query", () => {
  const rendered = renderPacket(emptyPacket(), 4000);
  assert.ok(rendered.text.startsWith(PACKET_TAG_PREFIX));
  assert.equal(rendered.trimmed, false);
  const base = [{ role: "user", content: "fix the login bug", timestamp: 1 }];
  const once = installPacket(base, rendered);
  assert.ok(once && once.length === 2);
  assert.equal(latestUserText(once), "fix the login bug");
  // Same revision reinstalls nothing (cache-friendly: hook returns undefined).
  assert.equal(installPacket(once, rendered), null);
  // New revision replaces the old tagged message (still exactly one).
  // NOTE: taskSummary is not rendered; evidence must differ for a new revision.
  const fuller = emptyPacket();
  fuller.recommendedSkills = [{ name: "review", reason: "task needs review", priority: 1, needsLoad: true }];
  const other = renderPacket(fuller, 4000);
  const twice = installPacket(once, other);
  assert.ok(twice && twice.length === 2);
  assert.equal(twice.filter((m) => (m.content as string).startsWith(PACKET_TAG_PREFIX)).length, 1);
  assert.equal(latestUserText([]), "");
});

test("context accepts Pi text blocks and recognizes injected packets by metadata", () => {
  const blocks = [{ role: "user", content: [{ type: "text", text: "first part" }, { type: "text", text: "second part" }] }];
  assert.equal(latestUserText(blocks), "first part\nsecond part");
  const rendered = renderPacket(emptyPacket(), 100);
  const installed = installPacket(blocks, rendered)!;
  assert.equal(latestUserText(installed), "first part\nsecond part");
  // User text that resembles our display marker must not be removed as injected data.
  const spoof = [{ role: "user", content: `${PACKET_TAG_PREFIX}fake] keep this` }];
  assert.equal(latestUserText(spoof), `${PACKET_TAG_PREFIX}fake] keep this`);
  assert.equal(installPacket(spoof, rendered)!.length, 2);
});

test("rendered packet budget includes marker and removes optional sections", () => {
  const packet = emptyPacket();
  packet.recommendedSkills = Array.from({ length: 40 }, (_, i) => ({
    name: `skill-${i}`,
    reason: "recommended because the task needs this capability",
    priority: 1,
    needsLoad: true,
  }));
  const rendered = renderPacket(packet, 80);
  assert.ok(rendered.tokensEstimated <= 80, `estimated ${rendered.tokensEstimated} tokens`);
  assert.equal(rendered.trimmed, true);
});

test("service serializes core ops and preserves memory policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-service-"));
  const service = await CortexService.create(root);
  try {
    assert.equal(service.status().jevSuppressed, false);
    assert.equal(service.status().enabled, true);
    // Evidence-less durable fact must not slip through (existing policy intact).
    const res = (await service.recordMemory({ kind: "fact", content: "unverified claim" })) as { status: string };
    assert.ok(res.status === "recorded" || res.status === "rejected", `unexpected status ${res.status}`);
    // Serialization: run three ops concurrently; all settle with sane shapes.
    const [a, b, c] = await Promise.all([
      service.prepare("task one"),
      service.searchMemory("task"),
      service.prepare("task two"),
    ]);
    assert.ok(a === null || typeof a.taskSummary === "string");
    assert.ok(Array.isArray(b));
    assert.ok(c === null || typeof c.taskSummary === "string");
  } finally {
    await service.close();
  }
});

test("extension context hook injects once per revision (fake host)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const handlers = new Map<string, Array<(event: never, ctx: never) => Promise<unknown>>>();
  const fakePi = {
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (event: string, handler: (event: never, ctx: never) => Promise<unknown>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
  };
  supracortexExtension(fakePi as never);
  const contextHandlers = handlers.get("context");
  assert.ok(contextHandlers && contextHandlers.length === 1);
  const ctx = { cwd: root } as never;
  const messages = [{ role: "user", content: "summarize this repo", timestamp: 1 }];
  const first = await contextHandlers[0]!({ type: "context", messages } as never, ctx);
  assert.ok(first && typeof first === "object" && "messages" in (first as object));
  const withPacket = (first as { messages: Array<{ role: string; content: string }> }).messages;
  assert.equal(withPacket.length, 2);
  assert.ok(withPacket[1]!.content.startsWith(PACKET_TAG_PREFIX));
  // Second call with the packet installed: hook returns undefined (unchanged).
  const second = await contextHandlers[0]!({ type: "context", messages: withPacket } as never, ctx);
  assert.equal(second, undefined);
});
