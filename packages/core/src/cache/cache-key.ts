/**
 * Cache key derivation. Keys are content-addressed so a change in any input
 * naturally produces a new key and old entries become unreachable (and later
 * pruned by age).
 */

import { createHash } from "node:crypto";

export function contextKey(parts: {
  query: string;
  hintFiles: string[];
  tags: string[];
  indexGeneration: string;
}): string {
  const norm = JSON.stringify({
    q: parts.query.trim().toLowerCase(),
    h: [...parts.hintFiles].sort(),
    t: [...parts.tags].map((s) => s.toLowerCase()).sort(),
    g: parts.indexGeneration,
  });
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}
