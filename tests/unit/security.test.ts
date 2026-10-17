import test from "node:test";
import assert from "node:assert";
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
  assert.equal(resolveProjectStorageDirectory("/project", ".supracortex"), "/project/.supracortex");
  assert.throws(() => resolveProjectStorageDirectory("/project", "../outside"), /escapes/);
  assert.throws(() => resolveProjectStorageDirectory("/project", "/tmp/outside"), /escapes/);
  assert.throws(() => resolveProjectStorageDirectory("/project", "."), /non-root/);
});
