/**
 * Capability catalogue tests (core, pure except engine attribution).
 *  1. Health: cooldown after repeated failures, instant recovery on success,
 *     connected marking, bounded snapshot.
 *  2. Web detection: search/fetch providers recognized; local file tools not.
 *  3. Selector: cooling servers excluded with reason; live servers preferred.
 *  4. Engine: outcome attribution by server prefix; snapshot includes web map.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CapabilityHealth,
  Engine,
  JsonlStore,
  detectWebCapabilities,
  isWebFetchTool,
  isWebSearchTool,
  resolveConfig,
  selectMcpTools,
} from "../../packages/core/src/index.ts";
import type { McpServerMetadata } from "../../packages/core/src/index.ts";

function server(name: string, tools: Array<{ name: string; description?: string }>, extra = {}): McpServerMetadata {
  return {
    name,
    type: "local",
    enabled: true,
    requiresAuth: false,
    tools: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), mutating: false, sensitive: false })),
    ...extra,
  };
}

test("health cools down after 3 failures and recovers on success", () => {
  let now = 1_000_000;
  const health = new CapabilityHealth({ now: () => now });
  assert.equal(health.isCoolingDown("gh"), false);
  health.recordOutcome({ server: "gh", ok: false, error: "boom" });
  health.recordOutcome({ server: "gh", ok: false, error: "boom" });
  assert.equal(health.isCoolingDown("gh"), false);
  health.recordOutcome({ server: "gh", ok: false, error: "boom" });
  assert.equal(health.isCoolingDown("gh"), true);
  const snap = health.snapshot();
  assert.equal(snap.servers.gh?.availability, "failed");
  assert.equal(snap.servers.gh?.consecutiveFailures, 3);
  // Cooldown expires without new failures.
  now += 61_000;
  assert.equal(health.isCoolingDown("gh"), false);
  // A success recovers immediately and marks the server tested.
  health.recordOutcome({ server: "gh", tool: "create_issue", ok: true });
  const recovered = health.snapshot();
  assert.equal(recovered.servers.gh?.consecutiveFailures, 0);
  assert.equal(recovered.servers.gh?.availability, "tested");
  assert.deepEqual(recovered.testedTools, ["gh:create_issue"]);
});

test("markConnected implies a live, authenticated server", () => {
  const health = new CapabilityHealth();
  health.markConnected("ctx7");
  assert.equal(health.snapshot().servers.ctx7?.availability, "connected");
  assert.equal(health.isCoolingDown("ctx7"), false);
});

test("web detection finds providers without flagging local tools", () => {
  assert.equal(isWebSearchTool("tavily", "tavily_search", "web search"), true);
  assert.equal(isWebFetchTool("firecrawl", "firecrawl_scrape", "scrape a url"), true);
  assert.equal(isWebFetchTool("firecrawl", "firecrawl_search", "search the web"), true);
  assert.equal(isWebSearchTool("fs", "read", "read a file"), false);
  assert.equal(isWebSearchTool("fs", "grep", "search file contents"), false);
  assert.equal(isWebSearchTool("fs", "find", "find files by name"), false);
  assert.equal(isWebFetchTool("fs", "read", "read a file from disk"), false);
  const web = detectWebCapabilities([
    server("firecrawl", [{ name: "firecrawl_scrape" }, { name: "firecrawl_search" }]),
    server("fs", [{ name: "read" }, { name: "grep" }]),
    server("off", [{ name: "tavily_search" }], { enabled: false }),
  ]);
  assert.deepEqual(web, { searchServers: ["firecrawl"], fetchServers: ["firecrawl"] });
});

test("selector excludes cooling servers and prefers live ones", () => {
  const servers = [
    server("cool", [{ name: "cool_do", description: "do the task thing" }]),
    server("live", [{ name: "live_do", description: "do the task thing" }], { availability: "connected" as const }),
  ];
  const cooling = { isCoolingDown: (name: string) => name === "cool" };
  const res = selectMcpTools({ servers, queryTokens: ["task"], health: cooling });
  assert.ok(res.recommended.every((r) => r.server === "live"));
  assert.ok(res.excludedServers.some((e) => e.server === "cool" && e.reason.includes("cooling down")));
  // Without health input both compete; the connected server ranks first.
  const open = selectMcpTools({ servers, queryTokens: ["task"] });
  assert.equal(open.recommended[0]?.server, "live");
});

test("engine attributes outcomes by server prefix and snapshots web map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-cap-"));
  const { config } = resolveConfig({ project: { enabled: true } });
  const engine = new Engine({
    config,
    store: new JsonlStore(join(dir, ".supracortex")),
    pluginVersion: "test",
    projectRoot: dir,
  });
  try {
    await engine.prepareContext(
      { query: "search the task docs" },
      { mcpServers: [server("firecrawl", [{ name: "search", description: "web search" }])] },
    );
    engine.recordCapabilityOutcome({ tool: "firecrawl_search", ok: true });
    engine.recordCapabilityOutcome({ tool: "read", ok: true });
    engine.recordCapabilityOutcome({ tool: "", ok: false });
    const snap = engine.capabilitySnapshot();
    assert.equal(snap.servers.firecrawl?.availability, "tested");
    assert.deepEqual(snap.testedTools, ["firecrawl:search"]);
    assert.deepEqual(snap.web, { searchServers: ["firecrawl"], fetchServers: [] });
    // Native tools and empty names never pollute server health.
    assert.equal(Object.keys(snap.servers).length, 1);
  } finally {
    await engine.close();
  }
});

test("engine cools a repeatedly failing server out of recommendations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-cap-cool-"));
  const { config } = resolveConfig({ project: { enabled: true } });
  const engine = new Engine({
    config,
    store: new JsonlStore(join(dir, ".supracortex")),
    pluginVersion: "test",
    projectRoot: dir,
  });
  try {
    const gather = {
      mcpServers: [server("flaky", [{ name: "flaky_do", description: "do the flaky task" }])],
    };
    await engine.prepareContext({ query: "do the flaky task" }, gather);
    for (let i = 0; i < 3; i++) {
      engine.recordCapabilityOutcome({ tool: "flaky_do", ok: false, error: "timeout" });
    }
    const packet = await engine.prepareContext({ query: "do the flaky task" }, gather);
    const excluded = packet?.excludedMcpServers ?? [];
    assert.ok(excluded.some((e) => e.server === "flaky" && e.reason.includes("cooling down")));
    assert.ok(!(packet?.recommendedMcpTools ?? []).some((t) => t.server === "flaky"));
  } finally {
    await engine.close();
  }
});
