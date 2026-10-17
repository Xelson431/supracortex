/**
 * Release-promise lifecycle evaluation.
 *
 * Proves the end-to-end knowledge loop with two Engine instances over the same
 * project root (simulated sessions): record -> recover -> correct -> handoff ->
 * evidence-driven invalidation/recovery -> age.
 *
 * This is a deterministic presence/absence test, not a retrieval-quality
 * benchmark: it never measures recall, MRR, tokens, or latency. Clock inputs
 * are injected, fixtures are one tiny source file plus entries created through
 * engine APIs, and no network or external service is used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  Engine,
  JsonlStore,
  resolveConfig,
  type ContextPacket,
  type MemoryEntry,
  type PartialConfig,
} from "../../packages/core/src/index.ts";

const STORAGE = ".supracortex";
const DAY = 86_400_000;
const EVIDENCE_FILE = "src/auth.ts";

interface Clock {
  now: () => number;
  advanceDays: (days: number) => void;
}

function makeClock(startIso: string): Clock {
  const state = { t: Date.parse(startIso) };
  return {
    now: () => state.t,
    advanceDays(days: number) {
      state.t += days * DAY;
    },
  };
}

async function makeProject(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, EVIDENCE_FILE), "export function login() { return true; }\n", "utf8");
  return dir;
}

/**
 * A fresh Engine over the same root simulates a new host session. Shared
 * storage is created per engine (like the continuity tests); the JSONL store
 * is the source of truth both sessions read.
 */
function engineOn(
  dir: string,
  now: () => number = () => Date.now(),
  overrides: PartialConfig = {},
): Engine {
  const { config } = resolveConfig({
    defaults: DEFAULT_CONFIG,
    project: {
      enabled: true,
      // Keep the evaluation focused on memory lifecycle, not derived features.
      graph: { enabled: false },
      supraspace: { enabled: false },
      cache: { enabled: false },
      ...overrides,
    },
    env: {},
  });
  return new Engine({
    config,
    store: new JsonlStore(join(dir, STORAGE)),
    pluginVersion: "eval-workflow",
    projectRoot: dir,
    now,
    // No host file-mutation hook in this harness: always re-walk so fixtures
    // edited between calls are observed deterministically.
    indexCacheTtlMs: 0,
  });
}

async function recordEvidenceDecision(engine: Engine, content: string): Promise<MemoryEntry> {
  const rec = await engine.recordMemory({
    kind: "decision",
    content,
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: EVIDENCE_FILE }],
  });
  assert.equal(rec.status, "recorded");
  const entry = rec.entry;
  assert.ok(entry, "recorded memory entry is returned");
  return entry;
}

async function entriesWithStatus(engine: Engine, statuses: string[]): Promise<MemoryEntry[]> {
  return (await engine.review({ type: "list", statuses, limit: 100 })) as MemoryEntry[];
}

function selectedIds(packet: ContextPacket | null): string[] {
  return (packet?.selectedMemory ?? []).map((selection) => selection.entry.id);
}

interface RefreshResult {
  refreshed?: boolean;
  entryId?: string;
  status?: string;
  refs?: Array<{ file: string; oldHash: string; newHash: string }>;
  error?: string;
  missing?: string[];
}

test("workflow: a decision recorded in one session is recovered in the next", async () => {
  const dir = await makeProject("sc-eval-recover-");
  const clock = makeClock("2026-03-01T00:00:00Z");

  const sessionA = engineOn(dir, clock.now);
  const entry = await recordEvidenceDecision(
    sessionA,
    "Checkout requests authenticate with idempotency keys minted by the payments gateway",
  );
  assert.equal(entry.status, "active", "file evidence activates a durable decision");

  const sessionB = engineOn(dir, clock.now);
  const packet = await sessionB.prepareContext({
    query: "how do checkout requests authenticate with idempotency keys",
  });
  assert.ok(packet);

  const hit = packet.selectedMemory.find((selection) => selection.entry.id === entry.id);
  assert.ok(hit, "new session recovers the decision");
  assert.equal(hit.entry.content, entry.content, "recovered content matches the record");
  assert.equal(hit.entry.status, "active", "recovered entry is not a candidate");
});

test("workflow: a correction supersedes the prior decision in a new session", async () => {
  const dir = await makeProject("sc-eval-correct-");
  const clock = makeClock("2026-03-01T00:00:00Z");
  const sessionA = engineOn(dir, clock.now);

  const first = await recordEvidenceDecision(
    sessionA,
    "Session cookies were the chosen authentication mechanism for the web app",
  );

  const corrected = await sessionA.recordMemory({
    kind: "decision",
    content: "Short lived signed JWT bearer tokens now guard API authentication at the gateway",
    confidence: 0.9,
    sourceReferences: [{ kind: "file", value: EVIDENCE_FILE }],
    supersedes: [first.id],
  });
  assert.equal(corrected.status, "recorded");
  const correction = corrected.entry;
  assert.ok(correction);
  assert.equal(correction.status, "active");
  assert.deepEqual(correction.supersedes, [first.id]);

  // History is collapsed through the explicit compaction path, never by
  // overwriting the prior entry.
  const compacted = await sessionA.compactMemory();
  assert.ok(
    compacted.auditTrail.some((row) => row.id === first.id && row.action === "superseded"),
    "compaction records the supersession",
  );

  const sessionB = engineOn(dir, clock.now);
  const listed = await entriesWithStatus(sessionB, ["active", "superseded"]);
  assert.equal(listed.find((e) => e.id === first.id)?.status, "superseded");

  const packet = await sessionB.prepareContext({
    query: "signed JWT bearer tokens guard API authentication at the gateway",
  });
  assert.ok(packet);
  const ids = selectedIds(packet);
  assert.ok(ids.includes(correction.id), "the correction is current knowledge");
  assert.ok(!ids.includes(first.id), "the superseded entry is not presented as current");
});

