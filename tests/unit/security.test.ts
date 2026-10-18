import test from "node:test";
import assert from "node:assert";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, win32 } from "node:path";
import {
  redactSecrets,
  containsLikelySecret,
  isSecretFile,
  safeRelative,
  resolveProjectStorageDirectory,
} from "../../packages/core/src/index.ts";

test("redacts common secret shapes", () => {
  const samples = [
    'API_KEY = "sk-abcdef0123456789abcdef"',
    "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcd1234567890EXAMPLEKEY",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.signaturepart",
    "token: ghp_0123456789abcdefghijABCDEFGHIJ0123",
  ];
  for (const s of samples) {
    const r = redactSecrets(s);
    assert.ok(r.redactedCount > 0, `should redact: ${s}`);
    assert.ok(r.text.includes("[REDACTED]"), `placeholder in: ${s}`);
    assert.ok(!/sk-abcdef0123456789/.test(r.text));
  }
});

test("does not over-redact plain prose", () => {
  const r = redactSecrets("The user clicked the login button and saw a dashboard.");
  assert.equal(r.redactedCount, 0);
});

test("double-redact is idempotent and count does not inflate", () => {
  const secret = 'API_KEY = "sk-abcdef0123456789abcdef"';
  const first = redactSecrets(secret);
  assert.ok(first.redactedCount > 0);
  const second = redactSecrets(first.text);
  assert.equal(second.text, first.text, "second pass is a fixed point");
  assert.equal(second.redactedCount, 0, "already-redacted input adds no count");
});

test("redaction is bounded fail-closed with count summary", async () => {
  const { MAX_REDACT_INPUT_CHARS, redactionSummary } = await import(
    "../../packages/core/src/memory/validation.ts"
  );
  const huge = `token=${"a".repeat(MAX_REDACT_INPUT_CHARS + 1000)}`;
  const r = redactSecrets(huge);
  assert.ok(r.text.includes("[REDACTED: input truncated]"), "tail fail-closed");
  assert.ok(r.text.length < huge.length, "output bounded");
  assert.ok(!r.text.includes("a".repeat(64)), "raw tail never passes through");
  const summary = redactionSummary(r);
  assert.equal(summary.redacted, true);
  assert.equal(summary.redactedCount, r.redactedCount);
  assert.equal(redactionSummary(redactSecrets("plain prose")).redacted, false);
});
test("containsLikelySecret detects PEM keys", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(containsLikelySecret(pem), true);
});

test("isSecretFile matches env and key files", () => {
  assert.equal(isSecretFile(".env"), true);
  assert.equal(isSecretFile("config/.env.production"), true);
  assert.equal(isSecretFile("certs/server.key"), true);
  assert.equal(isSecretFile("src/index.ts"), false);
});

test("safeRelative rejects traversal", () => {
  assert.equal(safeRelative("/project", "/project/src/a.ts"), "src/a.ts");
  assert.equal(safeRelative("/project", "/etc/passwd"), null);
  assert.equal(safeRelative("/project", "../outside.ts"), null);
});

test("storage directory is confined to the selected project", () => {
  const projectRoot = resolve("/project");
  assert.equal(resolveProjectStorageDirectory("/project", ".supracortex"), join(projectRoot, ".supracortex"));
  assert.throws(() => resolveProjectStorageDirectory("/project", "../outside"), /escapes/);
  assert.throws(() => resolveProjectStorageDirectory("/project", "/tmp/outside"), /escapes/);
  assert.throws(() => resolveProjectStorageDirectory("/project", "."), /non-root/);
});

test("resolveConfinedPath accepts an inside absolute target and rejects outside", async () => {
  const { resolveConfinedPath } = await import("../../packages/core/src/storage/safe-path.ts");
  // realpath the temp root so the returned physical path is directly comparable.
  const root = await realpath(await mkdtemp(join(tmpdir(), "sc-confined-")));
  try {
    // Callers such as JsonlStore.resolveSafe pass an already-resolved absolute
    // target; that is a drive path on Windows and must be accepted there.
    const inside = join(root, "store", "nested", "x.jsonl");
    const accepted = await resolveConfinedPath(root, inside, { allowMissingRoot: true });
    assert.equal(accepted, inside, "absolute target inside the root is accepted");
    assert.equal(relative(root, accepted).startsWith(".."), false, "result stays inside the root");

    const outside = resolve(root, "..", "outside.jsonl");
    await assert.rejects(
      resolveConfinedPath(root, outside, { allowMissingRoot: true }),
      /outside project\/storage root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "resolveConfinedPath accepts Windows drive absolutes and rejects cross-drive/UNC on win32",
  { skip: process.platform !== "win32" },
  async () => {
    const { resolveConfinedPath } = await import("../../packages/core/src/storage/safe-path.ts");
    const root = await realpath(await mkdtemp(join(tmpdir(), "sc-confined-win-")));
    try {
      // win32.join shapes exercise the drive-letter absolute form directly.
      const inside = win32.join(root, "store", "x.jsonl");
      assert.equal(
        await resolveConfinedPath(root, inside, { allowMissingRoot: true }),
        inside,
      );
      await assert.rejects(
        resolveConfinedPath(root, win32.join("Z:\\", "outside.jsonl"), { allowMissingRoot: true }),
        /outside project\/storage root/,
      );
      await assert.rejects(
        resolveConfinedPath(root, "\\\\server\\share\\outside.jsonl", { allowMissingRoot: true }),
        /outside project\/storage root/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
