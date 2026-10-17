import { build } from "esbuild";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  ["scripts/cli.ts", "dist/cli.js"],
  ["src/mcp.ts", "dist/mcp.js"],
  ["src/protocol.ts", "dist/protocol.js"],
  ["src/opencode.ts", "dist/opencode.js"],
  ["src/opencode-v2.ts", "dist/opencode-v2.js"],
  ["src/api.ts", "dist/api.js"],
  ["src/pi-extension.ts", "dist/pi-extension.js"],
] as const;
// Pi packages are supplied by the host Pi runtime; the bundled extension must
// not embed a second copy (duplicate runtime modules bypass the loader).
const PI_EXTERNALS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });
for (const [entry, outfile] of entries) {
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    // jsonc-parser's UMD build uses a runtime-relative CommonJS require
    // (`./impl/format`) that is not safely embeddable in an ESM bundle. Keep it
    // external for the OpenCode artifact too; it is a declared runtime
    // dependency and can then resolve through normal Node package lookup.
    external: entry.includes("opencode")
      ? ["@opencode-ai/plugin", "jsonc-parser"]
      : entry.includes("pi-extension")
        ? [...PI_EXTERNALS, "jsonc-parser"]
        : ["@modelcontextprotocol/sdk", "zod", "zod-to-json-schema", "jsonc-parser"],
    banner: entry === "scripts/cli.ts" ? { js: "#!/usr/bin/env node" } : undefined,
  });
}
// Ensure the CLI entry is executable (esbuild omits the execute bit).
await chmod(resolve(root, "dist", "cli.js"), 0o755);

// SupraCode brand TUI plugin for OpenCode. The host supplies the UI runtime
// (@opentui/*, solid-js, @opencode-ai/plugin) at load time, so they stay
// external — embedding a second copy would bypass the host renderer.
await mkdir(resolve(root, "packages", "tui", "dist"), { recursive: true });
await build({
  entryPoints: [resolve(root, "packages", "tui", "src", "tui.ts")],
  outfile: resolve(root, "packages", "tui", "dist", "tui.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["@opentui/core", "@opentui/solid", "solid-js", "@opencode-ai/plugin", "@opencode-ai/plugin/tui"],
});
await build({
  entryPoints: [resolve(root, "packages", "tui", "src", "tui-v2.ts")],
  outfile: resolve(root, "packages", "tui", "dist", "tui-v2.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["@opentui/core", "@opentui/solid", "solid-js", "@opencode/plugin", "@opencode/plugin/tui"],
});
