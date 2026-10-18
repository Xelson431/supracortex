/**
 * supracortex CLI.
 *
 * Usage:
 *   supracortex install [--global] [--force]
 *   supracortex reinstall [--global] --yes
 *   supracortex uninstall [--keep-data | --remove-data] [--global]
 *   supracortex enable
 *   supracortex disable
 *   supracortex status [--json]
 *   supracortex doctor
 *   supracortex value-report [--json]
 *   supracortex compact
 *   supracortex snapshot
 *   supracortex inspect "<task query>"
 *   supracortex reset <cache|index|sessions|metrics|all-generated|all> --yes
 *
 * All commands operate on the current working directory as the project root
 * unless SUPRACORTEX_ROOT is set.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeDiagnostics } from "../packages/core/src/diagnostics/index.ts";
import * as cli from "../packages/opencode/src/cli-core.ts";
import * as providerCli from "../packages/opencode/src/provider-cli.ts";
import { ensureProfile, migrateOutOfStock, profilePaths, refreshConfigFarm, supracodeEnv } from "../packages/opencode/src/profile.ts";
import { verifyIsolation } from "../packages/opencode/src/isolation.ts";
import { resolvePiBin, runPi } from "../packages/pi/src/launch.ts";
import { buildSharedLayer } from "../packages/opencode/src/shared.ts";
import { findLatestLog, tailLog } from "../packages/pi/src/log.ts";
import { formatMetrics } from "../packages/core/src/index.ts";
import type { ValueSegmentStat } from "../packages/core/src/index.ts";
import { loadConfig } from "../packages/opencode/src/config-loader.ts";
import { createEngine, gatherInputs } from "../packages/opencode/src/lifecycle.ts";
import { PLUGIN_VERSION } from "../packages/opencode/src/plugin.ts";

function root(): string {
  return process.env.SUPRACORTEX_ROOT || process.cwd();
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function positiveIntAfter(flag: string): number | undefined {
  const raw = valueAfter(flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} requires a positive integer`);
  return value;
}

/** Parse repeated `--target name=path[:bare]` flags for wiring arbitrary CLIs
 * that follow the standard `mcpServers` stdio JSON convention. */
function parseTargets(): Array<{ name: string; file: string; style?: "stdio" | "bare" }> {
  const out: Array<{ name: string; file: string; style?: "stdio" | "bare" }> = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--target") continue;
    const spec = argv[i + 1];
    if (!spec || spec.startsWith("--")) continue;
    const eq = spec.indexOf("=");
    if (eq <= 0) continue;
    const name = spec.slice(0, eq);
    let file = spec.slice(eq + 1);
    let style: "stdio" | "bare" | undefined;
    if (file.endsWith(":bare")) { file = file.slice(0, -5); style = "bare"; }
    else if (file.endsWith(":stdio")) { file = file.slice(0, -6); style = "stdio"; }
    if (name && file) out.push({ name, file, ...(style ? { style } : {}) });
  }
  return out;
}

function parseAgents(): Array<"claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi"> | undefined {
  const known = new Set(["claude", "codex", "cursor", "gemini", "opencode", "pi"]);
  const agents = process.argv.filter((arg, index, argv) => argv[index - 1] === "--agent" && known.has(arg));
  return agents.length ? agents as Array<"claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi"> : undefined;
}