test("workflow: a handoff is resumed as data and never injected into context", async () => {
  const dir = await makeProject("sc-eval-handoff-");
  const clock = makeClock("2026-03-01T00:00:00Z");
  const sessionA = engineOn(dir, clock.now);

  const capsule = await sessionA.createHandoff({
    goal: "finish the zephyr-migration handoff",
    completedWork: ["mapped the remaining migration surface"],
    nextActions: ["add regression test for zephyr-migration", "delete the legacy flag"],
  });
  assert.ok(capsule);

  const sessionB = engineOn(dir, clock.now);
  const resumed = await sessionB.resumeHandoff(capsule.id);
  assert.ok(resumed, "new session resumes the capsule");
  assert.equal(resumed.capsule.goal, capsule.goal);
  assert.deepEqual(resumed.capsule.nextActions, capsule.nextActions);

  // The data-only contract: resuming must not synthesize a memory entry or
  // otherwise leak capsule text into automatic context.
  const packet = await sessionB.prepareContext({ query: "what should happen next" });
  assert.ok(packet);
  assert.equal(packet.selectedMemory.length, 0, "handoff is not injected as memory");
  assert.ok(
    !JSON.stringify(packet).includes("zephyr-migration"),
    "capsule text does not appear in the context packet",
  );
});

test("workflow: evidence change makes memory stale and explicit refresh then approve recovers it", async () => {
  const dir = await makeProject("sc-eval-evidence-");
  const clock = makeClock("2026-03-01T00:00:00Z");
  const sessionA = engineOn(dir, clock.now);

  const entry = await recordEvidenceDecision(
    sessionA,
    "The auth module returns a boolean login result",
  );
  const oldHash = entry.sourceReferences.find(
    (ref) => ref.kind === "file" && ref.value === EVIDENCE_FILE,
  )?.hash;
  assert.ok(oldHash, "file evidence is recorded with its content hash");

  await writeFile(join(dir, EVIDENCE_FILE), "export function login() { return 0; }\n", "utf8");
  await sessionA.ensureIndex(true);

  const stale = (await entriesWithStatus(sessionA, ["stale"])).find((e) => e.id === entry.id);
  assert.ok(stale, "changed evidence marks the entry stale");
  assert.ok(stale.tags.includes("evidence-stale"));

  const before = await sessionA.prepareContext({
    query: "auth module login boolean result",
  });
  assert.ok(before);
  assert.ok(!selectedIds(before).includes(entry.id), "stale entry is not silently useful");

  // Recovery is explicit and survives into a new session.
  const sessionB = engineOn(dir, clock.now);
  const refreshed = (await sessionB.review({
    type: "refresh-evidence",
    id: entry.id,
  })) as RefreshResult;
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.entryId, entry.id);
  assert.equal(refreshed.status, "stale", "refresh never activates by itself");
  assert.equal(refreshed.refs?.length, 1);
  assert.equal(refreshed.refs?.[0]?.file, EVIDENCE_FILE);

  const approved = (await sessionB.review({ type: "approve", id: entry.id })) as MemoryEntry;
  assert.equal(approved.status, "active");

  const after = await sessionB.prepareContext({
    query: "auth module login boolean result",
  });
  assert.ok(after);
  assert.ok(selectedIds(after).includes(entry.id), "recovered entry is retrievable again");

  const auditRows = (await readFile(join(dir, STORAGE, "memory", "review-audit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(auditRows.length, 1, "exactly one refresh audit row");
  assert.equal(auditRows[0]?.action, "refresh-evidence");
  assert.equal(auditRows[0]?.entryId, entry.id);
});

test("workflow: age flags for re-verification without hiding the entry", async () => {
  const dir = await makeProject("sc-eval-age-");
  const clock = makeClock("2026-03-01T00:00:00Z");
  const reverify = { staleness: { memoryReverifyDays: 30 } };
  const sessionA = engineOn(dir, clock.now, reverify);

  const entry = await recordEvidenceDecision(
    sessionA,
    "Deploys use the blue-green pipeline for every production release",
  );
  const originalUpdatedAt = entry.updatedAt;

  clock.advanceDays(31);
  const report = await sessionA.sweep("eval-age", { force: true });
  assert.ok(report);
  assert.ok(report.memoryFlaggedForReverify.includes(entry.id), "sweep flags the aged entry");

  const aged = (await entriesWithStatus(sessionA, ["active"])).find((e) => e.id === entry.id);
  assert.ok(aged, "age never demotes the entry");
  assert.equal(aged.status, "active");
  assert.ok(aged.needsReverifyAt, "age adds a re-verification marker");
  assert.equal(aged.updatedAt, originalUpdatedAt, "updatedAt is preserved");

  // A new session still retrieves it: the marker is advisory, not a hide.
  const sessionB = engineOn(dir, clock.now, reverify);
  const packet = await sessionB.prepareContext({
    query: "what pipeline do deploys use for production release",
  });
  assert.ok(packet);
  assert.ok(selectedIds(packet).includes(entry.id), "aged entry remains retrievable");
});
