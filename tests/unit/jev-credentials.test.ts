/**
 * Jev key sources: a dedicated key (env / ~/.config/supracortex/*.env) wins;
 * otherwise the OpenRouter login OpenCode/SupraCode already has is reused.
 * `supracode jev key|forget` write/remove only our own line, mode 600.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { opencodeAuthFile, readOpencodeLogin, removeCredential, resolveCredential, writeCredential } from "../../packages/core/src/jev/credentials.ts";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sc-jevcred-"));
}

test("falls back to the OpenCode OpenRouter login; a dedicated key wins", async () => {
  const d = await dir();
  try {
    const auth = join(d, "auth.json");
    await writeFile(auth, JSON.stringify({ openrouter: { type: "api", key: "sk-or-login" }, openai: { type: "oauth", access: "x" } }));
    const userDir = join(d, "user");
    await mkdir(userDir);
    const base = { env: {}, userDir, systemFiles: [], opencodeAuth: auth };
    assert.deepEqual(resolveCredential("OPENROUTER_API_KEY", base), { value: "sk-or-login", source: "opencode login (openrouter)" });
    await writeFile(join(userDir, "openrouter.env"), "OPENROUTER_API_KEY=sk-or-dedicated\n");
    assert.equal(resolveCredential("OPENROUTER_API_KEY", base)?.value, "sk-or-dedicated");
    assert.equal(resolveCredential("OPENROUTER_API_KEY", { ...base, env: { OPENROUTER_API_KEY: "sk-env" } })?.value, "sk-env");
    assert.equal(resolveCredential("LAYA_API_KEY", base), null, "login fallback is provider-specific");
    assert.equal(resolveCredential("OPENROUTER_API_KEY", { ...base, userDir: join(d, "none"), opencodeAuth: "" }), null, "\"\" disables the login fallback");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("login reader ignores oauth entries, malformed files and missing keys", async () => {
  const d = await dir();
  try {
    const f = join(d, "auth.json");
    await writeFile(f, JSON.stringify({ openrouter: { type: "oauth", access: "t" } }));
    assert.equal(readOpencodeLogin("openrouter", f), undefined);
    await writeFile(f, "{ nope");
    assert.equal(readOpencodeLogin("openrouter", f), undefined);
    assert.equal(readOpencodeLogin("openrouter", join(d, "missing.json")), undefined);
    assert.equal(opencodeAuthFile({ XDG_DATA_HOME: "/x" }), "/x/opencode/auth.json");
    assert.equal(opencodeAuthFile({ HOME: "/h" }), "/h/.local/share/opencode/auth.json");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("writeCredential: mode 600, replaces only its own line; removeCredential undoes it", async () => {
  const d = await dir();
  try {
    await writeFile(join(d, "openrouter.env"), "# note\nOTHER=keep\nexport OPENROUTER_API_KEY=old\n");
    const path = writeCredential("OPENROUTER_API_KEY", "sk-or-v1-new", { userDir: d });
    assert.equal((statSync(path).mode & 0o777).toString(8), "600");
    const text = readFileSync(path, "utf8");
    assert.match(text, /OTHER=keep/);
    assert.match(text, /^OPENROUTER_API_KEY=sk-or-v1-new$/m);
    assert.doesNotMatch(text, /=old/);
    assert.throws(() => writeCredential("OPENROUTER_API_KEY", "has space $(x)", { userDir: d }), /does not look like an API key/);
    assert.deepEqual(removeCredential("OPENROUTER_API_KEY", { userDir: d }), [path]);
    assert.doesNotMatch(readFileSync(path, "utf8"), /OPENROUTER_API_KEY/);
    assert.match(readFileSync(path, "utf8"), /OTHER=keep/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
