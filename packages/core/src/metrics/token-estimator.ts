/**
 * Deterministic, provider-agnostic token measurement.
 *
 * Measurement honesty contract (Wave 2, item 2c):
 * - `measureTokens` is the primary path. It uses tiktoken
 *   (`encodingForModel`, `js-tiktoken` when installed) and returns
 *   `{ estimated: false }` — a measured count for the resolved encoding.
 * - When tiktoken is unavailable or the model has no known encoding, the
 *   chars/4 heuristic is used ONLY as a labeled fallback:
 *   `{ estimated: true, modelRatioNote }` — never presented as measured.
 * - `estimateTokens` / `estimateBytesTokens` are retained for budget
 *   splitting only. Their names already say "estimate"; treat every value
 *   they produce as labeled-estimate, never billed.
 */

export interface TokenMeasureResult {
  tokens: number;
  /** false = tiktoken-measured; true = heuristic fallback, must be labeled. */
  estimated: boolean;
  /** "tiktoken:<encoding>" or "chars/4-fallback". */
  method: string;
  /** Present only on the fallback path: per-model ratio note for splitting. */
  modelRatioNote?: string;
}

/** Per-model chars-per-token ratios, used ONLY to note the fallback path. */
const MODEL_CHAR_RATIOS: Array<{ prefix: string; ratio: number; encoding: string }> = [
  { prefix: "gpt-4o", ratio: 4, encoding: "o200k_base" },
  { prefix: "o1", ratio: 4, encoding: "o200k_base" },
  { prefix: "o3", ratio: 4, encoding: "o200k_base" },
  { prefix: "gpt-4", ratio: 4, encoding: "cl100k_base" },
  { prefix: "gpt-3.5", ratio: 4, encoding: "cl100k_base" },
  { prefix: "claude", ratio: 4, encoding: "cl100k_base" },
  { prefix: "gemini", ratio: 4, encoding: "cl100k_base" },
  { prefix: "deepseek", ratio: 4, encoding: "cl100k_base" },
  { prefix: "llama", ratio: 3.5, encoding: "cl100k_base" },
  { prefix: "mistral", ratio: 3.5, encoding: "cl100k_base" },
];

const DEFAULT_ENCODING = "cl100k_base";

function ratioNoteFor(modelHint?: string): string {
  const normalized = (modelHint ?? "").toLowerCase();
  for (const entry of MODEL_CHAR_RATIOS) {
    if (normalized.startsWith(entry.prefix)) {
      return `chars/${entry.ratio} fallback for model "${modelHint}" (tiktoken ${entry.encoding} unavailable)`;
    }
  }
  return `chars/4 fallback${modelHint ? ` for model "${modelHint}"` : ""} (tiktoken unavailable)`;
}

function encodingFor(modelHint?: string): string {
  const normalized = (modelHint ?? "").toLowerCase();
  for (const entry of MODEL_CHAR_RATIOS) {
    if (normalized.startsWith(entry.prefix)) return entry.encoding;
  }
  return DEFAULT_ENCODING;
}

interface LiteEncoder {
  encode(text: string): ArrayLike<number>;
}

type TiktokenModule = {
  encodingForModel?: (model: string) => LiteEncoder;
  getEncoding?: (name: string) => LiteEncoder;
};

// Cached encoder state. Loaded lazily so core has no hard dependency on
// js-tiktoken; absence means the labeled fallback path (never a crash).
// Loader order (honest, never throws, no hard dep):
//   1. ESM dynamic import("js-tiktoken") — works under ESM/bundled dist
//      where `require` is undefined (see loadTiktokenESM / measureTokensAsync).
//   2. CJS require probe — works under tsx/CJS dev.
//   3. chars/4 labeled fallback ({ estimated: true, method: "chars/4-fallback" }).
// The sync `measureTokens` path can only use (2) + an already-ESM-loaded
// module; use `measureTokensAsync` (or `preloadTiktoken`) to attempt (1).
let encoderCache: Map<string, LiteEncoder> | null = null;
let tiktokenTriedSync = false;
let tiktokenModule: TiktokenModule | null = null;
let tiktokenESMTried = false;

function loadTiktokenSync(): TiktokenModule | null {
  if (tiktokenTriedSync) return tiktokenModule;
  tiktokenTriedSync = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = new Function("return typeof require !== 'undefined' ? require : null")() as ((
      id: string,
    ) => unknown) | null;
    const mod = (req?.("js-tiktoken") ?? null) as typeof tiktokenModule;
    if (mod && (mod.encodingForModel ?? mod.getEncoding)) tiktokenModule = mod;
  } catch {
    tiktokenModule = null;
  }
  return tiktokenModule;
}

