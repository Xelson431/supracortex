/**
 * Test preload (node --import): run the whole suite under a throwaway HOME so
 * no test can read or overwrite the developer's real central config
 * (~/.config/supracortex/config.jsonc), SupraCode profile, or credentials.
 * Tests that need their own HOME still swap process.env.HOME themselves.
 * A real SUPRACODE_REAL_XDG_CONFIG_HOME (set when the suite is launched from
 * inside `supracode`) would bypass HOME, so it is dropped.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.SUPRACORTEX_TEST_HOME) {
  const home = mkdtempSync(join(tmpdir(), "sc-test-home-"));
  process.env.SUPRACORTEX_TEST_HOME = home;
  process.env.HOME = home;
  delete process.env.SUPRACODE_REAL_XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  // Engines would otherwise fire a real decision-provider health request at
  // construction whenever a developer key is in the environment.
  process.env.SUPRACORTEX_NO_DECISION_WARMUP = "1";
  // Generated MCP configs must be deterministic, not depend on whether this
  // machine has a supracortex-mcp shim in /usr/local/bin.
  process.env.SUPRACORTEX_MCP_BIN = "";
  // Instance-scoped env from an enclosing SupraCortex/SupraCode session must
  // not leak into spawned CLIs: SUPRACORTEX_ROOT would redirect them to the
  // host's project root (so a test that seeds a temp project reads the wrong
  // store), and the enable/disable switches would silently gate engines.
  // Tests that need these set them explicitly on the child env.
  for (const key of ["SUPRACORTEX_ROOT", "SUPRACORTEX_DISABLE", "SUPRACORTEX_ENABLE", "SUPRACORTEX_LOG_LEVEL"]) {
    delete process.env[key];
  }
}
