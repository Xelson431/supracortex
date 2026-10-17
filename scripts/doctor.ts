#!/usr/bin/env node
/** Thin wrapper: `supracortex doctor`. */
import * as cli from "../packages/opencode/src/cli-core.ts";
import { sanitizeDiagnostics } from "../packages/core/src/diagnostics/index.ts";

const projectRoot = process.env.SUPRACORTEX_ROOT || process.cwd();
if (process.argv.includes("--fix")) {
  const r = await cli.doctorFix(projectRoot, { global: process.argv.includes("--global") });
  console.log(`Doctor --fix (${r.durationMs}ms / budget ${r.budgetMs}ms, ${r.green ? "green" : "OVER BUDGET"}):`);
  for (const f of r.fixed) console.log(`  fixed:   ${f}`);
  for (const s of r.skipped) console.log(`  skipped: ${s}`);
  for (const b of r.backups) console.log(`  backup:  ${b}`);
  for (const n of r.notes) console.log(`  note:    ${n}`);
  if (!r.green) process.exit(1);
}
let checks: Awaited<ReturnType<typeof cli.doctor>>;
let modern: Awaited<ReturnType<typeof cli.modernDoctor>>;
try {
  checks = await cli.doctor(projectRoot);
  modern = await cli.modernDoctor(projectRoot);
} catch (error) {
  const detail = sanitizeDiagnostics([{ id: "bootstrap", title: "Bootstrap", status: "fail", evidence: "unknown", detail: String((error as Error).message) }], projectRoot)[0]?.detail ?? "bootstrap failed";
  console.error(`doctor bootstrap failed: ${detail}`);
  process.exit(2);
}
const failed = modern.some(c => c.status === "fail") || checks.some(c => !c.ok);
const cleanLegacy = checks.map(c => ({ ...c, detail: sanitizeDiagnostics([{ id: c.name, title: c.name, status: c.ok ? "pass" : "fail", evidence: "unknown", detail: c.detail }], projectRoot)[0]!.detail }));
const cleanModern = sanitizeDiagnostics(modern, projectRoot);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ modern: cleanModern, legacy: cleanLegacy }));
  process.exit(failed ? 1 : 0);
}
let allOk = !failed;
for (const c of cleanLegacy) {
  if (!c.ok) allOk = false;
  console.log(`  [${c.ok ? "ok " : "FAIL"}] ${c.name}: ${c.detail}`);
}
for (const c of cleanModern) { if (c.status === "fail") allOk = false; console.log(`  [${c.status.padEnd(4)}] ${c.title}: ${c.detail}`); }
console.log(allOk ? "doctor: all checks passed" : "doctor: some checks failed");
process.exit(allOk ? 0 : 1);
