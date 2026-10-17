import test from "node:test";
import assert from "node:assert";
import {
  resolveConfig,
  applyModePreset,
  validateConfig,
  DEFAULT_CONFIG,
  CONFIG_FIELD_REGISTRY,
  DEPRECATED_UNIMPLEMENTED_PATHS,
  buildDefaultTemplate,
  flattenConfig,
  unknownConfigKeys,
  RENAMED_CONFIG_KEYS,
  REMOVED_CONFIG_KEYS,
} from "../../packages/core/src/index.ts";
import { PACKAGE_VERSION, CONFIG_SCHEMA_VERSION } from "../../src/version.ts";
import packageManifest from "../../package.json" with { type: "json" };

test("env disable overrides project enabled=true", () => {
  const r = resolveConfig({
    project: { enabled: true },
    env: { SUPRACORTEX_DISABLE: "1" },
  });
  assert.equal(r.config.enabled, false);
  assert.equal(r.source, "env-disable");
});

test("env disable accepts case-insensitive truthy values", () => {
  for (const v of ["1", "true", "YES", "On", "TRUE"]) {
    const r = resolveConfig({ project: { enabled: true }, env: { SUPRACORTEX_DISABLE: v } });
    assert.equal(r.config.enabled, false, `value ${v}`);
  }
});

test("env enable ranks below emergency disable", () => {
  const r = resolveConfig({
    env: { SUPRACORTEX_DISABLE: "1", SUPRACORTEX_ENABLE: "1" },
  });
  assert.equal(r.config.enabled, false);
  assert.equal(r.source, "env-disable");
});

test("precedence: runtime override beats project beats global", () => {
  const r = resolveConfig({
    global: { enabled: true },
    project: { enabled: true },
    runtimeOverride: { enabled: false },
  });
  assert.equal(r.config.enabled, false);
  assert.equal(r.source, "runtime");
});

test("mode off disables", () => {
  const r = resolveConfig({ project: { mode: "off" } });
  assert.equal(r.config.enabled, false);
});

test("explicit enabled flag wins over preset implied enabled", () => {
  // aggressive preset implies enabled=true, but explicit false must win.
  const r = resolveConfig({ project: { mode: "aggressive", enabled: false } });
  assert.equal(r.config.enabled, false);
});

test("mode presets resolve to concrete settings", () => {
  const minimal = applyModePreset(DEFAULT_CONFIG, "minimal");
  assert.equal(minimal.parallelism.enabled, false);
  assert.ok(minimal.context.maxTokens <= DEFAULT_CONFIG.context.maxTokens);

  const aggressive = applyModePreset(DEFAULT_CONFIG, "aggressive");
  assert.ok(aggressive.context.maxTokens > DEFAULT_CONFIG.context.maxTokens);
});

test("validateConfig flags bad values", () => {
  const bad = validateConfig({ memory: { minimumConfidence: 5 }, mode: "nope" });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes("minimumConfidence")));
  assert.ok(bad.errors.some((e) => e.includes("mode")));
});

test("validateConfig rejects a storage directory that could escape a project", () => {
  const bad = validateConfig({ storage: { directory: "../outside" } });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((error) => error.includes("storage.directory")));
});

test("unknown config keys are path-specific and cannot look accepted", () => {
  const unknown = unknownConfigKeys({ context: { maxToken: 123 }, surprise: true });
  assert.deepEqual(unknown.sort(), ["context.maxToken", "surprise"]);
  const result = validateConfig({ context: { maxToken: 123 } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("context.maxToken")));
});

test("config merge ignores prototype-pollution keys from untrusted config", () => {
  // A hostile config.jsonc could carry __proto__/constructor/prototype keys.
  const hostile = JSON.parse(
    '{"enabled":true,"__proto__":{"polluted":true},"constructor":{"x":1},"memory":{"__proto__":{"polluted":true},"minimumConfidence":0.5}}',
  );
  const r = resolveConfig({ project: hostile });
  // Globals untouched.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  // Legit values still merged.
  assert.equal(r.config.enabled, true);
  assert.equal(r.config.memory.minimumConfidence, 0.5);
});

