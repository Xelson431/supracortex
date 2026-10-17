import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCortexToolUse, SupraCortexV2 } from "../../packages/opencode/src/plugin-v2.ts";

test("OpenCode V2 adapter has the define-compatible plugin shape", () => {
  assert.equal(SupraCortexV2.id, "supracortex");
  assert.equal(typeof SupraCortexV2.setup, "function");
});

test("V2 cortex tool-history detection is bounded and prioritizes tool names", () => {
  const largeResult = "x".repeat(2_000_000);
  assert.equal(hasCortexToolUse([
    { role: "assistant", content: [{ type: "tool", name: "cortex_context", output: largeResult }] },
  ]), true);
  assert.equal(hasCortexToolUse([{ role: "assistant", content: [{ type: "text", text: "ordinary response" }] }]), false);
});

test("OpenCode V2 context hook accepts V2 and legacy message shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-v2-plugin-"));
  const priorRoot = process.env.SUPRACORTEX_ROOT;
  let hook: ((context: { sessionID: string; system: unknown[]; messages: unknown[] }) => Promise<void>) | undefined;
  let registrationDisposed = false;
  try {
    await mkdir(join(root, ".supracortex"), { recursive: true });
    await writeFile(join(root, ".supracortex", "config.jsonc"), '{ "enabled": true }\n');
    await writeFile(join(root, "example.ts"), "export const example = true;\n");
    process.env.SUPRACORTEX_ROOT = root;
    const cleanup = await SupraCortexV2.setup({
      session: { hook: async (_name, callback) => {
        hook = callback as typeof hook;
        return { dispose: async () => { registrationDisposed = true; } };
      } },
      tool: { hook: async () => ({ dispose: async () => undefined }) },
    });
    assert.ok(hook);
    await hook!({ sessionID: "v2", system: [], messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "Inspect example.ts" }] }] });
    await cleanup?.();
    assert.equal(registrationDisposed, true);
  } finally {
    if (priorRoot === undefined) delete process.env.SUPRACORTEX_ROOT;
    else process.env.SUPRACORTEX_ROOT = priorRoot;
  }
});

test("OpenCode V2 registration failure degrades to a no-op", async () => {
  const result = await SupraCortexV2.setup({
    session: { hook: async () => { throw new Error("unsupported host hook"); } },
    tool: { hook: async () => ({ dispose: async () => undefined }) },
  });
  assert.equal(result, undefined);
});

test("V2 install refreshes its own stale MCP entry but never a user-authored one", async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cli = await import("../../packages/opencode/src/cli-core.ts");
  const home = await mkdtemp(join(tmpdir(), "sc-v2-stale-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const root = join(home, ".config", "supracode2");
    await mkdir(root, { recursive: true });
    const file = join(root, "opencode.jsonc");
    await writeFile(file, JSON.stringify({ mcp: { servers: { supracortex: { type: "local", command: ["/usr/bin/node", "/gone/supracortex-old/dist/cli.js", "mcp"] } } } }));
    await cli.install({ projectRoot: home, global: true });
    const after = await readFile(file, "utf8");
    assert.doesNotMatch(after, /supracortex-old/, "stale owned entry refreshed");
    await writeFile(file, JSON.stringify({ mcp: { servers: { supracortex: { type: "local", command: ["my-wrapper", "--flag"] } } } }));
    await cli.install({ projectRoot: home, global: true });
    assert.match(await readFile(file, "utf8"), /my-wrapper/, "user-authored entry preserved");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
});