function log(s: string): void {
  process.stdout.write(s + "\n");
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const projectRoot = root();

  if (["install", "reinstall", "upgrade", "uninstall"].includes(cmd ?? "") || (cmd === "code-graph" && ["rebuild", "enable", "disable"].includes(process.argv[3] ?? ""))) {
    if (has("--yes")) {
      // Explicit acknowledgement is required only for mutation-capable commands.
    } else {
    log(`${cmd} is mutating and requires --yes`);
    return 2;
    }
  }

  if (cmd === undefined) {
    // Bare `supracortex`: interactive OpenCode when attached to a TTY, help
    // text otherwise (never a hanging agent session on a pipe).
    log(await usage());
    return 0;
  }

  switch (cmd) {
    case "run": {
      // Launch OpenCode with the SupraCortex server plugin + brand TUI.
      // Usage: supracode run [--no-cortex] [-- <opencode args...>]
      // Everything after `--` (or after `run` when no `--`) is forwarded to
      // OpenCode verbatim. `--pi` is a legacy alias for `supracode-pi`.
      const raw = process.argv.slice(3);
      if (raw.includes("--pi")) return runPiMain(raw.filter((arg) => arg !== "--pi"));
      return runOpenCodeMain(raw);
    }
    case "pi": {
      // SupraCode Pi: the Pi-based host (also the `supracode-pi` command).
      // Usage: supracode-pi [--no-cortex] [--log-level L] [-- <pi args...>]
      return runPiMain(process.argv.slice(3));
    }
    case "v2": {
      // Launch the pinned isolated OpenCode V2 host (aka supracode2).
      // Never substitutes V1: a missing V2 install is a hard diagnostic.
      return runV2Main(process.argv.slice(3));
    }
    case "init":
    case "upgrade": {
      const targets = parseTargets();
      const agents = parseAgents();
      const report = cmd === "init"
        ? await cli.init(projectRoot, has("--yes"), agents, targets, !has("--no-guidance"), { enable: !has("--no-enable") })
        : await cli.upgrade(projectRoot, !has("--no-guidance"));
      log(cmd === "init" && !has("--yes") ? "Init plan (no files changed):" : `${cmd === "init" ? "Init" : "Upgrade"}:`);
      for (const d of report.detections) log(`  detected: ${d.agent}${d.experimental ? " (experimental)" : ""} - ${d.reason}`);
      for (const c of report.changes) log(`  ${c.status}: ${c.file} [${c.ownedPath}]`);
      for (const n of report.notes) log(`  note: ${n}`);
      return 0;
    }
    case "install": {
      const report = await cli.install({
        projectRoot,
        global: has("--global"),
        force: has("--force"),
        enableByDefault: has("--enable"),
      });
      if (has("--global") && has("--enable")) {
        log("NOTE: --global --enable makes SupraCortex active in EVERY project");
        log("      without a local .supracortex/config.jsonc. Reversible via uninstall --global.");
      }
      log("Install:");
      for (const c of report.created) log(`  created: ${c}`);
      for (const e of report.edited) log(`  edited:  ${e}`);
      for (const s of report.skipped) log(`  skipped: ${s}`);
      for (const b of report.backups) log(`  backup:  ${b}`);
      for (const n of report.notes) log(`  note:    ${n}`);
      return 0;
    }
    case "reinstall": {
      const report = await cli.reinstall({
        projectRoot,
        global: has("--global"),
        enableByDefault: has("--enable"),
      });
      log("Reinstall (owned integration artifacts refreshed; runtime memory preserved):");
      for (const c of report.created) log(`  created: ${c}`);
      for (const e of report.edited) log(`  refreshed: ${e}`);
      for (const s of report.skipped) log(`  skipped: ${s}`);
      for (const b of report.backups) log(`  backup: ${b}`);
      for (const n of report.notes) log(`  note: ${n}`);
      return 0;
    }
    case "mcp": {
      const { runStdioMcp } = await import("../src/mcp.ts");
      await runStdioMcp(projectRoot);
      return 0;
    }
    case "uninstall": {
      const keepData = has("--keep-data") || !has("--remove-data");
      if (!has("--keep-data") && !has("--remove-data")) {
        log("Specify --keep-data or --remove-data. Defaulting to --keep-data.");
      }
      const report = await cli.uninstall({ projectRoot, keepData, global: has("--global") });
      log("Uninstall:");
      for (const r of report.removed) log(`  removed: ${r}`);
      for (const k of report.kept) log(`  kept:    ${k}`);
      for (const e of report.edited) log(`  edited:  ${e}`);
      for (const n of report.notes) log(`  note:    ${n}`);
      return 0;
    }
    case "migrate": {
      // Remove SupraCortex from STOCK OpenCode (~/.config/opencode). Dry run
      // unless --yes; every change is backed up.
      const report = await migrateOutOfStock({ dryRun: !has("--yes"), brandTui: (await cli.profileContents()).brandTui });
      const verb = report.dryRun ? "would" : "did";
      if (!report.removed.length && !report.edited.length) log("stock OpenCode is clean; nothing to migrate.");
      for (const p of report.removed) log(`${verb} remove  ${p}`);
      for (const p of report.edited) log(`${verb} edit    ${p}`);
      for (const n of report.notes) log(`  - ${n}`);
      if (report.dryRun && (report.removed.length || report.edited.length)) log("re-run with --yes to apply.");
      return 0;
    }
    case "connect":
    case "disconnect": {
      // supracode connect <codex|claude|generic|all>   (disconnect: reverse)
      const { connect, CONNECT_HOSTS } = await import("../packages/opencode/src/connect.ts");
      const target = process.argv[3] ?? "";
      const hosts = target === "all" ? (["codex", "claude"] as const) : (CONNECT_HOSTS as readonly string[]).includes(target) ? [target as (typeof CONNECT_HOSTS)[number]] : [];
      if (!hosts.length) {
        log(`Usage: supracortex ${cmd} <codex|claude|generic|all>`);
        return 2;
      }
      let failed = false;
      for (const host of hosts) {
        const r = await connect(host, { remove: cmd === "disconnect" });
        failed ||= !r.ok;
        log(`${r.ok ? "ok " : "ERR"} ${host.padEnd(7)} ${r.action}: ${r.detail}`);
        if (r.snippet) log(r.snippet);
      }
      if (cmd === "connect" && !failed) log("Restart the host so it loads the server. SupraCortex uses the host's working directory as the project.");
      return failed ? 1 : 0;
    }
    case "config": {
      // supracode config [path|show|migrate [--yes] [--root DIR]]
      const sub = process.argv[3] ?? "path";
      if (sub === "path") {
        log(`central  ${(await import("../packages/opencode/src/config-loader.ts")).globalConfigPath()}`);
        return 0;
      }
      if (sub === "show") {
        const loaded = await loadConfig({ projectRoot, env: process.env });
        const flat: Record<string, unknown> = {};
        const walk = (o: Record<string, unknown>, p = ""): void => {
          for (const [k, v] of Object.entries(o)) {
            const q = p ? `${p}.${k}` : k;
            if (v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, q);
            else flat[q] = v;
          }
        };
        walk(loaded.config as unknown as Record<string, unknown>);
        // Only live feature switches: deprecated no-op keys and privacy guards
        // (storeConversationText must stay false) are not "disabled features".
        const { DEPRECATED_UNIMPLEMENTED_PATHS } = await import("../packages/core/src/config.ts");
        const notFeatures = new Set<string>([...DEPRECATED_UNIMPLEMENTED_PATHS, "privacy.storeConversationText", "storage.commitDurableMemory"]);
        const off = Object.entries(flat).filter(([k, v]) => v === false && !notFeatures.has(k)).map(([k]) => k);
        log(`central config   ${loaded.globalConfigPath}${loaded.globalConfigExists ? "" : " (absent: all defaults)"}`);
        log(`project file     ${loaded.projectConfigExists ? loaded.projectConfigPath : "none (follows central)"}`);
        log(`storage driver   ${loaded.config.storage.driver} (${loaded.storageDriverSource})`);
        log(`enabled          ${loaded.config.enabled} (${loaded.reason})`);
        log(`features off     ${off.length ? off.join(", ") : "none — every feature is on"}`);
        {
          // Decision provider: real health request only with --check (show is
          // otherwise offline); state mirrors what a session would do.
          const { resolveDecisionProvider, resolveCredential } = await import("../packages/core/src/index.ts");
          const jev = loaded.config.jev;
          const p = resolveDecisionProvider(jev);
          const cred = p.apiKeyEnv ? resolveCredential(p.apiKeyEnv, { credentialsFile: jev.credentialsFile }) : null;
          let state: string;
          if (!jev.enabled) state = "disabled -> deterministic context";
          else if (p.requireAuth && !cred) state = `no key (${p.apiKeyEnv}) -> deterministic context`;
          else if (has("--check")) {
            const c = await providerCli.providerCheck(projectRoot, 8_000);
            state = c.ok ? `ACTIVE (health ${c.latencyMs}ms)` : `UNREACHABLE (${c.reason}) -> deterministic context`;
          } else state = "key found; health checked at session start (add --check to test now)";
          log(`decisions        ${p.id} ${p.model}: ${state}`);
        }
        if (loaded.ignoredProjectKeys.length) log(`IGNORED project keys (config is central): ${loaded.ignoredProjectKeys.join(", ")}`);
        return 0;
      }
      if (sub === "migrate") {
        // Default scope: every sibling project under the parent of this repo
        // plus the current project. --root DIR scans DIR's children instead.
        const { readdirSync, existsSync: ex } = await import("node:fs");
        const scanRoot = valueAfter("--root") ?? dirname(projectRoot);
        const roots = new Set<string>([projectRoot]);
        for (const name of readdirSync(scanRoot)) {
          const dir = join(scanRoot, name);
          if (ex(join(dir, ".supracortex", "config.jsonc"))) roots.add(dir);
        }
        const apply = has("--yes");
        const results = await cli.migrateProjectConfigs([...roots].sort(), apply);
        if (!results.length) { log("no project config files found."); return 0; }
        for (const r of results) {
          const verb = r.action === "removed" ? (apply ? "removed " : "would remove ") : r.action === "reduced" ? (apply ? "reduced " : "would reduce ") : "kept    ";
          log(`${verb}${r.project}${r.ignored.length ? `  (${r.ignored.length} centrally-managed keys)` : ""}${Object.keys(r.kept).length ? `  keeps ${JSON.stringify(r.kept)}` : ""}`);
        }
        if (!apply) log("dry run — re-run with --yes to apply (backups are written first).");
        else log(`backups: ${results.find((r) => r.backup)?.backup ? dirname(results.find((r) => r.backup)!.backup!) : "none needed"}`);
        return 0;
      }
      log(`unknown config subcommand "${sub}" (path|show|migrate)`);
      return 2;
    }
    case "profile": {
      // supracode profile [init|path|verify]
      const sub = process.argv[3] ?? "path";
      const paths = profilePaths();
      if (sub === "path") {
        log(`opencode config  ${paths.opencodeConfig}`);
        log(`xdg farm         ${paths.farm}`);
        log(`stock opencode   ${paths.stockConfig}`);
        const sh = buildSharedLayer(paths);
        log(`shared layer     ${sh.configFile}`);
        log(`  mcp            ${sh.mcp.join(", ") || "none"}`);
        log(`  providers      ${sh.provider.join(", ") || "none"}`);
        log(`  skills         ${sh.skills.join(", ") || "none"}`);
        if (sh.shadowedByProfile.length) log(`  profile wins   ${sh.shadowedByProfile.join(", ")}`);
        if (sh.excluded.length) log(`  never shared   ${sh.excluded.join(", ")} (+ all stock plugins, agents, commands)`);
        for (const w of sh.warnings) log(`  ! ${w}`);
        return 0;
      }
      if (sub === "init") {
        const r = await ensureProfile(await cli.profileContents());
        refreshConfigFarm(paths);
        for (const p of r.created) log(`created ${p}`);
        for (const p of r.edited) log(`updated ${p}`);
        for (const n of r.notes) log(`  - ${n}`);
        if (!r.created.length && !r.edited.length) log("profile up to date.");
        return 0;
      }
      if (sub === "verify") {
        const v = await verifyIsolation({ bin: process.env.OPENCODE_BIN?.trim() || "opencode" });
        if (has("--json")) { log(JSON.stringify(v, null, 2)); return v.ok ? 0 : 1; }
        for (const side of [v.stock, v.supracode]) {
          log(`${side.label.padEnd(10)} ${side.ms}ms  plugins=[${side.plugins.join(", ")}]  mcp=[${side.mcp.join(", ")}]  agents=${side.agents.length}  commands=${side.commands.length}`);
        }
        if (v.shared) log(`shared     mcp=[${v.shared.mcp.join(", ")}]  providers=[${v.shared.provider.join(", ")}]  skills=${v.shared.skills.length}`);
        for (const p of v.problems) log(`  ! ${p}`);
        log(v.ok ? "profile OK (plugins isolated, MCP/providers/skills shared)" : "profile FAILED");
        return v.ok ? 0 : 1;
      }
      log(`unknown profile subcommand "${sub}" (path|init|verify)`);
      return 2;
    }
    case "jev": {
      // supracortex jev [status|key [KEY|-]|forget|login|test]
      // Where Jev's OpenRouter key comes from, and a way to set it.
      const core = await import("../packages/core/src/index.ts");
      const sub = process.argv[3] ?? "status";
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const p = core.resolveDecisionProvider(loaded.config.jev);
      const name = p.apiKeyEnv || "OPENROUTER_API_KEY";
      const describe = (): void => {
        const cred = core.resolveCredential(name, { credentialsFile: loaded.config.jev.credentialsFile });
        const src = !cred ? "none" : cred.source === "env" ? `environment (${name})` : cred.source;
        log(`provider   ${p.id} ${p.model}`);
        log(`key        ${cred ? `set — from ${src}` : `not set -> deterministic context`}`);
        log(`lookup     1) ${name} env  2) ${core.USER_CREDENTIALS_DIR}/*.env  3) OpenCode/OpenCode OpenRouter login  4) system files`);
      };
      if (sub === "status") {
        describe();
        const c = await providerCli.providerCheck(projectRoot, 8_000);
        log(`health     ${c.ok ? `ACTIVE (${c.latencyMs}ms)` : `not active (${c.reason})`}`);
        return 0;
      }
      if (sub === "key") {
        // Value from argv, or stdin with `-` / when piped (keeps it out of shell history).
        let value = process.argv[4];
        if (!value || value === "-") {
          if (process.stdin.isTTY && !value) {
            log("usage: supracortex jev key <OPENROUTER_KEY>   (or: echo $KEY | supracortex jev key -)");
            return 2;
          }
          value = (await new Promise<string>((res) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); })).trim();
        }
        let path: string;
        try {
          path = core.writeCredential(name, value);
        } catch (err) {
          log(`jev key: ${(err as Error).message}`);
          return 1;
        }
        log(`saved ${name} to ${path} (mode 600)`);
        const c = await providerCli.providerCheck(projectRoot, 8_000);
        log(c.ok ? `health     ACTIVE (${c.latencyMs}ms). New sessions use Jev.` : `health     FAILED (${c.reason}). Key kept; check it at https://openrouter.ai/settings/keys`);
        return c.ok ? 0 : 1;
      }
      if (sub === "forget") {
        const files = core.removeCredential(name);
        log(files.length ? `removed ${name} from ${files.join(", ")}` : `no saved ${name} in ${core.USER_CREDENTIALS_DIR}`);
        describe();
        return 0;
      }
      if (sub === "login") {
        // Use the OpenRouter login OpenCode/SupraCode already has.
        const auth = core.opencodeAuthFile();
        const has = !!core.readOpencodeLogin("openrouter", auth);
        if (!has) {
          log(`no OpenRouter login in ${auth}. Run: opencode auth login  (choose OpenRouter), then: supracode jev login`);
          return 1;
        }
        const files = core.removeCredential(name);
        if (files.length) log(`removed dedicated key from ${files.join(", ")} so the login is used`);
        if (process.env[name]) log(`note: ${name} is exported in this shell and still wins; remove it from your shell rc to use the login`);
        describe();
        const c = await providerCli.providerCheck(projectRoot, 8_000, { ...process.env, [name]: "" });
        log(`health     ${c.ok ? `ACTIVE (${c.latencyMs}ms)` : `FAILED (${c.reason})`}`);
        return c.ok ? 0 : 1;
      }
      if (sub === "test") {
        const c = await providerCli.providerCheck(projectRoot, 8_000);
        log(c.ok ? `ACTIVE (${c.latencyMs}ms, model ${c.echoedModel ?? p.model})` : `not active: ${c.reason}`);
        return c.ok ? 0 : 1;
      }
      log("usage: supracortex jev [status|key <KEY>|key -|forget|login|test]");
      return 2;
    }
    case "provider": {
      // supracode provider [list|show|use <id>|check] [--project] [--endpoint URL] [--model ID] [--json]
      const sub = process.argv[3] ?? "show";
      const asJson = has("--json");
      if (sub === "list") {
        const rows = providerCli.providerList();
        if (asJson) log(JSON.stringify(rows, null, 2));
        else for (const r of rows) log(`${r.id.padEnd(12)} ${r.label}\n${"".padEnd(12)} ${r.model} @ ${r.endpoint} (key: ${r.apiKeyEnv || "none"})`);
        return 0;
      }
      if (sub === "show") {
        const s = await providerCli.providerShow(projectRoot);
        if (asJson) { log(JSON.stringify(s, null, 2)); return 0; }
        log(`provider   ${s.provider} (${s.label})${s.enabled ? "" : "  [decisions disabled]"}`);
        log(`endpoint   ${s.endpoint}`);
        log(`model      ${s.model}`);
        log(`credential ${s.credential}${s.apiKeyEnv ? ` (${s.apiKeyEnv}${s.credentialSource ? ` from ${s.credentialSource === "env" ? "environment" : s.credentialSource}` : ""})` : ""}`);
        log(`budget     deadline ${s.deadlineMs}ms, per-request ${s.enrichmentBudgetMs}ms`);
        log(`config     central ${s.configSource.global}${s.configSource.ignoredProjectKeys.length ? `\n           ignored stale project keys: ${s.configSource.ignoredProjectKeys.join(", ")} (run 'supracortex config migrate --yes')` : ""}`);
        return 0;
      }
      if (sub === "use") {
        const id = process.argv[4];
        if (!id || id.startsWith("--")) { log("usage: supracortex provider use <jev|laya-local|laya-hosted|custom> [--endpoint URL] [--model ID]"); return 2; }
        try {
          const r = await providerCli.providerUse(projectRoot, id, { endpoint: valueAfter("--endpoint"), model: valueAfter("--model") });
          log(`decision provider -> ${r.provider} (${r.path})`);
          for (const n of r.notes) log(`  - ${n}`);
          return 0;
        } catch (err) {
          log(`provider use failed: ${(err as Error).message}`);
          return 1;
        }
      }
      if (sub === "check") {
        const r = await providerCli.providerCheck(projectRoot, positiveIntAfter("--timeout-ms") ?? 15_000);
        if (asJson) log(JSON.stringify(r, null, 2));
        else log(r.ok ? `ok  ${r.provider}  ${r.latencyMs}ms  model=${r.echoedModel}  input_tokens=${r.inputTokens ?? "?"}` : `FAIL ${r.provider}  ${r.latencyMs}ms  ${r.reason}`);
        return r.ok ? 0 : 1;
      }
      log(`unknown provider subcommand "${sub}" (list|show|use|check)`);
      return 2;
    }
    case "enable": {
      const r = await cli.setEnabled(projectRoot, true);
      log(`Enabled -> ${r.configPath}`);
      for (const n of r.notes) log(`  ${n}`);
      return 0;
    }
    case "disable": {
      const r = await cli.setEnabled(projectRoot, false);
      log(`Disabled -> ${r.configPath}`);
      for (const n of r.notes) log(`  ${n}`);
      return 0;
    }
    case "status": {
      const s = await cli.status(projectRoot, { checkHandshake: has("--check-handshake") });
      const safe = sanitizeDiagnostics([{ id: "status", title: "Status", status: s.lastError ? "fail" : "pass", evidence: "unknown", detail: JSON.stringify(s), data: s as unknown as Record<string, unknown> }], projectRoot)[0]!;
      if (has("--json")) {
        log(JSON.stringify(safe.data, null, 2));
      } else {
        log(`SupraCortex ${s.version}`);
        log(`  active:        ${s.active}`);
        log(`  state:         ${s.state}`);
        log(`  reason:        ${s.reason} (${s.shouldInjectReason})`);
        log(`  source:        ${s.source}`);
        log(`  config:        ${safe.data?.configPath} (${s.configExists ? "exists" : "missing"})`);
        log(`  storage:       ${safe.data?.storagePath} (${s.storageBytes === undefined ? "unknown" : formatBytes(s.storageBytes)})`);
        log(`  memory:        ${JSON.stringify(s.memoryCounts)}`);
        const byStatus = Object.entries(s.memoryEntries.byStatus).map(([status, count]) => `${status} ${count}`).join(", ");
        log(`  memory entries: ${s.memoryEntries.total}${byStatus ? ` (${byStatus})` : ""}`);
        log(`  cache entries: ${s.cacheEntries}`);
        log(`  index:         ${s.indexFreshness}`);
        log(`  active tasks:  ${s.activeTasks}`);
        log(`  last inject:   ${s.lastInjectionAt ?? "never"} (${s.freshnessHours === null ? "never" : `${s.freshnessHours}h`}${s.stale ? ", STALE>48h" : ""})`);
        log(`  last sweep:    ${s.lastSweepAt ?? "never"}`);
        log(`  handshake:     ${s.handshakeMs === null ? s.handshakeDetail : `${s.handshakeMs}ms${s.handshakeSlow ? " (slow)" : ""}`}`);
        log(`  aliases:       ${s.aliases.map((a) => `${a.alias}->${a.tool}`).join(", ")}`);
        log(`  last error:    ${safe.data?.lastError ?? "none"}`);
        if (s.configWarnings.length) {
          log(`  config warnings: ${((safe.data?.configWarnings as string[] | undefined) ?? []).join("; ")}`);
        }
      }
      return s.lastError ? 1 : 0;
    }
    case "doctor": {
      if (has("--fix")) {
        const r = await cli.doctorFix(projectRoot, { global: has("--global") });
        log(`Doctor --fix (${r.durationMs}ms / budget ${r.budgetMs}ms, ${r.green ? "green" : "OVER BUDGET"}):`);
        for (const f of r.fixed) log(`  fixed:   ${f}`);
        for (const sk of r.skipped) log(`  skipped: ${sk}`);
        for (const b of r.backups) log(`  backup:  ${b}`);
        for (const n of r.notes) log(`  note:    ${n}`);
        if (!r.green) return 1;
      }
      const checks = await cli.doctor(projectRoot);
      const modern = await cli.modernDoctor(projectRoot);
      const cleanLegacy = checks.map(c => ({ ...c, detail: sanitizeDiagnostics([{ id: c.name, title: c.name, status: c.ok ? "pass" : "fail", evidence: "unknown", detail: c.detail }], projectRoot)[0]!.detail }));
      const cleanModern = sanitizeDiagnostics(modern, projectRoot);
      if (has("--json")) { log(JSON.stringify({ modern: cleanModern, legacy: cleanLegacy })); return cleanModern.some(c => c.status === "fail") || cleanLegacy.some(c => !c.ok) ? 1 : 0; }
      let allOk = !cleanModern.some(c => c.status === "fail");
      for (const c of cleanLegacy) {
        if (!c.ok) allOk = false;
        log(`  [${c.ok ? "ok " : "FAIL"}] ${c.name}: ${c.detail}`);
      }
      log(allOk ? "doctor: all checks passed" : "doctor: some checks failed");
      for (const c of cleanModern) log(`  [${c.status.padEnd(4)}] ${c.title} (${c.evidence}): ${c.detail}`);
      return allOk && !cleanLegacy.some(c => !c.ok) ? 0 : 1;
    }
    case "value-report": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({
        config: loaded.config,
        projectRoot,
        worktree: projectRoot,
        pluginVersion: PLUGIN_VERSION,
      });
      const report = await engine.valueReport();
      if (has("--json")) {
        log(JSON.stringify(report, null, 2));
        return 0;
      }
      if (!report.enabled) {
        log("Value measurement is disabled (correlational only; it records task outcomes,");
        log("tool latency/retries, provider usage links, and context injection — never causation).");
        log("Enable it by adding to .supracortex/config.jsonc:");
        log('  "telemetry": { "valueMeasurement": { "enabled": true } }');
        log("then re-run `supracortex value-report`. Local-only, no network.");
        return 0;
      }
      const num = (v: number | null | undefined) => (v === undefined || v === null ? "-" : String(v));
      const seg = (s: ValueSegmentStat | null, name: string) => {
        if (!s) { log(`  ${name}: no data`); return; }
        log(`  ${name}:`);
        log(`    tasks:              ${s.taskCount}`);
        log(`    tasks w/ outcome:   ${s.tasksWithOutcome}`);
        log(`    outcomes (agent):   success=${s.outcomesAgent.success}, failure=${s.outcomesAgent.failure}, partial=${s.outcomesAgent.partial}`);
        log(`    outcomes (inferred): success=${s.outcomesInferred.success}, failure=${s.outcomesInferred.failure}, partial=${s.outcomesInferred.partial}`);
        log(`    tool executions:    ${s.toolExecutions}`);
        log(`    retries (est.):     ${s.totalRetryCount}`);
        log(`    latency median:     ${num(s.latencyMedianMs)} ms`);
        log(`    latency p90:        ${num(s.latencyP90Ms)} ms`);
        log(`    input tokens:       ${s.inputTokens}`);
        log(`    output tokens:      ${s.outputTokens}`);
        log(`    reported cost:      ${s.reportedCost}`);
      };
      log("Value measurement report (correlational only; aggregation is over the bounded tail):");
      log(`  unattributed (no incarnationId, legacy): ${report.unattributed.rows} rows / ${report.unattributed.distinctTaskIds} taskIds`);
      log(`  attributed, unclassified tasks:          ${report.unclassifiedTasks}`);
      seg(report.segments.injected, "injected context");
      seg(report.segments.notInjected, "no context");
      if (report.comparisonRendered) {
        log("");
        log(`Segmented comparison (sample: injected=${report.sample.injected}, not injected=${report.sample.notInjected}):`);
        log(`  ${report.correlationLabel}`);
      } else {
        log("");
        log(report.refusalReason ?? "not enough data");
      }
      return 0;
    }
    case "compact": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({
        config: loaded.config,
        projectRoot,
        worktree: projectRoot,
        pluginVersion: PLUGIN_VERSION,
      });
      const r = await engine.compactMemory();
      log(`Compacted: superseded ${r.superseded}, expired ${r.expired}, kept ${r.kept.length}`);
      return 0;
    }
    case "snapshot": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      const snapshot = await engine.exportSnapshot();
      log(JSON.stringify(snapshot ? { generatedAt: snapshot.generatedAt, graph: snapshot.graph.stats, vault: "vault-manifest.json" } : { disabled: true }, null, 2));
      return 0;
    }
    case "timeline": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      log(JSON.stringify(await engine.timelineEvents({ limit: 100 }), null, has("--pretty") ? 2 : 0)); return 0;
    }
    case "handoff": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      const raw = process.argv[3];
      const input = raw?.startsWith("{") ? JSON.parse(raw) : { goal: raw ?? "Continue project work" };
      log(JSON.stringify(await engine.createHandoff(input), null, 2)); return 0;
    }
    case "resume": {
      const id = process.argv[3]; if (!id) { log("Usage: supracortex resume <id>"); return 1; }
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      log(JSON.stringify(await engine.resumeHandoff(id), null, 2)); return 0;
    }
    case "review": {
      const act = process.argv[3];
      const valid = ["list", "approve", "edit", "dispute", "pin", "suppress", "purge"];
      if (!act || !valid.includes(act)) { log(`Usage: supracortex review <${valid.join("|")}> [id]`); return 1; }
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      const id = process.argv[4];
      const action = act === "list" ? { type: "list" as const } : { type: act, id: id ?? "" };
      log(JSON.stringify(await engine.review(action as never), null, 2)); return 0;
    }
    case "safety": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      const gather = await gatherInputs({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      log(JSON.stringify(await engine.generateSafetyBrief(gather.git), null, 2)); return 0;
    }
    case "import": {
      const source = process.argv[3]; const path = process.argv[4];
      if (!source || !path) { log("Usage: supracortex import <agents-md|claude-md|cline|serena|json|jsonl> <path> [--commit]"); return 1; }
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      if (has("--commit")) {
        log(JSON.stringify(await engine.importCommit(source, path), null, 2));
      } else {
        const preview = await engine.importPreview(source, path);
        log(`Preview: ${preview.candidates.length} candidate(s), ${preview.skipped.length} skipped. Re-run with --commit to stage for review.`);
        for (const c of preview.candidates.slice(0, 20)) log(`  [${c.kind}] ${c.content.slice(0, 100)}`);
      }
      return 0;
    }
    case "sweep": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({
        config: loaded.config,
        projectRoot,
        worktree: projectRoot,
        pluginVersion: PLUGIN_VERSION,
      });
      const r = await engine.sweep("cli", { force: true });
      if (!r) {
        log("Sweep skipped (disabled).");
        return 0;
      }
      if (r.clean) {
        log("System clean: nothing stale to sweep.");
        return 0;
      }
      log("Sweep results:");
      log(`  abandoned tasks:            ${r.abandonedTasks.length}`);
      log(`  released ownership:         ${r.releasedOwnership.length}`);
      log(`  expired sessions:           ${r.expiredSessions.length}`);
      log(`  pruned cache entries:       ${r.prunedCacheEntries}`);
      log(`  memory flagged for reverify:${r.memoryFlaggedForReverify.length}`);
      log(`  pruned completed tasks:     ${r.prunedCompletedTasks}`);
      return 0;
    }
    case "sync": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({
        config: loaded.config,
        projectRoot,
        worktree: projectRoot,
        pluginVersion: PLUGIN_VERSION,
      });
      const r = await engine.syncSupraSpace();
      if (r.skippedReason) {
        log(`SupraSpace sync skipped: ${r.skippedReason}`);
        return 0;
      }
      log("SupraSpace sync:");
      log(`  files written:       ${r.filesWritten.join(", ") || "none"}`);
      log(`  projected entries:   ${r.projectedEntries}`);
      log(`  ingested candidates: ${r.ingestedCandidates}`);
      log(`  ingested recorded:   ${r.ingestedRecorded}`);
      return 0;
    }
    case "graph": {
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({
        config: loaded.config,
        projectRoot,
        worktree: projectRoot,
        pluginVersion: PLUGIN_VERSION,
      });
      const g = await engine.exportGraph();
      if (!g) {
        log("Disabled; no graph to export.");
        return 0;
      }
      // Machine-readable by default (for SupraSpace to consume).
      log(JSON.stringify(g, null, has("--pretty") ? 2 : 0));
      return 0;
    }
    case "code-graph": {
      const action = process.argv[3] ?? "status";
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({ config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION });
      const limits = {
        ...(positiveIntAfter("--depth") ? { maxDepth: positiveIntAfter("--depth") } : {}),
        ...(positiveIntAfter("--limit") ? { maxResults: positiveIntAfter("--limit") } : {}),
        ...(positiveIntAfter("--fanout") ? { maxFanout: positiveIntAfter("--fanout") } : {}),
      };
      let result: unknown;
      if (action === "status") result = await engine.codeGraphStatus();
      else if (action === "enable" || action === "disable") {
        const report = await cli.setCodeGraphEnabled(projectRoot, action === "enable", has("--automatic-context"));
        result = { ...report, automaticContext: action === "enable" && has("--automatic-context") };
      }
      else if (action === "rebuild") {
        const graph = await engine.rebuildCodeGraph(has("--force-index"));
        result = { rebuilt: graph !== null, graph: await engine.codeGraphStatus() };
      } else if (action === "query") {
        const selector = valueAfter("--selector");
        if (!selector) { log("Usage: supracortex code-graph query --selector path:<file>|symbol:<file>#<symbol>|node:<sha256>"); return 1; }
        result = await engine.queryCodeGraphNeighbors(selector as import("../packages/core/src/types.ts").CodeGraphSelector, limits);
      } else if (action === "path") {
        const from = valueAfter("--from"); const to = valueAfter("--to");
        if (!from || !to) { log("Usage: supracortex code-graph path --from <selector> --to <selector>"); return 1; }
        result = await engine.queryCodeGraphPath(from as import("../packages/core/src/types.ts").CodeGraphSelector, to as import("../packages/core/src/types.ts").CodeGraphSelector, limits);
      } else if (action === "explain") {
        const selector = valueAfter("--selector");
        if (!selector) { log("Usage: supracortex code-graph explain --selector <selector>"); return 1; }
        result = await engine.explainCodeGraphNode(selector as import("../packages/core/src/types.ts").CodeGraphSelector);
      } else if (action === "impact") {
        const selector = valueAfter("--selector"); const direction = valueAfter("--direction");
        if (!selector || (direction !== "incoming" && direction !== "outgoing")) { log("Usage: supracortex code-graph impact --selector <selector> --direction incoming|outgoing"); return 1; }
        result = await engine.queryCodeGraphImpact(selector as import("../packages/core/src/types.ts").CodeGraphSelector, direction, limits);
      } else { log(`Unknown code-graph action: ${action}`); return 1; }
      log(JSON.stringify(result, null, has("--pretty") ? 2 : 0));
      return 0;
    }
    case "inspect": {
      const query = process.argv[3];
      if (!query) {
        log("Usage: supracortex inspect \"<task query>\"");
        return 1;
      }
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const engine = await createEngine({
        config: loaded.config,
        projectRoot,
        worktree: projectRoot,
        pluginVersion: PLUGIN_VERSION,
      });
      const gather = await gatherInputs(
        { config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION },
        "orchestrator",
      );
      const packet = await engine.prepareContext({ query }, gather);
      if (!packet) {
        log("Disabled; nothing to inspect.");
        return 0;
      }
      log(inspectReport(packet));
      log("");
      log(formatMetrics(engine.metricsSnapshot()));
      return 0;
    }
    case "context": {
      // Universal prompt-injection command: emits a compact context packet as
      // plain text so ANY coding CLI (Claude Code, Codex, Gemini, OpenCode…)
      // launched by SupraSpace can fold it into the launch prompt. Prints
      // nothing when disabled/empty so callers can safely inline the output.
      const query = process.argv[3];
      if (!query) {
        log("Usage: supracortex context \"<task query>\" [--agent <role>]");
        return 1;
      }
      const agentIdx = process.argv.indexOf("--agent");
      const agent = agentIdx > -1 ? process.argv[agentIdx + 1] : "orchestrator";
      const loaded = await loadConfig({ projectRoot, env: process.env });
      if (!loaded.config.enabled) return 0; // silent when disabled
      const engine = await createEngine({
        config: loaded.config,
        projectRoot,
        worktree: projectRoot,
        pluginVersion: PLUGIN_VERSION,
      });
      const gather = await gatherInputs(
        { config: loaded.config, projectRoot, worktree: projectRoot, pluginVersion: PLUGIN_VERSION },
        agent,
      );
      // Optional --sync: ingest any prior .supraspace notes before building the
      // packet, so a launch reflects the latest human/agent memory. Best-effort.
      if (has("--sync")) {
        try {
          await engine.syncSupraSpace();
        } catch {
          /* best-effort */
        }
      }
      const packet = await engine.prepareContext({ query }, gather);
      if (!packet || (packet.selectedMemory.length === 0 && packet.constraints.length === 0 && packet.selectedFiles.length === 0)) {
        return 0; // nothing useful; emit nothing
      }
      const { renderPacketForPrompt } = await import(
        "../packages/opencode/src/packet-rendering.ts"
      );
      log(renderPacketForPrompt(packet));
      return 0;
    }
    case "reset": {
      const target = process.argv[3] as cli.ResetTarget | undefined;
      const valid = ["cache", "index", "sessions", "metrics", "all-generated", "all"];
      if (!target || !valid.includes(target)) {
        log(`Usage: supracortex reset <${valid.join("|")}> --yes`);
        return 1;
      }
      if (!has("--yes")) {
        log(`This will delete "${target}" data under ${join(projectRoot, ".supracortex")}.`);
        log("Re-run with --yes to confirm. Durable memory is only removed by target \"all\".");
        return 1;
      }
      const removed = await cli.reset(projectRoot, target);
      log(`Reset ${target}: removed ${removed.length ? removed.join(", ") : "nothing"}`);
      return 0;
    }
    case "storage-migrate": {
      // One-shot copy of JSONL-filesystem records into state/store.sqlite.
      // Idempotent: logical paths already present in SQLite are skipped.
      const { migrateJsonlToSqlite } = await import("../packages/core/src/index.ts");
      const { resolveProjectStorageDirectory } = await import("../packages/core/src/index.ts");
      const loaded = await loadConfig({ projectRoot, env: process.env });
      const storageRoot = resolveProjectStorageDirectory(projectRoot, loaded.config.storage.directory);
      if (has("--dry-run")) {
        const preview = await migrateJsonlToSqlite(storageRoot, { dryRun: true });
        log(`storage-migrate --dry-run under ${storageRoot}:`);
        log(`  would copy: ${preview.filesCopied.join(", ") || "nothing"}`);
        log(`  corrupt lines (left behind): ${preview.corruptLines}`);
        return 0;
      }
      if (!has("--yes")) {
        log(`This will copy JSONL records into SQLite under ${storageRoot}.`);
        log("Re-run with --yes to confirm (or --dry-run to preview). Source files are left in place.");
        return 1;
      }
      const migrated = await migrateJsonlToSqlite(storageRoot);
      log(`storage-migrate under ${storageRoot}:`);
      log(`  json docs copied:   ${migrated.jsonCopied}`);
      log(`  jsonl rows copied:  ${migrated.jsonlEntriesCopied}`);
      log(`  skipped (present):  ${migrated.skipped.join(", ") || "none"}`);
      log(`  corrupt lines:      ${migrated.corruptLines}`);
      return 0;
    }
    case "logs": {
      // Tail the latest Pi run log (JSON lines on stderr during runs, file sink per run).
      // Storage dir mirrors the service: core config storage.directory, default .supracortex.
      let storageDir = ".supracortex";
      try {
        const { parse } = await import("jsonc-parser");
        const raw = parse(await readFile(join(projectRoot, ".supracortex", "config.jsonc"), "utf8")) as unknown;
        if (raw && typeof raw === "object") {
          if ("$schema" in raw) delete (raw as Record<string, unknown>)["$schema"];
          const dir = (raw as { storage?: { directory?: unknown } }).storage?.directory;
          if (typeof dir === "string" && dir) storageDir = dir;
        }
      } catch {
        // Fall through to the default storage dir.
      }
      const latest = await findLatestLog(join(projectRoot, storageDir));
      if (!latest) {
        log(`no Pi run logs under ${join(projectRoot, storageDir, "cli", "logs")}`);
        return 1;
      }
      log(`--- ${latest} ---`);
      for (const line of await tailLog(latest, positiveIntAfter("--lines") ?? 100)) log(line);
      return 0;
    }
    case "version":
    case "--version":
    case "-v":
      log(PLUGIN_VERSION);
      return 0;
    default:
      log(await usage());
      return cmd ? 1 : 0;
  }
}