test("default config validates", () => {
  const ok = validateConfig(DEFAULT_CONFIG);
  assert.equal(ok.valid, true, ok.errors.join("; "));
});

test("full-feature defaults enable graph extraction, Jev, local measurement and conditional SupraSpace sync", () => {
  assert.equal(DEFAULT_CONFIG.graph.enabled, true);
  // Automatic graph hints are opt-in: they apply only when a generation exists
  // and the project sets graph.automaticContext: true.
  assert.equal(DEFAULT_CONFIG.graph.automaticContext, false);
  assert.equal(DEFAULT_CONFIG.jev.enabled, true);
  assert.equal(DEFAULT_CONFIG.telemetry.valueMeasurement.enabled, true);
  assert.equal(DEFAULT_CONFIG.supraspace.enabled, true);
  assert.equal(DEFAULT_CONFIG.supraspace.syncOnSweep, true);
});

test("every config leaf has an owned, testable registry entry", () => {
  const fields = flattenConfig(DEFAULT_CONFIG);
  assert.deepEqual(Object.keys(CONFIG_FIELD_REGISTRY).sort(), Object.keys(fields).sort());
  for (const [path, value] of Object.entries(fields)) {
    const entry = CONFIG_FIELD_REGISTRY[path];
    assert.ok(entry, path);
    assert.equal(entry.default, value, path);
    assert.ok(entry.owner.length > 0, path);
    assert.match(entry.functionalTest, /\.test\.ts$/, path);
  }
});

test("unsafe cache validation cannot be presented as an active configuration switch", () => {
  const entry = CONFIG_FIELD_REGISTRY["cache.validateBeforeUse"];
  assert.equal(entry?.stability, "deprecated-unimplemented");
});

test("telemetry configuration is explicit, local-only, and validates bounds", () => {
  assert.equal(DEFAULT_CONFIG.telemetry.mode, "local");
  assert.equal(validateConfig({ telemetry: { mode: "remote" } }).valid, false);
  assert.equal(validateConfig({ telemetry: { mode: "off", maxEvents: 0, maxAgeDays: 0 } }).valid, true);
  assert.equal(validateConfig({ telemetry: { mode: "local", maxEvents: 0 } }).valid, false);
  assert.equal(validateConfig({ telemetry: { mode: "local", maxAgeDays: 0 } }).valid, false);
  assert.equal(CONFIG_FIELD_REGISTRY["telemetry.mode"]?.securityImpact, "privacy");
  // Session-metric retention: default 90d, 0 disables (keep forever), negative rejected by schema.
  assert.equal(DEFAULT_CONFIG.telemetry.sessionMetrics.retentionDays, 90);
  assert.equal(validateConfig({ telemetry: { sessionMetrics: { retentionDays: 0 } } }).valid, true);
  assert.equal(validateConfig({ telemetry: { sessionMetrics: { retentionDays: 90 } } }).valid, true);
  assert.equal(validateConfig({ telemetry: { sessionMetrics: { retentionDays: -1 } } }).valid, false);
  assert.equal(CONFIG_FIELD_REGISTRY["telemetry.sessionMetrics.retentionDays"]?.owner, "packages/core/src/metrics");
});

test("renamed config key produces a warning, not an error", () => {
  const result = validateConfig({ context: { maxFullFiles: 3 } });
  assert.equal(result.valid, true, "renamed key does not cause error");
  assert.ok(result.warnings.some((w) => w.includes("maxFullFiles") && w.includes("maxRecommendedReads")), "rename warning emitted");
  // The renamed value must still be applied to the new key.
  assert.equal(result.value.context.maxRecommendedReads, 3, "value mapped to new key");
});

test("removed config key produces a warning, not an error", () => {
  const result = validateConfig({ efficiency: { enabled: true } });
  assert.equal(result.valid, true, "removed key does not cause error");
  assert.ok(result.warnings.some((w) => w.includes("efficiency.enabled") && w.includes("removed")), "removed warning emitted");
});

test("removed config section produces a warning, not an error", () => {
  const result = validateConfig({ logging: { level: "warn", maxFiles: 3 } });
  assert.equal(result.valid, true, "removed section does not cause error");
  assert.ok(result.warnings.some((w) => w.includes("logging.level") && w.includes("removed")), "logging.level removal warned");
});

