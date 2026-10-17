import { lstat, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants, statfsSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname, join, sep } from "node:path";
import { PACKAGE_VERSION } from "../../../../src/version.ts";
import { redactSecrets, resolveProjectStorageDirectory } from "../memory/validation.ts";
import { openRegularFile, resolveConfinedPath } from "../storage/safe-path.ts";

export type DiagnosticStatus = "pass" | "warn" | "fail" | "skip";
export type Evidence = "verified" | "configured" | "unknown";
export interface DiagnosticCheck { id: string; title: string; status: DiagnosticStatus; evidence: Evidence; detail: string; data?: Record<string, unknown>; }
export interface DiagnosticInput { projectRoot: string; config: any; configSource?: string; tools?: string[]; timeoutMs?: number; }
export interface TailRecord { value?: any; raw: string; valid: boolean; line: number; }
export interface TailResult { records: TailRecord[]; corrupt: number; timedOut: boolean; processed: number; error?: string; }

const CAP = 2000;
/** Deliberately bounded: enough for large JSONL records while making status/doctor I/O finite. */
export const TAIL_BYTE_CAP = 4 * 1024 * 1024;
const errno = (e: unknown) => e as NodeJS.ErrnoException;
const clean = (s: string, root?: string) => {
  let text = redactSecrets(s).text;
  const home = process.env.HOME;
  if (root) {
    const rr = resolve(root);
    text = text.replace(new RegExp(`(?<![A-Za-z0-9_])${rr.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?=\\b|[/\\\\])`, "g"), ".");
  }
  return text.replace(/(?:[A-Za-z]:)?(?:[/\\][^\s"']+)+/g, (p) => {
    if (root) { const r = relative(resolve(root), resolve(p)); if (r && !r.startsWith("..") && !isAbsolute(r)) return r; }
    if (home && resolve(p).startsWith(resolve(home) + sep)) return "[REDACTED_PATH]";
    return "[REDACTED_PATH]";
  });
};
const safeValue = (v: unknown, root: string): unknown => typeof v === "string" ? clean(v.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_SECRET]"), root) : Array.isArray(v) ? v.map(x => safeValue(x, root)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safeValue(x, root)])) : v;

async function safeExistingPath(root: string, target: string): Promise<void> {
  await resolveConfinedPath(root, target);
}

async function openVerified(file: string, root?: string): Promise<FileHandle> {
  const physical = root ? await resolveConfinedPath(root, file) : file;
  return openRegularFile(physical, constants.O_RDONLY);
}

/** Read at most the final TAIL_BYTE_CAP bytes, without following symlinks. */
export async function readJsonlTail(file: string, timeoutMs = 2000, root?: string): Promise<TailResult> {
  let handle: FileHandle | undefined; let timer: NodeJS.Timeout | undefined; let timedOut = false;
  try {
    handle = await openVerified(file, root);
    const opened = await handle.stat();
    timer = setTimeout(() => { timedOut = true; void handle?.close(); }, timeoutMs); timer.unref?.();
    const start = Math.max(0, opened.size - TAIL_BYTE_CAP); const length = opened.size - start;
    const buf = Buffer.alloc(length); let got = 0;
    while (got < length) {
      if (timedOut) throw new Error("read timed out");
      const r = await handle.read(buf, got, length - got, start + got); got += r.bytesRead; if (!r.bytesRead) break;
    }
    let text = buf.toString("utf8"); if (start > 0) { const n = text.indexOf("\n"); text = n < 0 ? "" : text.slice(n + 1); }
    const lines = text.split(/\r?\n/).filter(Boolean); const selected = lines.slice(-CAP);
    let corrupt = 0; const records: TailRecord[] = [];
    selected.forEach((raw, i) => { try { records.push({ value: JSON.parse(raw), raw, valid: true, line: i + 1 }); } catch { corrupt++; records.push({ raw, valid: false, line: i + 1 }); } });
    return { records, corrupt, timedOut, processed: selected.length };
  } catch (e) { return { records: [], corrupt: 0, timedOut, processed: 0, error: errno(e).code === "ENOENT" ? undefined : clean((e as Error).message) }; }
  finally { if (timer) clearTimeout(timer); if (handle) await handle.close().catch(() => undefined); }
}

export async function safeReadFile(root: string, file: string, encoding: BufferEncoding = "utf8"): Promise<string> {
  let handle: FileHandle | undefined;
  try { handle = await openVerified(file, root); return (await handle.readFile({ encoding })) as string; }
  finally { await handle?.close().catch(() => undefined); }
}

async function tail(root: string, storage: string, file: string, timeout: number) { const p = resolve(storage, file); const result = await readJsonlTail(p, timeout, root); return { result, file: relative(root, p) || "." }; }

// ---------------------------------------------------------------------------
// Storage footprint + disk headroom
// ---------------------------------------------------------------------------

/** Defensive caps: bound the walk so doctor I/O stays finite. */
const FOOTPRINT_ENTRY_CAP = 50_000;
const FOOTPRINT_DEPTH_CAP = 32;

export interface FootprintFsStats { size: number; isDirectory(): boolean; isSymbolicLink(): boolean; }
export interface FootprintFs {
  readdir(dir: string): Promise<string[]>;
  lstat(path: string): Promise<FootprintFsStats>;
  statfs(path: string): { bsize: number; blocks: number; bavail: number };
}

export interface FootprintReport {
  totalBytes: number;
  /** Bytes by top-level subdirectory name (files directly in the root are not bucketed). */
  subdirs: Array<{ name: string; bytes: number }>;
  truncated: boolean;
  /** Filesystem capacity for the storage path, or null if statfs failed. */
  fs: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
}

/** Dependency-injectable fs for tests. */
export const defaultFootprintFs: FootprintFs = {
  readdir: (dir: string) => readdir(dir),
  lstat: (path: string) => lstat(path),
  statfs: (path: string) => statfsSync(path) as unknown as { bsize: number; blocks: number; bavail: number },
};

/**
 * Compute the recursive on-disk size of `target` and the filesystem headroom for
 * it. Single walk, no symlink following, capped defensively. Tolerates a
 * missing target (reports 0 bytes). Never throws.
 */
export async function computeStorageFootprint(
  target: string,
  fs: FootprintFs = defaultFootprintFs,
  entryCap: number = FOOTPRINT_ENTRY_CAP,
): Promise<FootprintReport> {
  const subdirBytes = new Map<string, number>();
  let total = 0;
  let count = 0;
  let truncated = false;

  const walk = async (dir: string, topSubdir: string | null, depth: number): Promise<void> => {
    if (depth > FOOTPRINT_DEPTH_CAP) { truncated = true; return; }
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return; // missing or unreadable directory -> counts as zero
    }
    for (const name of names) {
      if (count >= entryCap) { truncated = true; return; }
      count++;
      const p = join(dir, name);
      let st: FootprintFsStats;
      try {
        st = await fs.lstat(p);
      } catch {
        continue; // vanished/permission-denied entry
      }
      if (st.isSymbolicLink()) continue; // never follow symlinks out of the tree
      if (st.isDirectory()) {
        await walk(p, topSubdir ?? name, depth + 1);
      } else {
        total += st.size;
        if (topSubdir !== null) subdirBytes.set(topSubdir, (subdirBytes.get(topSubdir) ?? 0) + st.size);
      }
    }
  };

  await walk(target, null, 0);

  let fsInfo: FootprintReport["fs"] = null;
  try {
    const s = await fs.statfs(target);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const usedPercent = totalBytes > 0 ? (100 * (totalBytes - freeBytes)) / totalBytes : 0;
    fsInfo = { totalBytes, freeBytes, usedPercent };
  } catch {
    // statfs unavailable (e.g. unsupported path) -> null
  }

  const subdirs = [...subdirBytes.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { totalBytes: total, subdirs, truncated, fs: fsInfo };
}

/** Disk usage% thresholds: warn >= 85, fail >= 95. */
export const FS_WARN_PERCENT = 85;
export const FS_FAIL_PERCENT = 95;

export async function footprintCheck(
  storage: string,
  root: string,
  fs: FootprintFs = defaultFootprintFs,
  warnPercent: number = FS_WARN_PERCENT,
  failPercent: number = FS_FAIL_PERCENT,
): Promise<DiagnosticCheck> {
  const report = await computeStorageFootprint(storage, fs);
  const subdirSummary = report.subdirs.length
    ? report.subdirs.map((s) => `${clean(s.name, root)}=${s.bytes}`).join(", ")
    : "none";
  let status: DiagnosticStatus = "pass";
  const fsPercent = report.fs?.usedPercent;
  if (fsPercent !== undefined && fsPercent !== null) {
    if (fsPercent >= failPercent) status = "fail";
    else if (fsPercent >= warnPercent) status = "warn";
  }
  const truncatedLabel = report.truncated ? " (footprint truncated)" : "";
  const fsInfo = report.fs
    ? `; fs free ${report.fs.freeBytes}B / ${report.fs.totalBytes}B (${report.fs.usedPercent.toFixed(1)}% used)`
    : "; filesystem info unavailable";
  return {
    id: "storage-footprint",
    title: "Storage footprint & disk headroom",
    status,
    evidence: "verified",
    detail: clean(`storage ${report.totalBytes}B${truncatedLabel}; subdirs ${subdirSummary}${fsInfo}`, root),
    data: {
      totalBytes: report.totalBytes,
      subdirs: report.subdirs,
      truncated: report.truncated,
      fs: report.fs,
    },
  };
}

export async function runDiagnostics(input: DiagnosticInput): Promise<DiagnosticCheck[]> {
  const root = resolve(input.projectRoot); const timeout = input.timeoutMs ?? 2000; const cfg = input.config ?? {}; const checks: DiagnosticCheck[] = [];
  checks.push({ id: "environment", title: "Environment", status: "pass", evidence: "verified", detail: `Node ${process.versions.node}; SupraCortex ${PACKAGE_VERSION}; ${process.platform}` });
  checks.push({ id: "config-resolution", title: "Configuration", status: "pass", evidence: "configured", detail: `source ${input.configSource ? relative(root, input.configSource) : "defaults"}; integration ${cfg.enabled ? "enabled" : "disabled"}` });
  const configured = String(cfg.storage?.directory ?? ".supracortex");
  let storage: string | undefined;
  try { storage = resolveProjectStorageDirectory(root, configured); await safeExistingPath(root, storage); } catch (e) { checks.push({ id: "storage-evidence", title: "Storage evidence", status: "fail", evidence: "unknown", detail: clean((e as Error).message, root) }); }
  if (storage) {
    // An existing evidence location is materially different from evidence that
    // is absent.  Inspect the known event stream so directories, FIFOs, and
    // other read errors cannot be reported as an innocent conservative skip.
    const eventFile = resolve(storage, "events/events.jsonl");
    const eventResult = await readJsonlTail(eventFile, timeout, root);
    if (eventResult.error) {
      const eventParent = resolve(storage, "events");
      let exists = false;
      try { await lstat(eventParent); exists = true; } catch (e) { if (errno(e).code !== "ENOENT") exists = true; }
      if (exists && eventResult.error !== undefined) {
        checks.push({ id: "storage-evidence", title: "Storage evidence", status: "fail", evidence: "unknown", detail: clean(`read failed (${relative(root, eventFile)}): ${eventResult.error}`, root) });
      } else {
        checks.push({ id: "storage-evidence", title: "Storage evidence", status: "skip", evidence: "unknown", detail: "runtime evidence unavailable under conservative read policy" });
      }
    } else if (eventResult.corrupt > 0) {
      checks.push({ id: "storage-evidence", title: "Storage evidence", status: "warn", evidence: "verified", detail: clean(`event evidence readable with ${eventResult.corrupt} corrupt lines`, root), data: { count: eventResult.records.filter(r => r.valid).length, corrupt: eventResult.corrupt } });
    } else {
      checks.push({ id: "storage-evidence", title: "Storage evidence", status: "pass", evidence: "verified", detail: "event evidence readable", data: { count: eventResult.records.filter(r => r.valid).length, corrupt: 0 } });
    }
    checks.push({ id: "lifecycle-events", title: "Lifecycle events observed", status: "skip", evidence: "unknown", detail: "event names are not interpreted by the bounded diagnostic tail" });
    checks.push({ id: "outcome-capture", title: "Outcome capture evidence", status: "skip", evidence: "unknown", detail: "outcome evidence is not interpreted by the bounded diagnostic tail" });
    checks.push(await footprintCheck(storage, root));
  }
  const tools = input.tools; checks.push({ id: "tools-configured", title: "Tools configured", status: tools?.length ? "pass" : "skip", evidence: tools?.length ? "configured" : "unknown", detail: tools?.length ? `${tools.length} adapter tool definitions supplied` : "adapter registry unavailable", data: tools ? { tools } : { tools: "unknown" } }); return checks;
}

export function sanitizeDiagnostics(checks: DiagnosticCheck[], projectRoot: string): DiagnosticCheck[] { return checks.map(c => safeValue(c, resolve(projectRoot)) as DiagnosticCheck); }

// ---------------------------------------------------------------------------
// Honest health helpers (spec 7b): freshness + handshake display primitives.
// Pure functions so status/doctor share identical thresholds.
// ---------------------------------------------------------------------------

/** Hours after which last-injection freshness is reported STALE. */
export const HEALTH_STALE_AFTER_HOURS = 48;
/** Handshake round-trip at/above this budget is flagged slow, never hung. */
export const HANDSHAKE_SLOW_MS = 15_000;
/** Hard budget for a single handshake attempt (ZCode parity). */
export const HANDSHAKE_BUDGET_MS = 15_000;
/** JSON-RPC "still booting" error: retry with backoff instead of failing. */
export const STILL_BOOTING_CODE = -32001;
/** Pinned handshake era (SDK v1.29 legacy `initialize`): no fallback. */
export const HANDSHAKE_PROTOCOL_VERSION = "2024-11-05";

/** Whole hours between now and an ISO timestamp; null when never/absent. */
export function freshnessHours(nowMs: number, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 3_600_000));
}

export function isStaleFreshness(hours: number | null): boolean {
  return hours !== null && hours > HEALTH_STALE_AFTER_HOURS;
}

/** Display for freshness: "never", "3h", or "72h (STALE)". */
export function formatFreshness(hours: number | null): string {
  if (hours === null) return "never";
  return isStaleFreshness(hours) ? `${hours}h (STALE)` : `${hours}h`;
}

/** Display for a handshake round-trip; slow round-trips are flagged, not hung. */
export function formatHandshake(ms: number | null, ok: boolean): string {
  if (ms === null) return ok ? "ok (not measured)" : "not measured";
  const slow = ms >= HANDSHAKE_SLOW_MS;
  return ok ? (slow ? `${ms}ms (slow)` : `${ms}ms`) : `${ms}ms (failed)`;
}
