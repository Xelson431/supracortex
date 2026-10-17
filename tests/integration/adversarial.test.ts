/**
 * Adversarial security tests. Each attempts to defeat a documented guarantee:
 * no secret persisted, no path escape, no data corruption from hostile input.
 * All must be blocked.
 */
import test from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, readdir, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, JsonlStore, resolveConfig } from "../../packages/core/src/index.ts";

async function engineIn(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ci-adv-"));
  const { config } = resolveConfig({ project: { enabled: true, ...overrides } });
  const store = new JsonlStore(join(dir, ".supracortex"));
  const engine = new Engine({ config, store, pluginVersion: "0.1.0", projectRoot: dir });
  return { dir, engine, store };
}

/** Read every file under the storage dir and return concatenated raw text. */
async function dumpStorage(dir: string): Promise<string> {
  const root = join(dir, ".supracortex");
  let out = "";
  async function walk(d: string) {
    let entries: string[] = [];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      try {
        const { stat } = await import("node:fs/promises");
        const st = await stat(p);
        if (st.isDirectory()) await walk(p);
        else out += await readFile(p, "utf8");
      } catch {
        /* ignore */
      }
    }
  }
  await walk(root);
  return out;
}

const CANARY = "sk-CANARY0123456789abcdefSECRET";

test("secret in memory content cannot reach disk", async () => {
  const { dir, engine } = await engineIn();
  await engine.recordMemory({
    kind: "failure",
    content: `build broke because API_KEY = "${CANARY}" was committed`,
    confidence: 0.9,
  });
  const raw = await dumpStorage(dir);
  assert.ok(!raw.includes(CANARY), "canary must not be on disk anywhere");
});

test("secret hidden in a source-reference note cannot reach disk", async () => {
  const { dir, engine } = await engineIn();
  await engine.recordMemory({
    kind: "decision",
    content: "rotate keys quarterly",
    confidence: 0.9,
    sourceReferences: [{ kind: "external", value: "https://ok", note: `token=${CANARY}` }],
  });
  const raw = await dumpStorage(dir);
  assert.ok(!raw.includes(CANARY));
});

test("secret in every outcome text field cannot reach disk", async () => {
  const { dir, engine } = await engineIn();
  await engine.recordOutcome({
    taskId: "t",
    status: "failure",
    summary: `leaked ${CANARY}`,
    touchedFiles: [],
    learnings: [`also here ${CANARY}`],
    failureReason: `Bearer ${CANARY}`,
    recordedAt: new Date().toISOString(),
  });
  const raw = await dumpStorage(dir);
  assert.ok(!raw.includes(CANARY));
});

test("absolute + traversal paths in memory refs/relatedFiles are neutralized", async () => {
  const { dir, engine } = await engineIn();
  const res = await engine.recordMemory({
    kind: "fact",
    content: "config location",
    confidence: 0.9,
    sourceReferences: [
      { kind: "file", value: "/etc/passwd" },
      { kind: "file", value: "../../.ssh/id_rsa" },
      { kind: "file", value: "src/ok.ts" },
    ],
    relatedFiles: ["/etc/shadow", "../secrets.env", "src/ok.ts"],
  });
  const raw = await dumpStorage(dir);
  assert.ok(!raw.includes("/etc/passwd"));
  assert.ok(!raw.includes("id_rsa"));
  assert.ok(!raw.includes("/etc/shadow"));
  // The one legitimate in-project ref survives.
  assert.ok(res.entry!.sourceReferences.some((r) => r.value === "src/ok.ts"));
});

test("storage adapter refuses to write outside its root via ../ keys", async () => {
  const { store } = await engineIn();
  await assert.rejects(() => store.writeJson("../../evil.json", { x: 1 }));
  await assert.rejects(() => store.appendJsonl("../escape.jsonl", [{ x: 1 }]));
  await assert.rejects(() => store.readJsonl("../../etc/passwd"));
});

test("indexer never indexes .env / key / credential files even if relevant-named", async () => {
  const { dir, engine } = await engineIn();
  await writeFile(join(dir, ".env"), `SECRET=${CANARY}\n`, "utf8");
  await writeFile(join(dir, "server.key"), CANARY, "utf8");
  await mkdir(join(dir, "secrets"), { recursive: true });
  await writeFile(join(dir, "secrets", "prod.yml"), `token: ${CANARY}\n`, "utf8");
  await writeFile(join(dir, "app.ts"), "export const ok = 1;\n", "utf8");
  const index = await engine.ensureIndex();
  const paths = Object.keys(index.files);
  assert.ok(paths.includes("app.ts"), "normal file indexed");
  assert.ok(!paths.some((p) => p.includes(".env")), "no .env");
  assert.ok(!paths.some((p) => p.endsWith(".key")), "no key file");
  assert.ok(!paths.some((p) => p.startsWith("secrets/")), "no secrets dir");
  // And the index file on disk never contains the canary.
  const raw = await dumpStorage(dir);
  assert.ok(!raw.includes(CANARY));
});

test("prototype-pollution-shaped keys in task input do not corrupt globals", async () => {
  const { engine } = await engineIn();
  const plan = engine.planTasks([
    { id: "__proto__", title: "x", objective: "o", writeScope: ["a"] },
    { id: "constructor", title: "y", objective: "o2", writeScope: ["b"] },
  ]);
  assert.ok(plan);
  // Global Object prototype must be untouched.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test("giant hostile query does not throw and respects budget", async () => {
  const { engine } = await engineIn();
  const huge = "login ".repeat(100000); // ~600k chars
  const packet = await engine.prepareContext({ query: huge, maxTokens: 500 });
  assert.ok(packet);
  // taskSummary is capped to 500 chars.
  assert.ok(packet!.taskSummary.length <= 500);
});

test("disabled engine writes NOTHING to disk under any call", async () => {
  const { dir, engine } = await engineIn({ enabled: false });
  await engine.prepareContext({ query: "x" });
  await engine.recordMemory({ kind: "failure", content: "y", confidence: 0.9 });
  await engine.recordOutcome({
    taskId: "t",
    status: "success",
    summary: "s",
    touchedFiles: [],
    recordedAt: new Date().toISOString(),
  });
  engine.planTasks([{ title: "t", objective: "o" }]);
  // No storage directory contents at all.
  const raw = await dumpStorage(dir);
  assert.equal(raw, "", "disabled engine left no data on disk");
});

test("corrupted + partially-valid JSONL never throws and recovers valid rows", async () => {
  const { dir, engine, store } = await engineIn();
  await engine.recordMemory({
    kind: "failure",
    content: "real entry one",
    confidence: 0.9,
  });
  // Inject garbage lines around the real one.
  const file = join(dir, ".supracortex", "memory", "failures.jsonl");
  const good = await readFile(file, "utf8");
  await writeFile(
    file,
    `{bad json\n${good}\x00\x01 not json\n{"partial":\n` + good,
    "utf8",
  );
  const res = await store.readJsonl(file.split(".supracortex/")[1]!);
  assert.ok(res.corruptLines >= 2, "counts corrupt lines");
  assert.ok(res.entries.length >= 1, "recovers valid rows");
  // Search still works despite corruption.
  const found = await engine.searchMemory("real entry");
  assert.ok(Array.isArray(found));
});
