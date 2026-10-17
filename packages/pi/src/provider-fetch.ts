/**
 * OpenCode-compatible fetch shim for local OmniRoute.
 *
 * Pi's OpenAI SDK adds x-stainless-* headers inside the transport, after the
 * extension's before_provider_headers hook. A captured request showed
 * OpenCode sends none of these. Only HTTP requests to loopback `/v1/`
 * endpoints carrying the OpenCode-compatible User-Agent are changed; every
 * other fetch passes through unchanged.
 */

import { PROVIDER_EXTRA_HEADERS, PROVIDER_USER_AGENT } from "./brand.ts";
import { logDebug } from "./log.ts";

const INSTALLED = Symbol.for("supracode.provider-fetch-installed");
type FetchWithMarker = typeof globalThis.fetch & { [INSTALLED]?: boolean };

type FetchInput = string | URL | Request;

function isLocalApiRequest(input: FetchInput): boolean {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") &&
      url.pathname.includes("/v1/")
    );
  } catch {
    return false;
  }
}

/** Install once per process; returns true if the wrapper was newly installed. */
export function installOpenCodeCompatibleLocalFetch(): boolean {
  const current = globalThis.fetch as FetchWithMarker;
  if (current[INSTALLED]) return false;
  const wrapped = wrapFetchForOpenCodeParity(globalThis.fetch.bind(globalThis)) as FetchWithMarker;
  wrapped[INSTALLED] = true;
  globalThis.fetch = wrapped;
  logDebug("provider-fetch", "OpenCode-compatible local fetch installed");
  return true;
}

/** Pure wrapper factory, injectable/testable without mutating global fetch. */
export function wrapFetchForOpenCodeParity(original: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: FetchInput, init?: RequestInit) => {
    if (!isLocalApiRequest(input)) return original(input, init);
    const sourceHeaders =
      init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    const headers = new Headers(sourceHeaders);
    const ua = headers.get("user-agent") ?? "";
    if (!ua.startsWith("opencode/")) return original(input, init);
    let removed = 0;
    for (const key of [...headers.keys()]) {
      if (key.toLowerCase().startsWith("x-stainless-")) {
        headers.delete(key);
        removed++;
      }
    }
    headers.set("User-Agent", PROVIDER_USER_AGENT);
    for (const [key, value] of Object.entries(PROVIDER_EXTRA_HEADERS)) headers.set(key, value);
    if (removed) logDebug("provider-fetch", "removed SDK telemetry headers", { count: removed });
    return original(input, { ...init, headers });
  }) as typeof globalThis.fetch;
}
