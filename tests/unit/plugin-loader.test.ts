/** Regression coverage for generation-aware OpenCode plugin loader resolution. */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as cli from "../../packages/opencode/src/cli-core.ts";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

test("pluginEntrySpecFor: bundled dist directory resolves to dist/opencode.js", () => {
  const spec = cli.pluginEntrySpecFor("/x/y/dist");
  assert.ok(spec.endsWith("/dist/opencode.js"), spec);
  assert.ok(spec.startsWith("file://"), spec);
});

test("pluginEntrySpecFor: source directory resolves to plugin.ts", () => {
  const spec = cli.pluginEntrySpecFor("/x/y/packages/opencode/src");
  assert.ok(spec.endsWith("/packages/opencode/src/plugin.ts"), spec);
  assert.ok(spec.startsWith("file://"), spec);
});

test("pluginEntrySpecFor: V2 source directory resolves to the isolated V2 adapter", () => {
  const spec = cli.pluginEntrySpecFor("/x/y/packages/opencode/src", "v2");
  assert.ok(spec.endsWith("/packages/opencode/src/plugin-v2.ts"), spec);
  assert.ok(spec.startsWith("file://"), spec);
});

test("pluginEntrySpecFor: V2 bundled directory resolves to the isolated V2 artifact", () => {
  const spec = cli.pluginEntrySpecFor("/x/y/dist", "v2");
  assert.ok(spec.endsWith("/dist/opencode-v2.js"), spec);
});

test("detectOpenCodeGeneration honors an explicit generation override", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-plugin-generation-"));
  try {
    assert.equal(await cli.detectOpenCodeGeneration(root, { SUPRACORTEX_OPENCODE_GENERATION: "v2" }), "v2");
    assert.equal(await cli.detectOpenCodeGeneration(root, { SUPRACORTEX_OPENCODE_GENERATION: "v1" }), "v1");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("detectOpenCodeGeneration recognizes V2 config shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-plugin-generation-"));
  try {
    await writeFile(join(root, "opencode.jsonc"), '{ "mcp": { "servers": {} } }\n', "utf8");
    assert.equal(await cli.detectOpenCodeGeneration(root, {}), "v2");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("V2 install writes a generation-aware loader and local MCP server without replacing config", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-v2-install-"));
  try {
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(join(root, "opencode.jsonc"), '{\n  // retained\n  "plugins": []\n}\n', "utf8");
    const report = await cli.install({ projectRoot: root });
    const loader = await readFile(join(root, ".opencode", "plugins", "supracortex.ts"), "utf8");
    const config = await readFile(join(root, "opencode.jsonc"), "utf8");
    assert.match(loader, /SUPRACODE_HOST_GENERATION === "v2"/);
    assert.ok(
      loader.includes("opencode-v2.js") || loader.includes("plugin-v2.ts"),
      `loader references V2 adapter: ${loader}`,
    );
    assert.ok(loader.includes("plugin.ts"), `loader preserves V1 adapter path: ${loader}`);
    assert.match(config, /"type": "local"/);
    assert.match(config, /"environment"/);
    assert.ok(report.created.includes(join(root, ".opencode", "plugins", "supracortex.ts")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pluginEntrySpecFor: never resolves the bundled branch to plugin.ts", () => {
  const spec = cli.pluginEntrySpecFor("/x/y/dist");
  assert.ok(!spec.endsWith("plugin.ts"), `bundled spec must not point at plugin.ts, got ${spec}`);
});

test("skillTemplatePathFor resolves the packaged skill from source and dist", () => {
  const expected = join("/x/y", "templates", "skills", "supracortex", "SKILL.md");
  assert.equal(cli.skillTemplatePathFor("/x/y/packages/opencode/src"), expected);
  assert.equal(cli.skillTemplatePathFor("/x/y/dist"), expected);
});

test("install (source test context) writes a dual-generation loader pointing at real adapter bundles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-plugin-loader-"));
  try {
    await writeFile(join(dir, "opencode.json"), JSON.stringify({ plugin: [] }), "utf8");
    await cli.install({ projectRoot: dir });
    const loaderPath = join(dir, ".opencode", "plugins", "supracortex.ts");
    const content = await readFile(loaderPath, "utf8");
    assert.match(content, /supracortex:owned/);
    assert.match(content, /export const SupraCortex = v1/);
    assert.match(content, /SUPRACODE_HOST_GENERATION === "v2"/);
    const v1Match = content.match(/const v1Spec = "([^"]+)"/);
    const v2Match = content.match(/const v2Spec = "([^"]+)"/);
    assert.ok(v1Match, `V1 file URL present: ${content}`);
    assert.ok(v2Match, `V2 file URL present: ${content}`);
    for (const specUrl of [v1Match![1]!, v2Match![1]!]) {
      assert.ok(specUrl.startsWith("file://"), specUrl);
      assert.ok(await exists(fileURLToPath(specUrl)), `generated adapter path exists: ${specUrl}`);
    }
    assert.ok(
      v1Match![1]!.endsWith("dist/opencode.js") ||
        v1Match![1]!.endsWith("packages/opencode/src/plugin.ts"),
      v1Match![1]!,
    );
    assert.ok(
      v2Match![1]!.endsWith("packages/opencode/src/plugin-v2.ts") ||
        v2Match![1]!.endsWith("dist/opencode-v2.js"),
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});
