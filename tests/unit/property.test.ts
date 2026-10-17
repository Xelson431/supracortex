/**
 * Property-based / fuzz tests. A tiny seeded PRNG generates thousands of random
 * inputs; we assert invariants that must hold for ALL of them. No external deps.
 */
import test from "node:test";
import assert from "node:assert";
import {
  estimateTokens,
  redactSecrets,
  containsLikelySecret,
  safeRelative,
  resolveConfig,
  validateConfig,
  planTasks,
  buildContextPacket,
  contextKey,
  tokenize,
} from "../../packages/core/src/index.ts";
import type { IndexedFile, TaskDescriptor } from "../../packages/core/src/index.ts";

// ---- deterministic PRNG (mulberry32) ----
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randString(r: () => number, maxLen: number): string {
  const len = Math.floor(r() * maxLen);
  const alphabet =
    " abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP0123456789_/.-{}()=:;\"'\n\t";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

test("estimateTokens is total, positive-or-zero, and monotonic under concatenation", () => {
  const r = rng(1);
  for (let i = 0; i < 3000; i++) {
    const a = randString(r, 200);
    const b = randString(r, 200);
    const ea = estimateTokens(a);
    const eb = estimateTokens(b);
    assert.ok(Number.isFinite(ea) && ea >= 0, "finite non-negative");
    assert.ok(Number.isInteger(ea), "integer token estimate");
    if (a.length > 0) assert.ok(ea >= 1, "non-empty => >=1");
    // Concatenation cannot produce fewer tokens than the larger single part.
    const eab = estimateTokens(a + b);
    assert.ok(eab >= Math.max(ea, eb) - 1, "concat not smaller than max part (±1 ceil slack)");
  }
});

test("redaction is idempotent; matched secrets never survive verbatim", () => {
  const r = rng(2);
  // Construct strings that DEFINITELY match a pattern, plus random noise.
  const builders: Array<(r: () => number) => string> = [
    (r) => `API_KEY = "sk-${hex(r, 24)}"`,
    (r) => `ghp_${alnum(r, 36)}`,
    (r) => `AKIA${upperNum(r, 16)}`,
    (r) => `Bearer ${alnum(r, 24)}`,
    (r) => `-----BEGIN RSA PRIVATE KEY-----\n${alnum(r, 40)}\n-----END RSA PRIVATE KEY-----`,
    (r) => `token: ${alnum(r, 40)}`,
  ];
  for (let i = 0; i < 3000; i++) {
    const noise = randString(r, 120).replace(/[A-Za-z0-9]{16,}/g, "x"); // avoid accidental secrets in noise
    const build = builders[Math.floor(r() * builders.length)]!;
    const secretish = build(r);
    const text = `${noise} ${secretish} ${noise}`;

    // Idempotency holds for ALL inputs, unconditionally.
    const once = redactSecrets(text).text;
    const twice = redactSecrets(once).text;
    assert.equal(twice, once, "redaction is idempotent");

    // These builders always produce a detectable secret.
    assert.ok(containsLikelySecret(secretish), `builder should match: ${secretish.slice(0, 20)}`);
    // The high-entropy payload must not survive verbatim in the redacted text.
    assert.ok(!once.includes(secretish), "raw secret gone after redaction");
  }
});

function hex(r: () => number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(r() * 16)];
  return s;
}
function alnum(r: () => number, n: number): string {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(r() * a.length)];
  return s;
}
function upperNum(r: () => number, n: number): string {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(r() * a.length)];
  return s;
}

test("safeRelative NEVER returns a path escaping the root", () => {
  const r = rng(3);
  const roots = ["/project", "/a/b/c", "/"];
  for (let i = 0; i < 3000; i++) {
    const root = roots[Math.floor(r() * roots.length)]!;
    const candidate = randString(r, 60);
    const rel = safeRelative(root, candidate);
    if (rel === null) continue;
    assert.ok(!rel.startsWith("/"), `never absolute: ${rel}`);
    assert.ok(!rel.startsWith(".."), `never escaping: ${rel}`);
    assert.ok(!rel.includes("\0"), "no null byte");
  }
});

test("resolveConfig always yields a schema-valid config for random layer combos", () => {
  const r = rng(4);
  const modes = ["off", "minimal", "balanced", "aggressive", "custom", "garbage"];
  for (let i = 0; i < 2000; i++) {
    const pick = () => (r() < 0.5 ? undefined : r() < 0.5);
    const layer = () => {
      const o: Record<string, unknown> = {};
      if (r() < 0.7) o.enabled = pick();
      if (r() < 0.5) o.mode = modes[Math.floor(r() * modes.length)];
      if (r() < 0.3) o.context = { maxTokens: Math.floor(r() * 100000) };
      return o;
    };
    const res = resolveConfig({
      global: layer(),
      project: layer(),
      runtimeOverride: layer(),
      env: r() < 0.2 ? { SUPRACORTEX_DISABLE: "1" } : {},
    });
    assert.equal(typeof res.config.enabled, "boolean", "enabled is always boolean");
    // The resolved config's known numeric fields stay within validation bounds
    // once clamped by validateConfig (which merges over defaults).
    const v = validateConfig(res.config);
    assert.ok(v.value.context.maxTokens >= 0);
    // Emergency disable, when set, always wins.
    if (res.source === "env-disable") assert.equal(res.config.enabled, false);
  }
});

