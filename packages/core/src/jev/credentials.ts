/**
 * Decision-provider credential resolution.
 *
 * Order (first non-empty value wins):
 *   1. the process environment (`process.env[name]`)
 *   2. an explicitly configured env file (`jev.credentialsFile`)
 *   3. the conventional per-user files `~/.config/supracortex/*.env`
 *      (what `supracode jev key` writes)
 *   4. the OpenCode / SupraCode login for the matching provider
 *      (`opencode auth login` -> <XDG_DATA_HOME>/opencode/auth.json), so a
 *      user already logged in to OpenRouter needs no separate key
 *   5. well-known system files for bundled providers (`/etc/laya/laya.env`)
 *
 * A dedicated SupraCortex key (1-3) wins over the shared login (4) so Jev can
 * use a different OpenRouter key than the coding model if desired.
 *
 * Why: a key that only exists in an interactive shell's rc file is invisible
 * to an OpenCode server started any other way, which silently turned the
 * decision layer off. Files are PARSED, never executed or sourced, and only the
 * single requested variable is read. Values are never logged.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const USER_CREDENTIALS_DIR = join(homedir(), ".config", "supracortex");
export const SYSTEM_CREDENTIAL_FILES: readonly string[] = ["/etc/laya/laya.env"];

/** Credential env var -> OpenCode auth.json provider id. */
export const OPENCODE_LOGIN_PROVIDERS: Readonly<Record<string, string>> = {
  OPENROUTER_API_KEY: "openrouter",
};

/** OpenCode's auth store (shared by stock OpenCode and SupraCode). */
export function opencodeAuthFile(env: Record<string, string | undefined> = process.env): string {
  const data = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "share");
  return join(data, "opencode", "auth.json");
}

/** API key stored by `opencode auth login` for `provider`, if any. */
export function readOpencodeLogin(provider: string, file: string): string | undefined {
  const text = readSmallFile(file);
  if (text === undefined) return undefined;
  try {
    const entry = (JSON.parse(text) as Record<string, { type?: string; key?: unknown }>)[provider];
    return entry?.type === "api" && typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : undefined;
  } catch {
    return undefined;
  }
}

const MAX_FILE_BYTES = 64 * 1024;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse one `NAME=value` assignment from dotenv/shell-style text. */
export function readEnvAssignment(text: string, name: string): string | undefined {
  if (!NAME_RE.test(name)) return undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match || match[1] !== name) continue;
    let value = match[2]!.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    return value || undefined;
  }
  return undefined;
}

function readSmallFile(path: string): string | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function fromEnvFile(file: string, name: string): string | undefined {
  const text = readSmallFile(file);
  return text === undefined ? undefined : readEnvAssignment(text, name)?.trim() || undefined;
}

function userEnvFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".env"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export interface CredentialLookup {
  env?: Record<string, string | undefined>;
  credentialsFile?: string;
  /** Test seams. */
  userDir?: string;
  systemFiles?: readonly string[];
  /** OpenCode auth.json path; "" disables the login fallback. */
  opencodeAuth?: string;
}

export interface ResolvedCredential {
  value: string;
  /** Where it came from (a path or "env"); never the value. */
  source: string;
}

export function resolveCredential(name: string, opts: CredentialLookup = {}): ResolvedCredential | null {
  if (!name || !NAME_RE.test(name)) return null;
  const env = opts.env ?? process.env;
  const fromEnv = env[name]?.trim();
  if (fromEnv) return { value: fromEnv, source: "env" };
  const userFiles = [
    ...(opts.credentialsFile?.trim() ? [opts.credentialsFile.trim()] : []),
    ...userEnvFiles(opts.userDir ?? USER_CREDENTIALS_DIR),
  ];
  for (const file of userFiles) {
    const value = fromEnvFile(file, name);
    if (value) return { value, source: file };
  }
  const provider = OPENCODE_LOGIN_PROVIDERS[name];
  const authFile = opts.opencodeAuth ?? opencodeAuthFile(env);
  if (provider && authFile) {
    const value = readOpencodeLogin(provider, authFile);
    if (value) return { value, source: `opencode login (${provider})` };
  }
  for (const file of opts.systemFiles ?? SYSTEM_CREDENTIAL_FILES) {
    const value = fromEnvFile(file, name);
    if (value) return { value, source: file };
  }
  return null;
}

/**
 * Persist a credential in `<userDir>/<file>` (default openrouter.env), mode 600,
 * replacing only the `name=` line and preserving any other lines. Returns the
 * path. The value is validated to a single safe token; it is never logged.
 */
export function writeCredential(
  name: string,
  value: string,
  opts: { userDir?: string; file?: string } = {},
): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid variable name: ${name}`);
  const v = value.trim();
  if (!/^[A-Za-z0-9._\-:]{8,512}$/.test(v)) throw new Error("that does not look like an API key (no spaces or quotes, 8-512 chars)");
  const dir = opts.userDir ?? USER_CREDENTIALS_DIR;
  const path = join(dir, opts.file ?? "openrouter.env");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines = (readSmallFile(path) ?? "").split(/\r?\n/).filter((l) => l.trim() !== "" && !new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
  lines.push(`${name}=${v}`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

/** Remove `name=` from every user credential file. Returns files changed. */
export function removeCredential(name: string, opts: { userDir?: string } = {}): string[] {
  if (!NAME_RE.test(name)) return [];
  const changed: string[] = [];
  const re = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  for (const file of userEnvFiles(opts.userDir ?? USER_CREDENTIALS_DIR)) {
    const text = readSmallFile(file);
    if (text === undefined || !text.split(/\r?\n/).some((l) => re.test(l))) continue;
    const kept = text.split(/\r?\n/).filter((l) => !re.test(l)).join("\n");
    writeFileSync(file, kept.trim() ? `${kept.trim()}\n` : "", { encoding: "utf8", mode: 0o600 });
    changed.push(file);
  }
  return changed;
}
