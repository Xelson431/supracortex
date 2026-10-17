#!/usr/bin/env node
/** Thin wrapper: `supracortex uninstall`. */
import * as cli from "../packages/opencode/src/cli-core.ts";

const projectRoot = process.env.SUPRACORTEX_ROOT || process.cwd();
const keepData = process.argv.includes("--keep-data") || !process.argv.includes("--remove-data");
const report = await cli.uninstall({
  projectRoot,
  keepData,
  global: process.argv.includes("--global"),
});
for (const r of report.removed) console.log(`removed: ${r}`);
for (const k of report.kept) console.log(`kept:    ${k}`);
for (const e of report.edited) console.log(`edited:  ${e}`);
for (const n of report.notes) console.log(`note:    ${n}`);
