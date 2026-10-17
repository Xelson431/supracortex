import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createIdempotentCleanup, createMcpServer, runStdioMcp } from "../../src/mcp.ts";
import { MAX_MCP_INPUT_CHARS, MCP_TOOL_NAMES, MCP_PROTOCOL_VERSION, OutputSchemas } from "../../src/protocol.ts";

/** Temp project. Features come from the (test-isolated) central config; a
 * project file can only carry the per-project kill switch. */
async function makeProject(enabled: boolean, _graphEnabled = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sc-mcp-"));
  await mkdir(join(root, ".supracortex"), { recursive: true });
  const cfg = { enabled };
  await writeFile(
    join(root, ".supracortex", "config.jsonc"),
    JSON.stringify(cfg, null, 2) + "\n",
    "utf8",
  );
  return root;
}

async function connect(root: string): Promise<Client> {
  const server = await createMcpServer(root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function payloadOf(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ text: string }> }).content;
  const first = content[0];
  assert.ok(first, "expected tool content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

test("MCP: tools/list advertises every registered tool with real schemas", async () => {
  const client = await connect(await makeProject(true));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...MCP_TOOL_NAMES].sort());
  for (const t of tools) {
    const s = t.inputSchema as { type?: unknown; additionalProperties?: unknown };
    assert.equal(s.type, "object", `${t.name} inputSchema must declare an object root`);
    assert.notEqual(s.additionalProperties, true, `${t.name} must not be open passthrough`);
  }
  await client.close();
});

/**
 * Anthropic's Messages API rejects a tool whose input_schema carries
 * `anyOf`/`oneOf`/`allOf` at the top level:
 *   tools.N.custom.input_schema: input_schema does not support oneOf, allOf,
 *   or anyOf at the top level
 * A host re-sends its full tool list on every request, so a single offending tool
 * makes the whole session unusable until restart. Nothing downstream reliably
 * strips it: OpenCode's schema sanitizer has no Anthropic branch, MCP tools never
 * reach the `tool.definition` hook, and OmniRoute preserves root combinators for
 * Claude targets. The guarantee is therefore enforced at the advertisement site.
 *
 * Output schemas are covered too: they previously carried root `anyOf` from zod
 * `.nullable()`, and the MCP SDK additionally requires `outputSchema.type` to be
 * the literal string "object".
 */
test("MCP: no advertised schema carries a root-level combinator", async () => {
  const client = await connect(await makeProject(true));
  const { tools } = await client.listTools();
  for (const t of tools) {
    for (const kind of ["inputSchema", "outputSchema"] as const) {
      const schema = (t as Record<string, unknown>)[kind] as Record<string, unknown> | undefined;
      if (!schema) continue;
      for (const key of ["anyOf", "oneOf", "allOf"]) {
        assert.ok(
          !(key in schema),
          `${t.name}.${kind} advertises root-level "${key}"; Anthropic rejects this with HTTP 400`,
        );
      }
      assert.ok(
        schema.type === "object" || schema.type === undefined,
        `${t.name}.${kind} must declare type "object" (the MCP SDK rejects a type array), got ${JSON.stringify(schema.type)}`,
      );
      assert.ok(!("$schema" in schema), `${t.name}.${kind} must not advertise the $schema meta-key`);
    }
  }
  await client.close();
});

/**
 * cortex_record is one flat advertised object with two facets, not a union. The
 * facet requirements and per-facet field exclusivity must survive that: the flat
 * parse validates shapes, then the matching branch schema enforces what `type`
 * actually requires.
 */