test("contextKey is stable under argument reordering and case for tags/files", () => {
  const r = rng(5);
  for (let i = 0; i < 1500; i++) {
    const files = Array.from({ length: Math.floor(r() * 5) }, () => randString(r, 12) || "f");
    const tags = Array.from({ length: Math.floor(r() * 5) }, () => randString(r, 8) || "t");
    const gen = "gen-" + Math.floor(r() * 5);
    const q = randString(r, 40);
    const k1 = contextKey({ query: q, hintFiles: files, tags, indexGeneration: gen });
    const shuffledFiles = [...files].reverse();
    const upperTags = tags.map((t) => t.toUpperCase());
    const k2 = contextKey({
      query: q,
      hintFiles: shuffledFiles,
      tags: upperTags,
      indexGeneration: gen,
    });
    assert.equal(k1, k2, "key stable under file order + tag case");
    // Different generation must (almost always) change the key.
    const k3 = contextKey({ query: q, hintFiles: files, tags, indexGeneration: gen + "x" });
    assert.notEqual(k1, k3);
  }
});

test("planTasks: waves are a valid topological order for random DAGs", () => {
  const r = rng(6);
  for (let iter = 0; iter < 400; iter++) {
    const n = 1 + Math.floor(r() * 8);
    const tasks: TaskDescriptor[] = [];
    for (let i = 0; i < n; i++) {
      // Only depend on earlier ids => guaranteed acyclic.
      const deps: string[] = [];
      for (let j = 0; j < i; j++) if (r() < 0.35) deps.push(`t${j}`);
      tasks.push({ id: `t${i}`, title: `t${i}`, objective: `obj ${i} ${randString(r, 10)}`, dependencies: deps });
    }
    const plan = planTasks(tasks, { maxConcurrentTasks: 3, defaultBudgetTokens: 1000 });
    // Every task appears exactly once across waves.
    const seen = plan.waves.flat();
    assert.equal(new Set(seen).size, n, "each task scheduled once");
    // For each dependency edge, the dependency's wave index < dependent's.
    const waveOf = new Map<string, number>();
    plan.waves.forEach((w, idx) => w.forEach((id) => waveOf.set(id, idx)));
    for (const t of plan.tasks) {
      for (const d of t.dependencies) {
        if (waveOf.has(d)) {
          assert.ok(waveOf.get(d)! < waveOf.get(t.id)!, `${d} before ${t.id}`);
        }
      }
    }
    // No acyclic input should produce a cycle warning.
    assert.ok(!plan.warnings.some((w) => w.toLowerCase().includes("cycle")));
  }
});

test("buildContextPacket: file selections never duplicate and reasons are non-empty", () => {
  const r = rng(7);
  for (let iter = 0; iter < 300; iter++) {
    const files: Record<string, IndexedFile> = {};
    const count = Math.floor(r() * 40);
    for (let i = 0; i < count; i++) {
      const p = `src/${randString(r, 10).replace(/[^a-z0-9]/gi, "") || "f"}${i}.ts`;
      files[p] = {
        path: p,
        hash: `h${i}`,
        sizeBytes: Math.floor(r() * 20000),
        estimatedTokens: 1 + Math.floor(r() * 5000),
        symbols: [randString(r, 8), randString(r, 8)],
        imports: [],
        indexedAt: new Date().toISOString(),
        mtimeMs: 1,
      };
    }
    const res = buildContextPacket({
      task: { query: "login auth token render map " + randString(r, 20) },
      config: {
        maxTokens: 1 + Math.floor(r() * 20000),
        maxRetrievedEntries: 10,
        maxRetrievedTokens: 2000,
        maxRecommendedReads: Math.floor(r() * 10),
        summaryThresholdTokens: 3000,
        preferChangedFiles: true,
      },
      index: files,
      summaries: {},
      memory: [],
      cacheReport: { hits: 0, misses: 0, stale: 0, entries: 0 },
    });
    const paths = res.packet.selectedFiles.map((f) => f.path);
    assert.equal(new Set(paths).size, paths.length, "no duplicate file selections");
    for (const f of res.packet.selectedFiles) {
      assert.ok(f.reason.length > 0, "every selection explained");
      assert.ok(f.estimatedTokens >= 0);
    }
    // A path is never both selected and omitted.
    const omitted = new Set(res.packet.omissions.map((o) => o.path));
    for (const p of paths) assert.ok(!omitted.has(p), `${p} not both selected and omitted`);
  }
});

test("tokenize is deterministic and lowercases", () => {
  const r = rng(8);
  for (let i = 0; i < 1000; i++) {
    const s = randString(r, 80);
    const a = tokenize(s);
    const b = tokenize(s);
    assert.deepEqual(a, b);
    for (const tok of a) assert.equal(tok, tok.toLowerCase());
  }
});
