import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushInjectionGateMirror, resetInjectionGateState, sanitizeLegacyInjectionMirror, setInjectionGateStateDir, shouldInject, SupraCortex } from "../../packages/opencode/src/plugin.ts";

test("injection gate mirror writes asynchronously and preserves decision order", async () => {
  const root = await mkdtemp(join(tmpdir(), "scx-opencode-gate-mirror-"));
  const stateDir = join(root, "state");
  setInjectionGateStateDir(stateDir);
  resetInjectionGateState();
  try {
    const first = shouldInject({ sessionId: "s", query: "one", gateActive: true, packetState: "empty" });
    const second = shouldInject({ sessionId: "s", query: "two", gateActive: true, packetState: "renderable" });
    assert.equal(first.reason, "empty-packet");
    assert.equal(second.reason, "injected");
    await flushInjectionGateMirror();
    const mirrored = JSON.parse(await readFile(join(stateDir, "injection.json"), "utf8")) as { reason: string; lastSkipReason: string; requestId: string };
    assert.equal(mirrored.reason, "injected");
    assert.equal(mirrored.lastSkipReason, "empty-packet");
    // Persisted ids are digests: the mirror must never carry the raw session
    // id or query text (privacy invariant).
    assert.match(mirrored.requestId, /^ctx-[0-9a-f]{32}$/);
    assert.ok(!mirrored.requestId.includes("two"));
  } finally {
    await flushInjectionGateMirror();
    setInjectionGateStateDir(null);
    resetInjectionGateState();
  }
});

test("legacy purge is ordered before subsequent mirror writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scx-opencode-gate-purge-order-"));
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  const target = join(stateDir, "injection.json");
  // Real legacy shape: the NUL in the request id is the escaped `\u0000`
  // sequence, so this parses as valid JSON and has no raw NUL byte.
  await writeFile(target, JSON.stringify({
    reason: "injected",
    lastSkipReason: null,
    lastInjectionAt: null,
    requestId: "sess\u0000full user query",
  }), "utf8");
  setInjectionGateStateDir(stateDir);
  resetInjectionGateState();
  try {
    // Fire the purge first, then queue a fresh decision: the purge must not
    // unlink the sanitized mirror written afterwards.
    const purge = sanitizeLegacyInjectionMirror(stateDir);
    const decision = shouldInject({ sessionId: "s", query: "fresh", gateActive: true, packetState: "renderable" });
    assert.equal(decision.reason, "injected");
    await purge;
    await flushInjectionGateMirror();

    const raw = await readFile(target, "utf8");
    assert.ok(!raw.includes("full user query"), "legacy query text must not survive");
    const mirrored = JSON.parse(raw) as { reason: string; requestId: string };
    assert.equal(mirrored.reason, "injected");
    assert.equal(mirrored.requestId, decision.requestId);
    assert.match(mirrored.requestId, /^ctx-[0-9a-f]{32}$/);
  } finally {
    await flushInjectionGateMirror();
    setInjectionGateStateDir(null);
    resetInjectionGateState();
  }
});

test("OpenCode native hooks carry the real user task into automatic context", async () => {
  const root = await mkdtemp(join(tmpdir(), "scx-opencode-hook-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(join(root, ".supracortex", "config.jsonc"), '{"enabled":true}\n', "utf8");
  await writeFile(join(root, "src", "auth.ts"), "export function login() { return true; }\n", "utf8");

  const hooks = await SupraCortex({
    directory: root,
    worktree: root,
    client: {},
    $: async () => ({ stdout: "" }),
  } as never);
  try {
    const messages = {
      messages: [{
        info: { role: "user", sessionID: "hook-session", agent: "orchestrator" },
        parts: [{ type: "text", text: "Inspect the login function in auth.ts" }],
      }],
    };
    await hooks["experimental.chat.messages.transform"]?.({} as never, messages as never);
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "hook-session", model: {} as never } as never,
      output as never,
    );
    assert.equal(output.system.length, 1, "a real user message must produce one context packet");
    assert.match(output.system[0]!, /supracortex:packet/);
    assert.match(output.system[0]!, /auth\.ts/);
  } finally {
    await hooks.dispose?.();
  }
});