test("new key wins when both old and new names are present in raw config", () => {
  const result = validateConfig({ context: { maxFullFiles: 3, maxRecommendedReads: 10 } });
  assert.equal(result.valid, true);
  assert.equal(result.value.context.maxRecommendedReads, 10, "explicit new key wins");
  assert.ok(result.warnings.some((w) => w.includes("maxFullFiles")), "rename still warned");
});

test("every RENAMED_CONFIG_KEYS entry produces the right warning and no error", () => {
  for (const [oldKey, newKey] of Object.entries(RENAMED_CONFIG_KEYS)) {
    const parts = oldKey.split(".");
    const nested: Record<string, unknown> = {};
    let cur = nested;
    for (let i = 0; i < parts.length - 1; i++) {
      const next: Record<string, unknown> = {};
      cur[parts[i]!] = next;
      cur = next;
    }
    cur[parts[parts.length - 1]!] = 42;
    const result = validateConfig(nested);
    assert.equal(result.valid, true, `${oldKey} → ${newKey} is not an error`);
    assert.ok(result.warnings.some((w) => w.includes(oldKey) && w.includes(newKey)), `${oldKey} warned about rename to ${newKey}`);
  }
});

test("every REMOVED_CONFIG_KEYS entry produces the right warning and no error", () => {
  for (const key of REMOVED_CONFIG_KEYS) {
    const parts = key.split(".");
    const nested: Record<string, unknown> = {};
    let cur = nested;
    for (let i = 0; i < parts.length - 1; i++) {
      const next: Record<string, unknown> = {};
      cur[parts[i]!] = next;
      cur = next;
    }
    cur[parts[parts.length - 1]!] = "test";
    const result = validateConfig(nested);
    assert.equal(result.valid, true, `${key} is not an error`);
    assert.ok(result.warnings.some((w) => w.includes(key) && w.includes("removed")), `${key} warned as removed`);
  }
});

test("generated config template omits every deprecated-unimplemented key", () => {
  const template = buildDefaultTemplate();
  const flat = flattenConfig(template);
  for (const path of DEPRECATED_UNIMPLEMENTED_PATHS) {
    assert.equal(path in flat, false, `${path} should be pruned from the generated template`);
  }
});

test("context.includeGitDiff is a live key: retained in the template and never flagged deprecated", () => {
  const template = buildDefaultTemplate();
  const flat = flattenConfig(template);
  assert.equal("context.includeGitDiff" in flat, true, "includeGitDiff has a real runtime consumer and must stay in generated configs");
  assert.equal(DEPRECATED_UNIMPLEMENTED_PATHS.includes("context.includeGitDiff"), false);

  const result = validateConfig({ context: { includeGitDiff: false } });
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings, [], "includeGitDiff must not trigger a deprecation warning");
});

test("context.searchBeforeRead remains deprecated-unimplemented", () => {
  assert.equal(DEPRECATED_UNIMPLEMENTED_PATHS.includes("context.searchBeforeRead"), true);
  const result = validateConfig({ context: { searchBeforeRead: true } });
  assert.equal(result.valid, true);
  assert.ok(
    result.warnings.some((w) => w.includes("context.searchBeforeRead") && w.includes("deprecated")),
    "searchBeforeRead should still produce a deprecation warning",
  );
});

test("generated config template validates with zero warnings and zero errors", () => {
  const template = buildDefaultTemplate();
  const result = validateConfig(template);
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("a config that still carries a deprecated key keeps loading and warns (back-compat)", () => {
  const result = validateConfig({ cache: { hashAlgorithm: "sha256" } });
  assert.equal(result.valid, true, "old configs with deprecated keys must still load");
  assert.ok(
    result.warnings.some((w) => w.includes("cache.hashAlgorithm") && w.includes("deprecated")),
    "deprecated key still produces a warning",
  );
});

test("runtime version and configuration schema cannot drift from their declared sources", () => {
  assert.equal(PACKAGE_VERSION, packageManifest.version);
  assert.equal(CONFIG_SCHEMA_VERSION, 2);
});