/**
 * Launch OpenCode as the SupraCode host (stdio inherited, exit code
 * forwards). SupraCortex arrives via the installed server plugin and brand
 * TUI plugin — both owned by `supracortex install`. `--no-cortex` disables
 * the engine through SUPRACORTEX_DISABLE; everything else is forwarded.
 */
async function runOpenCodeMain(raw: string[]): Promise<number> {
  const withCortex = !raw.includes("--no-cortex");
  const levelFlag = valueAfter("--log-level");
  const forwarded = raw.filter((arg) => arg !== "--no-cortex" && arg !== "--");
  const levelIndex = forwarded.indexOf("--log-level");
  const opencodeArgs =
    levelIndex >= 0 ? forwarded.filter((_, i) => i !== levelIndex && i !== levelIndex + 1) : forwarded;
  const bin = process.env.OPENCODE_BIN?.trim() || "opencode";
  const scope = root();
  // Stock OpenCode, isolated profile: OpenCode's global config dir becomes
  // ~/.config/supracode/opencode, so nothing from the user's stock
  // ~/.config/opencode (plugins, agents, MCP, TUI plugins) is inherited.
  const paths = profilePaths();
  try {
    if (!existsSync(join(paths.opencodeConfig, "plugins", "supracortex.ts"))) {
      const created = await ensureProfile(await cli.profileContents());
      for (const n of created.notes) process.stderr.write(`supracode: ${n}\n`);
    }
    refreshConfigFarm(paths);
  } catch (err) {
    log(`supracortex: cannot prepare the isolated profile (${(err as Error).message}).`);
    return 1;
  }
  // Live shared layer: stock MCP servers, providers and skills (never plugins).
  const shared = buildSharedLayer(paths);
  for (const w of shared.warnings) process.stderr.write(`supracode: ${w}\n`);
  const child = spawn(bin, opencodeArgs, {
    cwd: scope,
    stdio: "inherit",
    shell: false,
    env: {
      ...supracodeEnv(process.env, paths, shared.configFile),
      SUPRACORTEX_ROOT: scope,
      ...(!withCortex ? { SUPRACORTEX_DISABLE: "1" } : {}),
      ...(levelFlag ? { SUPRACORTEX_LOG_LEVEL: levelFlag } : {}),
    },
  });
  return new Promise<number>((settle) => {
    child.on("error", (err) => {
      log(
        `supracortex run: cannot launch "${bin}" (${err instanceof Error ? err.message : "spawn failed"}). ` +
          "Install OpenCode 1.x (https://opencode.ai) or set OPENCODE_BIN.",
      );
      settle(1);
    });
    child.on("exit", (exitCode) => settle(exitCode ?? 1));
  });
}