function tiktokenEncode(text: string, modelHint?: string): number | null {
  const mod = loadTiktokenSync();
  if (!mod) return null;
  return encodeWith(text, modelHint, mod);
}

/**
 * ESM-first loader: dynamic import("js-tiktoken") via indirect evaluation so
 * bundlers do not rewrite it to a static import (keeps the dep optional).
 * Never throws; returns null when the package is absent (bundled dist →
 * fallback + reason at the call site).
 */
export async function loadTiktokenESM(): Promise<TiktokenModule | null> {
  if (tiktokenModule) return tiktokenModule;
  if (tiktokenESMTried) return tiktokenModule;
  tiktokenESMTried = true;
  try {
    const importer = new Function(
      "id",
      "return import(id)",
    ) as (id: string) => Promise<unknown>;
    const mod = (await importer("js-tiktoken")) as TiktokenModule;
    if (mod && (mod.encodingForModel ?? mod.getEncoding)) tiktokenModule = mod;
  } catch {
    tiktokenModule = tiktokenModule; // absent → labeled fallback, never throw
  }
  return tiktokenModule;
}

/** Fire-and-forget ESM preload for sync callers that cannot await. */
export function preloadTiktoken(): void {
  void loadTiktokenESM();
}

function encodeWith(text: string, modelHint: string | undefined, mod: TiktokenModule): number | null {
  try {
    const cache = (encoderCache ??= new Map<string, LiteEncoder>());
    // Primary: encodingForModel (per-model). Fallback: lite getEncoding.
    if (modelHint && mod.encodingForModel) {
      const key = `model:${modelHint}`;
      let enc = cache.get(key);
      if (!enc) {
        enc = mod.encodingForModel(modelHint);
        cache.set(key, enc);
      }
      return enc.encode(text).length;
    }
    const name = encodingFor(modelHint);
    const key = `enc:${name}`;
    let enc = cache.get(key);
    if (!enc) {
      if (!mod.getEncoding) return null;
      enc = mod.getEncoding(name);
      cache.set(key, enc);
    }
    return enc.encode(text).length;
  } catch {
    // Tokenizer mismatch (unknown model, unsupported encoding) → labeled fallback.
    return null;
  }
}

/** Primary measurement path. Tiktoken when available, labeled estimate otherwise. */
export function measureTokens(text: string, modelHint?: string): TokenMeasureResult {
  if (!text) return { tokens: 0, estimated: false, method: "tiktoken:empty" };
  const measured = tiktokenEncode(text, modelHint);
  if (measured !== null && Number.isFinite(measured)) {
    const encoding = modelHint ? `model:${modelHint}` : encodingFor(undefined);
    return { tokens: Math.max(0, Math.floor(measured)), estimated: false, method: `tiktoken:${encoding}` };
  }
  return {
    tokens: estimateTokens(text),
    estimated: true,
    method: "chars/4-fallback",
    modelRatioNote: ratioNoteFor(modelHint),
  };
}

/** Test seam: reset the lazy tiktoken state. */
export function __resetTokenMeasureCacheForTests(): void {
  encoderCache = null;
  tiktokenTriedSync = false;
  tiktokenESMTried = false;
  tiktokenModule = null;
}

/** Async measurement path: ESM import first, then require probe, then labeled fallback. Never throws. */
export async function measureTokensAsync(text: string, modelHint?: string): Promise<TokenMeasureResult> {
  if (!text) return { tokens: 0, estimated: false, method: "tiktoken:empty" };
  try {
    const esm = await loadTiktokenESM();
    if (esm) {
      const measured = encodeWith(text, modelHint, esm);
      if (measured !== null && Number.isFinite(measured)) {
        const encoding = modelHint ? `model:${modelHint}` : encodingFor(undefined);
        return { tokens: Math.max(0, Math.floor(measured)), estimated: false, method: `tiktoken:${encoding}` };
      }
    }
  } catch {
    // fall through to require probe + labeled fallback
  }
  return measureTokens(text, modelHint);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  // Base heuristic: 1 token ~= 4 chars.
  const base = chars / 4;
  // Code/punctuation-dense text tends to tokenize into more tokens; add a small
  // bump proportional to non-alphanumeric density.
  let nonAlnum = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isAlnum =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32;
    if (!isAlnum) nonAlnum++;
  }
  const density = chars > 0 ? nonAlnum / chars : 0;
  const adjusted = base * (1 + density * 0.35);
  const out = Math.max(1, Math.ceil(adjusted));
  return Number.isFinite(out) ? out : 0;
}

export function estimateBytesTokens(sizeBytes: number): number {
  // For files we may not have loaded, approximate from byte size.
  // Labeled estimate for splitting only — never billed.
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 0;
  return Math.max(1, Math.ceil(sizeBytes / 4));
}
