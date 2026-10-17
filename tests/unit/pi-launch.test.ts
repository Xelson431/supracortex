/**
 * P01: Pi launcher resolution. Uses fixture manifests; no Pi install needed.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { findPiPackageRoot, fixtureUrl, PI_PACKAGE_NAME, resolvePiBin, runPi } from "../../packages/pi/src/launch.ts";

function fixture(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-launch-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  mkdirSync(join(dir, "dist", "bundle"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), " fixture root ");
  writeFileSync(join(dir, "dist", "bundle", "cli.js"), " fixture ");
  return join(dir, "dist", "index.js");
}

test("resolves the Pi bin from a valid manifest", () => {
  const path = fixture({ name: PI_PACKAGE_NAME, version: "0.87.1", bin: { pi: "dist/bundle/cli.js" } });
  const bin = resolvePiBin(fixtureUrl(path));
  assert.equal(bin.version, "0.87.1");
  assert.ok(bin.binPath.endsWith(join("dist", "bundle", "cli.js")));
});

test("rejects a tree with no Pi manifest", () => {
  const path = fixture({ name: "evil-pi", version: "9.9.9", bin: { pi: "dist/bundle/cli.js" } });
  assert.throws(() => resolvePiBin(fixtureUrl(path)), /No .* manifest found/);
});

test("rejects a manifest with no pi bin entry", () => {
  const path = fixture({ name: PI_PACKAGE_NAME, version: "0.87.1" });
  assert.throws(() => resolvePiBin(fixtureUrl(path)), /no pi bin entry/);
});

test("findPiPackageRoot walks up from deep files", () => {
  const entry = fixture({ name: PI_PACKAGE_NAME, version: "0.87.1", bin: { pi: "dist/bundle/cli.js" } });
  const deep = join(dirname(entry), "bundle", "cli.js");
  const root = findPiPackageRoot(deep);
  assert.ok(root);
  assert.equal(resolvePiBin(fixtureUrl(deep)).packageRoot, root);
});

test("runPi launches fullscreen by default and preserves explicit TUI mode", () => {
  const bin = { packageRoot: "/pkg", binPath: "/pkg/dist/bundle/cli.js", version: "0.87.1" };
  const seen: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
  const fakeSpawn = ((cmd: string, args: string[], opts: unknown) => {
    seen.push({ cmd, args, opts });
    return { on: () => undefined };
  }) as unknown as typeof import("node:child_process").spawn;
  runPi(bin, { extensionPath: "/pkg/dist/pi-extension.js", piArgs: ["-p", "hi"], env: { HOME: "/home/test" }, spawnImpl: fakeSpawn });
  assert.equal(seen.length, 1);
  const call = seen[0]!;
  assert.equal(call.cmd, process.execPath);
  assert.deepEqual(call.args, ["/pkg/dist/bundle/cli.js", "-e", "/pkg/dist/pi-extension.js", "--tui-mode", "fullscreen", "--mcp-config", "/home/test/.pi/agent/mcp.json", "-p", "hi"]);
  assert.equal((call.opts as { shell: boolean }).shell, false);
  runPi(bin, { piArgs: ["--tui-mode", "regular"], spawnImpl: fakeSpawn });
  assert.deepEqual(seen[1]!.args, ["/pkg/dist/bundle/cli.js", "--mcp-config", join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent", "mcp.json"), "--tui-mode", "regular"]);
  runPi(bin, { piArgs: ["--mcp-config", "/tmp/custom-mcp.json"], spawnImpl: fakeSpawn });
  assert.deepEqual(seen[2]!.args, ["/pkg/dist/bundle/cli.js", "--tui-mode", "fullscreen", "--mcp-config", "/tmp/custom-mcp.json"]);
});
