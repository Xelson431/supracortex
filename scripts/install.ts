#!/usr/bin/env node
/** Thin wrapper: `supracortex install`. Delegates to the CLI. */
import * as cli from "../packages/opencode/src/cli-core.ts";

const projectRoot = process.env.SUPRACORTEX_ROOT || process.cwd();
const report = await cli.install({
  projectRoot,
  global: process.argv.includes("--global"),
});
for (const c of report.created) console.log(`created: ${c}`);
for (const e of report.edited) console.log(`edited:  ${e}`);
for (const s of report.skipped) console.log(`skipped: ${s}`);
for (const n of report.notes) console.log(`note:    ${n}`);