/**
 * Isolated OpenCode V2 binary owned by SupraCode (pinned; never the global
 * V1 `opencode` on PATH, which V2 would otherwise replace on install).
 */
/**
 * OpenCode V2's provider catalog activates some built-in providers only from an
 * environment variable, whereas V1 resolves them from the shared auth store
 * (<data>/opencode/auth.json). Bridge that store into the provider env vars V2
 * needs (currently DeepSeek) so one login works on both hosts. Only fills vars
 * that are not already set; the value is never logged.
 */
function v2ProviderEnv(home: string): Record<string, string> {
  const ENV_BY_PROVIDER: Record<string, string> = { deepseek: "DEEPSEEK_API_KEY" };
  const out: Record<string, string> = {};
  try {
    const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
    const auth = JSON.parse(readFileSync(join(dataHome, "opencode", "auth.json"), "utf8")) as Record<
      string,
      { type?: string; key?: unknown }
    >;
    for (const [provider, envName] of Object.entries(ENV_BY_PROVIDER)) {
      if (process.env[envName]) continue;
      const entry = auth[provider];
      if (entry?.type === "api" && typeof entry.key === "string" && entry.key.trim()) out[envName] = entry.key.trim();
    }
  } catch {
    /* no auth store / unreadable: leave the environment as-is */
  }
  return out;
}

