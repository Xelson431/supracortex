#!/usr/bin/env node
/** Thin wrapper: `supracortex enable`. */
import * as cli from "../packages/opencode/src/cli-core.ts";

const projectRoot = process.env.SUPRACORTEX_ROOT || process.cwd();
const r = await cli.setEnabled(projectRoot, true);
console.log(`Enabled -> ${r.configPath}`);
for (const n of r.notes) console.log(`  ${n}`);
