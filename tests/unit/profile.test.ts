/**
 * SupraCode host profile: isolation from stock OpenCode.
 * All paths are under a temp HOME; the real ~/.config is never touched.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureProfile,
  migrateOutOfStock,
  profilePaths,
  refreshConfigFarm,
  stockPollution,
  supracodeEnv,
} from "../../packages/opencode/src/profile.ts";

const BRAND = "/opt/supracode/packages/tui";

async function fakeHome(): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(join(tmpdir(), "sc-profile-"));
  return { home, env: { HOME: home } };
}

const CONTENTS = {
  pluginBundle: "/opt/supracode/dist/opencode.js",
  brandTui: BRAND,
  commands: { "cortex-status.md": "---\ndescription: x\n---\n<!-- supracortex:owned -->\n" },
  skill: "---\nname: supracortex\n---\nsupracortex:owned\n",
};

test("supracodeEnv redirects only XDG_CONFIG_HOME and strips config-injecting vars", () => {
  const paths = profilePaths({ HOME: "/h" });
  const env = supracodeEnv(
    { HOME: "/h", PATH: "/bin", XDG_DATA_HOME: "/d", OPENCODE_CONFIG: "/x.json", OPENCODE_CONFIG_DIR: "/cfg", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_TUI_CONFIG: "/t" },
    paths,
  );
  assert.equal(env.XDG_CONFIG_HOME, paths.farm);
  assert.equal(env.SUPRACODE_REAL_XDG_CONFIG_HOME, join("/h", ".config"));
  assert.equal(env.XDG_DATA_HOME, "/d", "data dir (logins, sessions) stays shared");
  assert.equal(env.PATH, "/bin");
  for (const k of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_TUI_CONFIG"]) {
    assert.equal(k in env, false, `${k} must not leak into SupraCode`);
  }
});

test("nested supracode keeps resolving the user's real config home", () => {
  const paths = profilePaths({ HOME: "/h", XDG_CONFIG_HOME: "/h/.local/state/supracode/xdg-config", SUPRACODE_REAL_XDG_CONFIG_HOME: "/h/.config" });
  assert.equal(paths.realConfigHome, "/h/.config");
  assert.equal(paths.stockConfig, join("/h/.config", "opencode"));
});

test("config farm links everything except opencode/supracode, and is idempotent", async () => {
  const { home, env } = await fakeHome();
  try {
    await mkdir(join(home, ".config", "gh"), { recursive: true });
    await mkdir(join(home, ".config", "git"), { recursive: true });
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    const paths = profilePaths(env);
    refreshConfigFarm(paths);
    refreshConfigFarm(paths);
    assert.equal(readlinkSync(join(paths.farm, "gh")), join(home, ".config", "gh"));
    assert.equal(readlinkSync(join(paths.farm, "git")), join(home, ".config", "git"));
    assert.equal(readlinkSync(join(paths.farm, "opencode")), paths.opencodeConfig, "opencode is SupraCode's, never stock's");
    assert.equal(existsSync(join(paths.farm, "supracode")), false);
    // A config dir created later is picked up on the next launch.
    await mkdir(join(home, ".config", "newtool"));
    refreshConfigFarm(paths);
    assert.ok(lstatSync(join(paths.farm, "newtool")).isSymbolicLink());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureProfile copies providers WITHOUT inline credentials and nothing else from stock", async () => {
  const { home, env } = await fakeHome();
  try {
    const stock = join(home, ".config", "opencode");
    await mkdir(stock, { recursive: true });
    await writeFile(
      join(stock, "opencode.json"),
      JSON.stringify({
        plugin: ["some-plugin"],
        mcp: { playwright: { type: "local", command: ["x"] } },
        agent: { build: {} },
        provider: { omniroute: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:1/v1", apiKey: "sk-secret", headers: { Authorization: "Bearer x", "X-Other": "1" } }, models: { m: {} } } },
      }),
    );
    const r = await ensureProfile(CONTENTS, env);
    const paths = profilePaths(env);
    const cfg = JSON.parse(await readFile(join(paths.opencodeConfig, "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(cfg).sort(), ["$schema", "provider"]);
    assert.equal(cfg.provider.omniroute.options.baseURL, "http://localhost:1/v1");
    assert.equal("apiKey" in cfg.provider.omniroute.options, false, "no secret copied");
    assert.deepEqual(cfg.provider.omniroute.options.headers, { "X-Other": "1" });
    assert.ok(r.created.some((p) => p.endsWith(join("plugins", "supracortex.ts"))));
    const tui = JSON.parse(await readFile(join(paths.opencodeConfig, "tui.json"), "utf8"));
    assert.deepEqual(tui.plugin, [BRAND]);
    // Second run: nothing rewritten, user edits to opencode.json preserved.
    await writeFile(join(paths.opencodeConfig, "opencode.json"), JSON.stringify({ plugin: ["mine"] }));
    const again = await ensureProfile(CONTENTS, env);
    assert.equal(again.created.length + again.edited.length, 0);
    assert.deepEqual(JSON.parse(await readFile(join(paths.opencodeConfig, "opencode.json"), "utf8")), { plugin: ["mine"] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migrateOutOfStock removes only SupraCortex artifacts, backs them up, and is idempotent", async () => {
  const { home, env } = await fakeHome();
  try {
    const stock = join(home, ".config", "opencode");
    await mkdir(join(stock, "plugins"), { recursive: true });
    await mkdir(join(stock, "commands"), { recursive: true });
    await mkdir(join(stock, "skills", "supracortex"), { recursive: true });
    await mkdir(join(stock, "skills", "mine"), { recursive: true });
    await mkdir(join(stock, "supracortex"), { recursive: true });
    await writeFile(join(stock, "plugins", "supracortex.ts"), "// supracortex:owned\n");
    await writeFile(join(stock, "plugins", "user.ts"), "export default {}\n");
    await writeFile(join(stock, "commands", "cortex-status.md"), "supracortex:owned\n");
    await writeFile(join(stock, "commands", "deploy.md"), "user command\n");
    await writeFile(join(stock, "skills", "supracortex", "SKILL.md"), "supracortex\n");
    await writeFile(join(stock, "skills", "mine", "SKILL.md"), "mine\n");
    await writeFile(join(stock, "tui.json"), JSON.stringify({ plugin: ["some-user-tui", BRAND] }));
    await writeFile(join(stock, "opencode.json"), JSON.stringify({ plugin: ["some-plugin"], mcp: { playwright: { type: "local" }, supracortex: { type: "local" } } }));
    await writeFile(join(stock, "opencode.jsonc"), JSON.stringify({ $schema: "x", mcp: { servers: { supracortex: { type: "local" } } } }));
    await writeFile(join(stock, "supracortex", "config.jsonc"), '{"jev":{"provider":"laya-local"}}');

    assert.ok((await stockPollution(env)).length >= 5);
    const dry = await migrateOutOfStock({ dryRun: true, brandTui: BRAND, env });
    assert.ok(dry.removed.length > 0);
    assert.ok(existsSync(join(stock, "plugins", "supracortex.ts")), "dry run changes nothing");

    const r = await migrateOutOfStock({ brandTui: BRAND, env });
    assert.equal(existsSync(join(stock, "plugins", "supracortex.ts")), false);
    assert.equal(existsSync(join(stock, "commands", "cortex-status.md")), false);
    assert.equal(existsSync(join(stock, "skills", "supracortex")), false);
    assert.equal(existsSync(join(stock, "opencode.jsonc")), false, "file that held only our MCP is removed");
    assert.equal(existsSync(join(stock, "supracortex")), false);
    // User content untouched.
    assert.ok(existsSync(join(stock, "plugins", "user.ts")));
    assert.ok(existsSync(join(stock, "commands", "deploy.md")));
    assert.ok(existsSync(join(stock, "skills", "mine", "SKILL.md")));
    assert.deepEqual(JSON.parse(await readFile(join(stock, "tui.json"), "utf8")).plugin, ["some-user-tui"]);
    const oc = JSON.parse(await readFile(join(stock, "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(oc.mcp), ["playwright"]);
    // Machine config moved, not lost.
    assert.equal(await readFile(join(home, ".config", "supracortex", "config.jsonc"), "utf8"), '{"jev":{"provider":"laya-local"}}');
    assert.ok(r.backups.length >= 5);
    for (const b of r.backups) assert.ok(existsSync(b));

    assert.deepEqual(await stockPollution(env), []);
    const again = await migrateOutOfStock({ brandTui: BRAND, env });
    assert.equal(again.removed.length + again.edited.length, 0, "idempotent");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ensureProfile replaces a brand TUI entry from an old checkout location", async () => {
  const { mkdtemp, mkdir: mk, writeFile: wf, readFile: rf } = await import("node:fs/promises");
  const { tmpdir: td } = await import("node:os");
  const { join: j } = await import("node:path");
  const h = await mkdtemp(j(td(), "sc-brand-"));
  const env = { HOME: h };
  const paths = profilePaths(env);
  await mk(paths.opencodeConfig, { recursive: true });
  await wf(j(paths.opencodeConfig, "tui.json"), JSON.stringify({ plugin: ["/old/supracortex-jev-preview/packages/tui", "some-user-tui"] }));
  await ensureProfile({ ...CONTENTS, brandTui: "/new/supracortex/packages/tui" }, env);
  const tui = JSON.parse(await rf(j(paths.opencodeConfig, "tui.json"), "utf8"));
  assert.deepEqual(tui.plugin, ["some-user-tui", "/new/supracortex/packages/tui"]);
});