function v2Bin(): string {
  let home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    try {
      home = homedir();
    } catch {
      home = ".";
    }
  }
  return process.env.SUPRACODE_V2_BIN?.trim() || join(
    home,
    ".local",
    "share",
    "supracode",
    "v2",
    "node_modules",
    ".bin",
    "opencode",
  );
}

/**
 * Launch the pinned OpenCode V2 host (supracode2). stdio is inherited, exit
 * code forwards. Arguments forward verbatim; `--no-cortex` disables the
 * engine through SUPRACORTEX_DISABLE.
 */
async function runV2Main(raw: string[]): Promise<number> {
  const withCortex = !raw.includes("--no-cortex");
  const forwarded = raw.filter((arg) => arg !== "--no-cortex" && arg !== "--");
  const bin = v2Bin();
  if (!existsSync(bin)) {
    log(
      `supracode2: V2 host missing at ${bin}. Install it with ` +
        "`npm install --prefix ~/.local/share/supracode/v2 @opencode/cli@2.0.16` " +
        "or set SUPRACODE_V2_BIN. V1 is never substituted.",
    );
    return 1;
  }
  const scope = root();
  // supracode2 owns a dedicated V2 config root so V1 and V2 plugin shapes
  // never share a discovery directory (their contracts are incompatible).
  let configHome = process.env.HOME ?? process.env.USERPROFILE;
  if (!configHome) {
    try {
      configHome = homedir();
    } catch {
      configHome = ".";
    }
  }
  const child = spawn(bin, forwarded, {
    cwd: scope,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      SUPRACORTEX_ROOT: scope,
      SUPRACODE_HOST_GENERATION: "v2",
      OPENCODE_CONFIG_DIR:
        process.env.SUPRACODE2_CONFIG_DIR?.trim() || join(configHome, ".config", "supracode2"),
      // V2 catalog needs provider env vars that V1 reads from auth.json.
      ...v2ProviderEnv(configHome),
      ...(!withCortex ? { SUPRACORTEX_DISABLE: "1" } : {}),
    },
  });
  return new Promise<number>((settle) => {
    child.on("error", (err) => {
      log(`supracode2: cannot launch "${bin}" (${err instanceof Error ? err.message : "spawn failed"})`);
      settle(1);
    });
    child.on("exit", (exitCode) => settle(exitCode ?? 1));
  });
}