test("message.updated renews the heartbeat for the matching active session", async () => {
  const root = await mkdtemp(join(tmpdir(), "scx-opencode-heartbeat-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(join(root, ".supracortex", "config.jsonc"), '{"enabled":true}\n', "utf8");
  await writeFile(join(root, "src", "auth.ts"), "export function login() { return true; }\n", "utf8");
  const hooks = await SupraCortex({ directory: root, worktree: root, client: {}, $: async () => ({ stdout: "" }) } as never);
  try {
    const claim = (hooks.tool as unknown as Record<string, { execute: (args: Record<string, unknown>, context: never) => Promise<unknown> }>)["cortex_claim_files"]!;
    await claim.execute({ taskId: "heartbeat-task", files: ["src/auth.ts"] }, {} as never);
    const before = JSON.parse(await readFile(join(root, ".supracortex", "tasks", "active.json"), "utf8")) as { tasks: Array<{ lastSeenAt: string }> };
    const old = before.tasks[0]!.lastSeenAt;
    // The task created by the tool has no session binding; bind it through a
    // persisted active record, then drive the real event hook.
    const current = JSON.parse(await readFile(join(root, ".supracortex", "tasks", "active.json"), "utf8")) as { tasks: Array<Record<string, unknown>> };
    current.tasks[0]!.sessionId = "heartbeat-session";
    current.tasks[0]!.lastSeenAt = "2020-01-01T00:00:00.000Z";
    await writeFile(join(root, ".supracortex", "tasks", "active.json"), JSON.stringify(current), "utf8");
    await hooks.event?.({ event: { type: "message.updated", properties: { sessionID: "heartbeat-session" } } } as never);
    const after = JSON.parse(await readFile(join(root, ".supracortex", "tasks", "active.json"), "utf8")) as { tasks: Array<{ lastSeenAt: string }> };
    assert.notEqual(after.tasks[0]!.lastSeenAt, "2020-01-01T00:00:00.000Z");
    assert.notEqual(after.tasks[0]!.lastSeenAt, old);
  } finally { await hooks.dispose?.(); }
});

test("message.updated heartbeat is debounced and refreshes again outside the window", async () => {
  const root = await mkdtemp(join(tmpdir(), "scx-opencode-heartbeat-debounce-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(join(root, ".supracortex", "config.jsonc"), '{"enabled":true}\n', "utf8");
  await writeFile(join(root, "src", "auth.ts"), "export function login() { return true; }\n", "utf8");
  const hooks = await SupraCortex({ directory: root, worktree: root, client: {}, $: async () => ({ stdout: "" }) } as never);
  const originalNow = Date.now;
  try {
    const claim = (hooks.tool as unknown as Record<string, { execute: (args: Record<string, unknown>, context: never) => Promise<unknown> }>)['cortex_claim_files']!;
    await claim.execute({ taskId: "debounced-task", files: ["src/auth.ts"] }, {} as never);
    const activePath = join(root, ".supracortex", "tasks", "active.json");
    const active = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<Record<string, unknown>> };
    active.tasks[0]!.sessionId = "debounce-session";
    active.tasks[0]!.lastSeenAt = new Date().toISOString();
    await writeFile(activePath, JSON.stringify(active), "utf8");

    let now = 1_000_000;
    Date.now = () => now;
    const event = () => hooks.event?.({ event: { type: "message.updated", properties: { sessionID: "debounce-session" } } } as never);
    await event();
    const first = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<{ lastSeenAt: string }> };
    now += 1;
    await event();
    const second = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<{ lastSeenAt: string }> };
    assert.equal(second.tasks[0]!.lastSeenAt, first.tasks[0]!.lastSeenAt);
    now += 6_000;
    await event();
    const later = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<{ lastSeenAt: string }> };
    assert.notEqual(later.tasks[0]!.lastSeenAt, first.tasks[0]!.lastSeenAt);
  } finally {
    Date.now = originalNow;
    await hooks.dispose?.();
  }
});

