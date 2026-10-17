#!/usr/bin/env node
/**
 * Thin wrapper: `supracortex migrate`. Runs pending storage migrations
 * against the project runtime directory.
 */
import { join } from "node:path";
import { JsonlStore, runMigrations } from "../packages/core/src/index.ts";
import { PLUGIN_VERSION } from "../packages/opencode/src/plugin.ts";

const projectRoot = process.env.SUPRACORTEX_ROOT || process.cwd();
const store = new JsonlStore(join(projectRoot, ".supracortex"));
const result = await runMigrations(store, PLUGIN_VERSION);
console.log(`Migrations: from schema ${result.from} to ${result.to} (applied: ${result.applied.join(", ") || "none"})`);