/**
 * Launch one Pi process with the bundled SupraCortex extension (parked legacy
 * host; `supracode-pi`, `supracode pi` or `supracode run --pi`). stdio is inherited; exit code
 * forwards.
 */
async function runPiMain(raw: string[]): Promise<number> {
  const withCortex = !raw.includes("--no-cortex");
  const levelFlag = valueAfter("--log-level");
  const forwarded = raw.filter((arg) => arg !== "--no-cortex" && arg !== "--");
  // --log-level is ours (also forwarded to Pi's stderr/file logging via env).
  const levelIndex = forwarded.indexOf("--log-level");
  const piArgs = levelIndex >= 0 ? forwarded.filter((_, i) => i !== levelIndex && i !== levelIndex + 1) : forwarded;
  let bin: { packageRoot: string; binPath: string; version: string };
  try {
    bin = resolvePiBin();
  } catch (err) {
    log(`supracortex run: ${err instanceof Error ? err.message : "Pi resolution failed"}`);
    return 1;
  }
  // The bundled extension ships next to this CLI entry (dist/pi-extension.js).
  const here = dirname(fileURLToPath(import.meta.url));
  const extensionPath = join(here, "pi-extension.js");
  if (withCortex && !existsSync(extensionPath)) {
    log(`supracortex run: bundled extension missing at ${extensionPath} (run a build first)`);
    return 1;
  }
  const child = runPi(bin, {
    ...(withCortex ? { extensionPath } : {}),
    piArgs,
    env: {
      ...process.env,
      ...(withCortex ? { SUPRACODE_PANELS: "1" } : {}),
      ...(levelFlag ? { SUPRACORTEX_LOG_LEVEL: levelFlag } : {}),
    },
  });
  return new Promise<number>((settle) => {
    child.on("error", () => settle(1));
    child.on("exit", (exitCode) => settle(exitCode ?? 1));
  });
}