test("session.deleted for an unobserved session does not reap another session's task", async () => {
  const root = await mkdtemp(join(tmpdir(), "scx-opencode-session-delete-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(join(root, ".supracortex", "config.jsonc"), '{"enabled":true}\n', "utf8");
  await writeFile(join(root, "src", "auth.ts"), "export function login() { return true; }\n", "utf8");
  const hooks = await SupraCortex({ directory: root, worktree: root, client: {}, $: async () => ({ stdout: "" }) } as never);
  try {
    const claim = (hooks.tool as unknown as Record<string, { execute: (args: Record<string, unknown>, context: never) => Promise<unknown> }>)['cortex_claim_files']!;
    await claim.execute({ taskId: "session-b-task", files: ["src/auth.ts"] }, {} as never);
    const activePath = join(root, ".supracortex", "tasks", "active.json");
    const ownershipPath = join(root, ".supracortex", "tasks", "ownership.json");
    const active = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<Record<string, unknown>> };
    active.tasks[0]!.sessionId = "session-b";
    active.tasks[0]!.lastSeenAt = new Date().toISOString();
    await writeFile(activePath, JSON.stringify(active), "utf8");

    await hooks.event?.({ event: { type: "session.deleted", properties: { sessionID: "session-a" } } } as never);

    const after = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<{ taskId: string; sessionId?: string }> };
    const ownership = JSON.parse(await readFile(ownershipPath, "utf8")) as { claims: Record<string, { taskId: string }> };
    assert.deepEqual(after.tasks.filter((task) => task.taskId === "session-b-task").map((task) => task.sessionId), ["session-b"]);
    assert.equal(ownership.claims["src/auth.ts"]?.taskId, "session-b-task");
  } finally {
    await hooks.dispose?.();
  }
});

test("session.deleted for observed session A reaps A and never treats the observed set as a census for B", async () => {
  const root = await mkdtemp(join(tmpdir(), "scx-opencode-session-census-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".supracortex"), { recursive: true });
  await writeFile(join(root, ".supracortex", "config.jsonc"), '{"enabled":true}\n', "utf8");
  await writeFile(join(root, "src", "auth.ts"), "export function login() { return true; }\n", "utf8");
  await writeFile(join(root, "src", "util.ts"), "export const clamp = (n: number) => n;\n", "utf8");
  const hooks = await SupraCortex({ directory: root, worktree: root, client: {}, $: async () => ({ stdout: "" }) } as never);
  try {
    const claim = (hooks.tool as unknown as Record<string, { execute: (args: Record<string, unknown>, context: never) => Promise<unknown> }>)['cortex_claim_files']!;
    await claim.execute({ taskId: "census-task-a", files: ["src/auth.ts"] }, {} as never);
    await claim.execute({ taskId: "census-task-b", files: ["src/util.ts"] }, {} as never);

    const activePath = join(root, ".supracortex", "tasks", "active.json");
    const ownershipPath = join(root, ".supracortex", "tasks", "ownership.json");
    const completedPath = join(root, ".supracortex", "tasks", "completed.jsonl");
    const readOutcomes = async () => {
      const raw = await readFile(completedPath, "utf8");
      return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    // Bind the two tasks to two different sessions. Session A is observed by
    // the plugin; session B's session.created is NEVER delivered, so B is
    // absent from the plugin's locally observed live-session set.
    const active = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<Record<string, unknown>> };
    for (const task of active.tasks) {
      if (task.taskId === "census-task-a") task.sessionId = "census-session-a";
      if (task.taskId === "census-task-b") task.sessionId = "census-session-b";
      task.lastSeenAt = new Date().toISOString();
    }
    await writeFile(activePath, JSON.stringify(active), "utf8");

    await hooks.event?.({ event: { type: "session.created", properties: { sessionID: "census-session-a" } } } as never);
    await hooks.event?.({ event: { type: "session.deleted", properties: { sessionID: "census-session-a" } } } as never);

    // A's task is reaped: inferred outcome persisted, active cleared, claim released.
    const after = JSON.parse(await readFile(activePath, "utf8")) as { tasks: Array<{ taskId: string; sessionId?: string }> };
    assert.equal(after.tasks.some((task) => task.taskId === "census-task-a"), false, "A's task must be reaped from active.json");
    const ownership = JSON.parse(await readFile(ownershipPath, "utf8")) as { claims: Record<string, { taskId: string }> };
    assert.equal(ownership.claims["src/auth.ts"], undefined, "A's claim must be released");
    const completed = await readOutcomes();
    assert.ok(
      completed.some((entry) => entry.taskId === "census-task-a" && entry.source === "inferred"),
      "A's task must have exactly an inferred outcome",
    );

    // B's task is fully intact: no inferred outcome, claim still held, active record present.
    assert.equal(completed.some((entry) => entry.taskId === "census-task-b"), false, "B must have no inferred outcome");
    assert.equal(ownership.claims["src/util.ts"]?.taskId, "census-task-b", "B's claim must survive");
    assert.equal(
      after.tasks.some((task) => task.taskId === "census-task-b" && task.sessionId === "census-session-b"),
      true,
      "B's active record must remain bound to its session",
    );
  } finally {
    await hooks.dispose?.();
  }
});
