/**
 * Index-cache freshness regressions for the two remaining invalidation gaps:
 *   - V2 native host: a file-mutating `execute.after` must invalidate the
 *     Engine in-memory index so the next automatic context sees new bytes.
 *   - MCP: `cortex_context` has no host file-mutation hook, so the MCP engine is
 *     built with TTL 0 and every request re-walks within the TTL window.
 *
 * Deterministic: no sleeps; the assertions read the resulting context packet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp.ts";
import { SupraCortexV2 } from "../../packages/opencode/src/plugin-v2.ts";

async function makeProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(
    join(root, ".supracortex", "config.jsonc"),
    JSON.stringify({ enabled: true }) + "\n",
    "utf8",
  );
  return root;
}

type V2Session = { sessionID: string; system: unknown[]; messages: unknown[] };
type V2SessionHook = (session: V2Session) => Promise<void> | void;
type V2ToolHook = (input: { tool: string; status: "completed" | "error"; error?: unknown; result?: unknown }) => Promise<void> | void;

test("V2: a file-mutating execute.after invalidates the index so the next prepareContext sees new bytes", async () => {
  const root = await makeProject("sc-fresh-v2-");
  const priorRoot = process.env.SUPRACORTEX_ROOT;
  process.env.SUPRACORTEX_ROOT = root;
  let sessionHook: V2SessionHook | undefined;
  let toolHook: V2ToolHook | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const setupResult = await SupraCortexV2.setup({
      session: {
        hook: async (_name, callback) => {
          sessionHook = callback as V2SessionHook;
          return { dispose: async () => undefined };
        },
      },
      tool: {
        hook: async (_name, callback) => {
          toolHook = callback as V2ToolHook;
          return { dispose: async () => undefined };
        },
      },
    });
    cleanup = typeof setupResult === "function" ? setupResult : undefined;
    assert.ok(sessionHook, "V2 session context hook registered");
    assert.ok(toolHook, "V2 tool execute.after hook registered");

    const run = async (): Promise<string> => {
      const session: V2Session = {
        sessionID: "v2-fresh",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "needlexyz symbol" }] }],
      };
      await sessionHook!(session);
      return session.system.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n");
    };

    const before = await run();
    assert.ok(!before.includes("needle.ts"), "needle.ts does not exist yet");

    // A host edit lands, then the V2 execute.after tool hook fires.
    await writeFile(join(root, "needle.ts"), "export function needlexyz() { return 42; }\n", "utf8");
    await toolHook!({ tool: "write", status: "completed" });

    const after = await run();
    assert.ok(after.includes("needle.ts"), "the new file is visible after execute.after invalidation");
  } finally {
    await cleanup?.();
    if (priorRoot === undefined) delete process.env.SUPRACORTEX_ROOT;
    else process.env.SUPRACORTEX_ROOT = priorRoot;
  }
});

test("MCP: cortex_context re-walks within the TTL window so an external edit is reflected", async () => {
  const root = await makeProject("sc-fresh-mcp-");
  await writeFile(join(root, "seed.ts"), "export const seed = 1;\n", "utf8");
  const server = await createMcpServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fresh", version: "0.0.0" }, { capabilities: {} });
  const selectedPaths = (result: unknown): string[] => {
    const content = (result as { content: Array<{ text: string }> }).content;
    const first = content[0];
    assert.ok(first, "tool result has content");
    const payload = JSON.parse(first.text) as { selectedFiles?: Array<{ path: string }> };
    return (payload.selectedFiles ?? []).map((f) => f.path);
  };
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const first = await client.callTool({ name: "cortex_context", arguments: { query: "needlexyz symbol" } });
    assert.ok(!selectedPaths(first).includes("needle.ts"), "needle.ts does not exist yet");

    // An external edit (no host hook exists on the MCP surface).
    await writeFile(join(root, "needle.ts"), "export function needlexyz() { return 42; }\n", "utf8");

    // Same engine, immediately after: still inside any 30s TTL window.
    const second = await client.callTool({ name: "cortex_context", arguments: { query: "needlexyz symbol" } });
    assert.ok(selectedPaths(second).includes("needle.ts"), "the new file is reflected within the TTL window");
  } finally {
    await client.close();
  }
});
