/**
 * Secret detection/redaction and path-safety helpers used before any content
 * is persisted. These are conservative heuristics: they aim to avoid ever
 * writing credentials to disk, accepting occasional over-redaction.
 */

import { isAbsolute, relative, resolve } from "node:path";

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

const PLACEHOLDER = "[REDACTED]";

/** Upper bound for a single redaction pass. Larger inputs are redacted up to
 * the cap and the tail is fail-closed to a placeholder (never passed through
 * raw), keeping regex work bounded under adversarial input. */
export const MAX_REDACT_INPUT_CHARS = 500_000;
const TRUNCATION_NOTE = "[REDACTED: input truncated]";

/**
 * Patterns matching common secret shapes. Each is applied globally. Ordering is
 * broad-to-specific; overlapping matches are fine since replacement is idempotent.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Assignment forms: KEY = "..." / KEY: '...' for sensitive-looking names.
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._\-]{12,}/g,
  // OpenAI-style keys, including segmented prefixes (sk-live-, sk-proj-, sk-ant-).
  /\bsk-(?:[A-Za-z0-9]+-){0,3}[A-Za-z0-9]{16,}(?:-[A-Za-z0-9]{4,})*/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens.
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JWT (three base64url segments).
  /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
  // PEM private key blocks.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // Generic long hex/base64 blobs assigned to a key.
  /\b(?:secret|token|key|passwd|password)\b\s*[:=]\s*["']?[A-Za-z0-9+/=_\-]{20,}["']?/gi,
];

export function redactSecrets(input: string): RedactionResult {
  if (typeof input !== "string") return { text: PLACEHOLDER, redactedCount: 1 };
  let text = input;
  let truncated = false;
  if (text.length > MAX_REDACT_INPUT_CHARS) {
    text = text.slice(0, MAX_REDACT_INPUT_CHARS);
    truncated = true;
  }
  let redactedCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match) => {
      const eq = match.search(/[:=]/);
      const normalized = eq > 0 && eq < 40 ? `${match.slice(0, eq + 1)} ${PLACEHOLDER}` : PLACEHOLDER;
      // Idempotent double-redact: already-redacted matches normalize to
      // themselves and must not inflate the count.
      if (match.includes(PLACEHOLDER)) return normalized;
      redactedCount++;
      return normalized;
    });
  }
  if (truncated) {
    text += ` ${TRUNCATION_NOTE}`;
    redactedCount++;
  }
  return { text, redactedCount };
}

/** Minimal count summary for reports: how many secrets were redacted. */
export function redactionSummary(result: RedactionResult): { redactedCount: number; redacted: boolean } {
  return { redactedCount: result.redactedCount, redacted: result.redactedCount > 0 };
}

export function containsLikelySecret(input: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(input);
  });
}

/**
 * Filenames that should never be indexed/summarized or have contents persisted.
 */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/).*\.pem$/i,
  /(^|\/).*\.p12$/i,
  /(^|\/).*\.pfx$/i,
  /(^|\/).*\.key$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?(\.(json|ya?ml|toml))?$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  // Files inside a secrets-named directory (e.g. secrets/prod.yml, .secrets/x).
  /(^|\/)\.?secrets?\//i,
  /(^|\/)\.?credentials?\//i,
];

export function isSecretFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return SECRET_FILE_PATTERNS.some((p) => p.test(norm));
}

/**
 * Ensure a candidate absolute path stays within `root`. Returns the normalized
 * project-relative path, or null if it escapes the root.
 */
export function safeRelative(root: string, candidate: string): string | null {
  const absRoot = resolve(root);
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(absRoot, candidate);
  const rel = relative(absRoot, abs);
  if (rel === "" ) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

/**
 * Resolve a configuration-owned directory beneath a project root. Storage is a
 * trust boundary: unlike an individual evidence path, `.` and absolute paths
 * are not meaningful safe choices here.
 */
export function resolveProjectStorageDirectory(projectRoot: string, configuredDirectory: string): string {
  if (!configuredDirectory || configuredDirectory === ".") throw new Error("storage.directory must be a non-root project-relative directory");
  const relativePath = safeRelative(projectRoot, configuredDirectory);
  if (relativePath === null || relativePath === ".") throw new Error("storage.directory escapes the project root");
  return resolve(projectRoot, relativePath);
}