function inspectReport(packet: {
  taskSummary: string;
  selectedMemory: Array<{ entry: { kind: string; content: string }; reason: string }>;
  selectedFiles: Array<{ path: string; mode: string; reason: string }>;
  selectedSummaries: Array<{ path: string; reason: string; verified: boolean }>;
  omissions: Array<{ path: string; reason: string; detail?: string }>;
  estimatedTokens: number;
  budget: { maxTokens: number; remainingTokens: number };
  cacheReport: { hits: number; stale: number };
  recommendedSkills: Array<{ name: string; reason: string }>;
  recommendedMcpTools: Array<{ server: string; tool?: string; purpose: string }>;
}): string {
  const lines: string[] = [];
  lines.push(`Task: ${packet.taskSummary}`);
  lines.push(`Estimated tokens: ${packet.estimatedTokens} / ${packet.budget.maxTokens} (remaining ${packet.budget.remainingTokens})`);
  lines.push(`Cache: ${packet.cacheReport.hits} usable, ${packet.cacheReport.stale} stale`);
  lines.push("");
  lines.push("Memory that would be retrieved:");
  for (const m of packet.selectedMemory) lines.push(`  [${m.entry.kind}] ${m.entry.content} — ${m.reason}`);
  lines.push("Selected files:");
  for (const f of packet.selectedFiles) lines.push(`  ${f.path} (${f.mode}) — ${f.reason}`);
  lines.push("Selected summaries:");
  for (const s of packet.selectedSummaries) lines.push(`  ${s.path} (${s.verified ? "hash-verified" : "unverified"}) — ${s.reason}`);
  lines.push("Excluded files:");
  for (const o of packet.omissions) lines.push(`  ${o.path}: ${o.reason}${o.detail ? ` (${o.detail})` : ""}`);
  if (packet.recommendedSkills.length) {
    lines.push("Recommended skills:");
    for (const s of packet.recommendedSkills) lines.push(`  ${s.name} — ${s.reason}`);
  }
  if (packet.recommendedMcpTools.length) {
    lines.push("Recommended MCP tools:");
    for (const t of packet.recommendedMcpTools) lines.push(`  ${t.server}${t.tool ? `:${t.tool}` : ""} — ${t.purpose}`);
  }
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function usage(): Promise<string> {
  return [
    "supracortex <command>",
    "",
    "Commands:",
    "  install [--global] [--force]       Install the plugin into the current project",
    "  uninstall [--keep-data|--remove-data] [--global]",
    "  init [--yes] [--agent <name>]      Wire project MCP config and guidance",
    "  connect <codex|claude|generic|all> Register SupraCortex as an MCP server",
    "  disconnect <codex|claude|all>      Remove that registration",
    "  enable                             Persist enabled=true",
    "  disable                            Persist enabled=false",
    "  status [--json] [--check-handshake]  Show effective status",
    "  doctor [--fix] [--global]          Run health checks",
    "  compact                            Compact memory",
    '  inspect "<query>"                  Explain what context would be prepared',
    "  reset <target> --yes               Reset generated data (cache|index|sessions|metrics|all-generated|all)",
    "  provider [list|show|use <id>|check] Decision provider configuration",
    "  jev [status|key <KEY>|forget|login|test]  Jev decision model",
    "  graph [--pretty]                   Export intelligence as a nodes/edges graph JSON",
    "  code-graph status|enable|disable|rebuild|query|path|explain|impact  Local file/symbol graph",
    '  context "<query>" [--agent <role>] Emit a prompt-injection context block for any CLI',
    "  version                            Print version",
  ].join("\n");
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`supracortex error: ${String((err as Error).message).replace(/(?:[A-Za-z]:)?(?:[\\/][^\s"']+)+/g, "[path]")}\n`);
    process.exit(2);
  });
