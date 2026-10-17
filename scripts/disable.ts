#!/usr/bin/env node
/** Thin wrapper: `supracortex disable`. */
import * as cli from "../packages/opencode/src/cli-core.ts";

const projectRoot = process.env.SUPRACORTEX_ROOT || process.cwd();
const r = await cli.setEnabled(projectRoot, false);
console.log(`Disabled -> ${r.configPath}`);
for (const n of r.notes) console.log(`  ${n}`);
