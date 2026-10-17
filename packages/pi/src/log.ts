/**
 * Pi CLI logging: structured JSON lines to stderr (never stdout) plus an
 * optional per-run file sink. Every message passes core secret redaction.
 * Level from explicit set, else SUPRACORTEX_LOG_LEVEL, else "warn".
 *
 * Nothing here throws: logging must never break the agent path.
 */

import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "@local/supracortex-core";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let level: LogLevel = "warn";
let file: string | null = null;
let explicit = false;

function parseLevel(raw: string | undefined): LogLevel | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : null;
}

/** Set the level explicitly (e.g. from --log-level). */
export function setLogLevel(next: LogLevel): void {
  level = next;
  explicit = true;
}

/** Effective level (explicit > env > warn). */
export function getLogLevel(): LogLevel {
  if (explicit) return level;
  return parseLevel(process.env["SUPRACORTEX_LOG_LEVEL"]) ?? "warn";
}

/** Direct all subsequent records to a file as well as stderr. */
export function setLogFile(path: string): void {
  file = path;
}

/**
 * Mark a run boundary in the file sink, bypassing the level filter (one
 * small line per run). Guarantees `supracortex logs` finds every run, even
 * fully clean ones that emitted no warnings.
 */
export function beginRunFile(path: string, meta: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), level: "info", scope: "run", msg: "run started", data: meta });
    const target = path;
    mkdir(join(target, ".."), { recursive: true })
      .then(() => appendFile(target, `${line}\n`, "utf8"))
      .catch(() => undefined);
  } catch {
    // Logging never throws.
  }
}

function emit(recordLevel: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
  try {
    if (ORDER[recordLevel] < ORDER[getLogLevel()]) return;
    const clean = redactSecrets(String(message)).text.slice(0, 4000);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: recordLevel,
      scope,
      msg: clean,
      ...(data ? { data: JSON.parse(redactSecrets(JSON.stringify(data)).text) as unknown } : {}),
    });
    process.stderr.write(`${line}\n`);
    if (file) {
      const target = file;
      mkdir(join(target, ".."), { recursive: true })
        .then(() => appendFile(target, `${line}\n`, "utf8"))
        .catch(() => undefined);
    }
  } catch {
    // Logging never throws.
  }
}

export function logDebug(scope: string, message: string, data?: Record<string, unknown>): void {
  emit("debug", scope, message, data);
}

export function logInfo(scope: string, message: string, data?: Record<string, unknown>): void {
  emit("info", scope, message, data);
}

export function logWarn(scope: string, message: string, data?: Record<string, unknown>): void {
  emit("warn", scope, message, data);
}

export function logError(scope: string, message: string, data?: Record<string, unknown>): void {
  emit("error", scope, message, data);
}

/** Default log-file location for a run (under the service storage root). */
export function runLogPath(storagePath: string, runId: string): string {
  return join(storagePath, "cli", "logs", `${runId}.log`);
}

/** Newest run log under a storage root, for `supracortex logs`. */
export async function findLatestLog(storagePath: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(join(storagePath, "cli", "logs"));
  } catch {
    return null;
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".log")) continue;
    const path = join(storagePath, "cli", "logs", entry);
    try {
      const st = await stat(path);
      if (!newest || st.mtimeMs > newest.mtime) newest = { path, mtime: st.mtimeMs };
    } catch {
      // Vanished mid-scan; ignore.
    }
  }
  return newest?.path ?? null;
}

/** Last N lines of a log file (tail for diagnostics). */
export async function tailLog(path: string, lines = 100): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const all = raw.split("\n").filter((l) => l.trim());
  return all.slice(Math.max(0, all.length - Math.max(1, lines)));
}
