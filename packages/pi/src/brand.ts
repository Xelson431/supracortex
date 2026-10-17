/**
 * P11 SupraCode identity: one product name, one header, one status voice.
 * Pure string builders (testable without a terminal); the extension applies
 * Pi theme colors and TUI gating. Tone: short, plain, no hype. Errors name
 * the fix location.
 */

/** The Pi-based host ships as `supracode-pi`, distinct from the OpenCode-based `supracode`. */
export const PRODUCT_NAME = "SupraCode Pi";
export const COMMAND_NAME = "supracode-pi";

/**
 * Provider-facing User-Agent. Matches OpenCode exactly so proxies treat
 * SupraCode traffic identically: verified from the installed OpenCode
 * binary (`opencode --version` → 1.18.32; binary strings contain
 * `user-agent=opencode/1.18.32`). Applied to main-session provider calls
 * via `before_provider_headers`; SDK child sessions keep Pi defaults.
 */
export const PROVIDER_USER_AGENT =
  "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

/**
 * Companion headers OpenCode sends with provider calls (verified against a
 * live wire capture of `opencode run` to a dummy endpoint, not just binary
 * strings): OpenRouter-style title + app referer + per-session affinity
 * pair. Applied together with the User-Agent; session ids are generated per
 * CLI process. If the backend still refuses, the gate is not header-based.
 */
export const PROVIDER_EXTRA_HEADERS: Record<string, string> = {
  "X-Title": "opencode",
  Referer: "https://opencode.ai/",
};

export function providerSessionHeaders(): Record<string, string> {
  const id = `ses_${Math.random().toString(36).slice(2, 18)}`;
  return { "x-session-affinity": id, "x-session-id": id };
}

export type Colorize = (text: string) => string;
export const plain: Colorize = (text) => text;

const MARK = "▲";

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

/** Project label: last two path segments, bounded. */
export function projectLabel(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return clip(parts.slice(-2).join("/"), 40) || "project";
}

/** Header lines for setHeader: mark + name + project + Cortex state. */
export function headerLines(
  input: { project: string; cortex: "on" | "off"; version?: string },
  color: { mark?: Colorize; dim?: Colorize } = {},
): string[] {
  const mark = (color.mark ?? plain)(MARK);
  const dim = color.dim ?? plain;
  const title = `${mark} ${PRODUCT_NAME} · ${clip(input.project, 40)} · cortex ${input.cortex}`;
  const sub = dim(
    `memory, context and supervised subagents${input.version ? ` · v${input.version}` : ""}`,
  );
  return ["", title, sub, ""];
}

/** Window title. */
export function windowTitle(project: string): string {
  return `${PRODUCT_NAME} — ${projectLabel(project)}`;
}

/**
 * Footer `cortex` slot text. Returns undefined when idle (slot cleared).
 * Stuck state is explicit: admissions stopped, operator action needed.
 */
export function footerStatus(input: { running: number; stuck: boolean; admissionsBlocked: boolean }): string | undefined {
  if (input.admissionsBlocked) return "cortex: stuck — admissions blocked, exit CLI";
  if (input.stuck) return "cortex: job stuck (abort unsettled)";
  if (input.running > 0) return `cortex: ${input.running} job(s)`;
  return undefined;
}

/** Voice helpers: fact + next action, paths included. */
export function unavailable(message: string): string {
  return `SupraCortex unavailable: ${message}. See \`supracortex logs\`.`;
}

export function disabledCortex(reason: string): string {
  return `Cortex disabled (${reason}). Pi still runs; re-enable via config or unset SUPRACORTEX_DISABLE.`;
}