test("MCP: cortex_record facets stay strict under one flat advertised schema", async () => {
  const client = await connect(await makeProject(true));
  const { tools } = await client.listTools();
  const record = tools.find((t) => t.name === "cortex_record");
  const input = record?.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
  assert.ok(input, "cortex_record must advertise an inputSchema");
  // `type` is the only field the flat schema may require; every other
  // requirement belongs to a branch, selected by `type`.
  assert.deepEqual(input.required, ["type"], "flat schema must require only `type`");
  // Both facets' fields are still documented to the model.
  for (const key of ["kind", "content", "sourceReferences", "taskId", "status", "summary", "touchedFiles"]) {
    assert.ok(key in (input.properties ?? {}), `cortex_record must advertise the "${key}" field`);
  }

  const memory = payloadOf(
    await client.callTool({
      name: "cortex_record",
      arguments: {
        type: "memory",
        kind: "decision",
        content: "Flat schema keeps both facets usable.",
        // Durable facts require evidence under the default config; supply it so
        // this asserts schema/dispatch, not the evidence policy.
        sourceReferences: [{ kind: "file", value: "src/protocol.ts" }],
      },
    }),
  );
  assert.equal(memory.status, "recorded");

  const outcome = payloadOf(
    await client.callTool({
      name: "cortex_record",
      arguments: { type: "outcome", taskId: "flat-1", status: "success", summary: "ok", touchedFiles: [] },
    }),
  );
  assert.equal(outcome.recorded, true);

  // Missing the facet's required fields is still rejected...
  const missing = (await client.callTool({ name: "cortex_record", arguments: { type: "memory" } })) as { isError?: boolean };
  assert.equal(missing.isError, true, "a memory write without kind/content must be rejected");

  // ...and a field from the OTHER facet is still rejected.
  const crossFacet = (await client.callTool({
    name: "cortex_record",
    arguments: { type: "memory", kind: "fact", content: "x", status: "success" },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(crossFacet.isError, true, "an outcome field on a memory write must be rejected");
  assert.match(crossFacet.content[0]!.text, /status/);

  await client.close();
});

test("MCP: cortex_status reports protocol + package version even when disabled", async () => {
  const client = await connect(await makeProject(false));
  const payload = payloadOf(await client.callTool({ name: "cortex_status", arguments: {} }));
  assert.equal(payload.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(payload.packageVersion, "0.2.0");
  assert.equal(typeof payload.enabled, "boolean");
  await client.close();
});

test("MCP: invalid input is a model-visible tool error, not a throw", async () => {
  const client = await connect(await makeProject(true));
  const res = (await client.callTool({
    name: "cortex_record",
    arguments: { type: "memory" }, // missing required content/kind
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(res.isError, true);
  const first = res.content[0];
  assert.ok(first, "expected error content");
  assert.match(first.text, /error|invalid|required/i);
  await client.close();
});

test("MCP: aggregate request input is bounded before schema parsing", async () => {
  const client = await connect(await makeProject(true));
  const res = await client.callTool({
    name: "cortex_status",
    arguments: { padding: "x".repeat(MAX_MCP_INPUT_CHARS) },
  }) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(res.isError, true);
  assert.equal(JSON.parse(res.content[0]!.text).code, "INPUT_TOO_LARGE");
  await client.close();
});

test("MCP: disabled project performs a successful no-op for data tools", async () => {
  const client = await connect(await makeProject(false));
  const payload = payloadOf(await client.callTool({ name: "cortex_search", arguments: { query: "anything" } }));
  assert.equal(payload.disabled, true);
  assert.equal(payload.noop, true);
  await client.close();
});

test("MCP: cortex_record persists a verified durable memory", async () => {
  const client = await connect(await makeProject(true));
  const payload = payloadOf(
    await client.callTool({
      name: "cortex_record",
      arguments: {
        type: "memory",
        kind: "decision",
        content: "Use JSONL as the default storage driver for portability.",
        confidence: 0.9,
        sourceReferences: [{ kind: "file", value: "README.md" }],
      },
    }),
  );
  assert.equal(payload.status, "recorded");
  await client.close();
});

test("MCP: cortex_record outcome facet validates against the advertised schema", async () => {
  // Regression: the outcome result ({recorded, operationId}) was validated
  // against the memory-only schema, so strict hosts failed it with -32602
  // (missing status/redacted) even though the outcome was committed.
  const client = await connect(await makeProject(true));
  const res = (await client.callTool({
    name: "cortex_record",
    arguments: {
      type: "outcome",
      taskId: "smoke-task",
      status: "success",
      summary: "smoke outcome",
      touchedFiles: [],
    },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(res.isError, undefined);
  const payload = payloadOf(res);
  assert.equal(payload.recorded, true);
  assert.equal(typeof payload.operationId, "string");
  await client.close();
});

test("MCP: cortex_record input rejections stay host-valid so the real message survives", async () => {
  // Regression: a missing kind/summary produced an {error, code} envelope
  // that strict hosts masked as -32602 (missing status/redacted/...),
  // hiding the actual complaint. The advertised union must accept the
  // envelope so failures stay model-visible.
  const client = await connect(await makeProject(true));
  const schema = OutputSchemas["cortex_record"];
  assert.ok(schema, "cortex_record must advertise an output schema");
  const badMemory = (await client.callTool({
    name: "cortex_record",
    arguments: { type: "memory", content: "smoke probe without kind" },
  })) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };
  assert.equal(badMemory.isError, true);
  assert.equal(schema.safeParse(badMemory.structuredContent).success, true);
  assert.match(String((badMemory.structuredContent as { error?: unknown }).error ?? ""), /kind/i);
  const badOutcome = (await client.callTool({
    name: "cortex_record",
    arguments: { type: "outcome", taskId: "t", status: "success" },
  })) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };
  assert.equal(badOutcome.isError, true);
  assert.equal(schema.safeParse(badOutcome.structuredContent).success, true);
  assert.match(String((badOutcome.structuredContent as { error?: unknown }).error ?? ""), /summary/i);
  await client.close();
});

test("MCP: graph operations are explicit, bounded, and available to every MCP host", async () => {
  const root = await makeProject(true, true);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "import { b } from './b'; export const a = b;\n", "utf8");
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");
  const client = await connect(root);
  const before = payloadOf(await client.callTool({ name: "cortex_graph_status", arguments: {} }));
  assert.equal(before.enabled, true);
  assert.equal(before.available, false);
  const rebuilt = payloadOf(await client.callTool({ name: "cortex_graph_rebuild", arguments: { forceIndex: true } }));
  assert.equal(rebuilt.rebuilt, true);
  const queried = payloadOf(await client.callTool({ name: "cortex_graph_query", arguments: { selector: "path:src/a.ts", maxResults: 5 } }));
  assert.ok(Array.isArray(queried.nodes));
  assert.ok(Array.isArray(queried.edges));
  assert.ok((queried.nodes as unknown[]).length <= 51, "nodes stay bounded");
  assert.ok((queried.edges as unknown[]).length <= 50, "edges stay bounded");
  assert.equal(typeof queried.truncated, "boolean");
  if (queried.truncated) assert.match(String(queried.reason ?? ""), /truncated:/);
  const invalid = await client.callTool({ name: "cortex_graph_query", arguments: { selector: "bare-label" } }) as { isError?: boolean };
  assert.equal(invalid.isError, true);
  await client.close();
});

test("MCP: cleanup coalesces concurrent and repeated shutdown triggers", async () => {
  let calls = 0;
  let release!: () => void;
  const close = createIdempotentCleanup(async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
  });

  const first = close();
  const concurrent = close();
  assert.strictEqual(concurrent, first, "concurrent close shares one promise");
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, concurrent]);
  assert.strictEqual(close(), first, "later close returns the settled promise");
  assert.equal(calls, 1);
});

test("MCP: peer transport close and explicit close are idempotent", async () => {
  const server = await createMcpServer(await makeProject(true));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  await client.close();
  await server.close();
  await server.close();
});

test("MCP stdio: EOF shuts down cleanly and writes no non-protocol stdout", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const signals = new EventEmitter();
  const output: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => output.push(chunk));

  const running = runStdioMcp(await makeProject(true), { stdin, stdout, signalSource: signals });
  stdin.end();
  await running;

  assert.equal(Buffer.concat(output).toString("utf8"), "");
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  stdout.destroy();
});

test("MCP stdio: SIGTERM closes once and removes lifecycle listeners", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const signals = new EventEmitter();
  const ready = new Promise<void>((resolve) => {
    const listener = (event: string | symbol) => {
      if (event !== "SIGTERM") return;
      signals.off("newListener", listener);
      resolve();
    };
    signals.on("newListener", listener);
  });

  const running = runStdioMcp(await makeProject(true), { stdin, stdout, signalSource: signals });
  await ready;
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  await running;

  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  stdin.destroy();
  stdout.destroy();
});

test("MCP stdio: the real CLI exits on peer EOF with protocol-pure stdout", async (t) => {
  const root = await makeProject(true);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const child = spawn(process.execPath, [join(repositoryRoot, "scripts", "cli.ts"), "mcp"], {
    cwd: root,
    env: { ...process.env, SUPRACORTEX_ROOT: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

  child.stdin.end();
  // The full suite runs test files concurrently. On a loaded CI host the
  // TypeScript cold start can exceed five seconds even though EOF shutdown is
  // correct; keep this a bounded liveness test without making it scheduler
  // flaky. The focused test remains fast under normal load.
  const [code, signal] = await once(child, "exit", { signal: AbortSignal.timeout(20_000) });
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
});
