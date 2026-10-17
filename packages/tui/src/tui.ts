/**
 * SupraCode brand TUI plugin for OpenCode.
 *
 * - `home_logo` (replace slot): SUPRACODE ASCII wordmark with an accent sweep
 *   reveal that settles to a static resting render. Narrow terminals get a
 *   compact fallback. Animation can be disabled via plugin options.
 * - `home_footer` (single winner, unclaimed by other installed plugins):
 *   brand line with the live session count when the host exposes it.
 *
 * Imperative `@opentui/solid` primitives only (no JSX, no signals): animation
 * state lives at module scope, a bounded interval advances it, and each tick
 * calls `api.renderer.requestRender()`. The timer is always disposed through
 * `api.lifecycle.onDispose` and always settles — personality must never cost
 * input latency after the reveal.
 */

import { createElement, insert, setProp } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";

export const SUPRACODE_ID = "supracode.brand";

const WORDMARK = [
  "███████╗██╗   ██╗██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔════╝██║   ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "███████╗██║   ██║██████╔╝██████╔╝███████║██║     ██║   ██║██║  ██║█████╗  ",
  "╚════██║██║   ██║██╔═══╝ ██╔══██╗██╔══██║██║     ██║   ██║██║  ██║██╔══╝  ",
  "███████║╚██████╔╝██║     ██║  ██║██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚══════╝ ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

const TAGLINE = "Know the project. Ship with confidence.";
const WORDMARK_WIDTH = 72;
const COMPACT_THRESHOLD = 58;
/** Sweep advances this many columns per frame; band half-width in columns. */
const SWEEP_STEP = 2;
const SWEEP_HALF = 5;
const FRAME_MS = 110;

function element(tag: string, props: Record<string, unknown>, children: unknown[] = []): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    insert(node, child);
  }
  return node;
}

function text(props: Record<string, unknown>, children: unknown[]): JSX.Element {
  return element("text", props, children);
}

function box(props: Record<string, unknown>, children: unknown[] = []): JSX.Element {
  return element("box", props, children);
}

/** Split a row into accent-band / dim runs for the current sweep center. */
function sweepRuns(row: string, center: number, settled: boolean): Array<{ text: string; hot: boolean }> {
  if (settled) return [{ text: row, hot: true }];
  const runs: Array<{ text: string; hot: boolean }> = [];
  let current = "";
  let currentHot = false;
  const chars = Array.from(row);
  for (let i = 0; i < chars.length; i++) {
    const hot = Math.abs(i - center) <= SWEEP_HALF;
    if (i === 0) currentHot = hot;
    if (hot !== currentHot) {
      runs.push({ text: current, hot: currentHot });
      current = "";
      currentHot = hot;
    }
    current += chars[i];
  }
  if (current) runs.push({ text: current, hot: currentHot });
  return runs;
}

export interface SupracodeTuiOptions {
  /** Disable the sweep reveal (static wordmark immediately). Default true. */
  animate?: boolean;
}

const tui = async (api: TuiPluginApi, options?: SupracodeTuiOptions): Promise<void> => {
  const animate = options?.animate !== false;
  const totalFrames = Math.ceil((WORDMARK_WIDTH + SWEEP_HALF * 2) / SWEEP_STEP);
  let frame = animate ? 0 : Number.MAX_SAFE_INTEGER;
  let timer: ReturnType<typeof setInterval> | undefined;

  const settled = (): boolean => frame > totalFrames;

  if (animate) {
    timer = setInterval(() => {
      try {
        frame += 1;
        api.renderer.requestRender();
        if (settled() && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch {
        // A failed tick must never break the host render loop.
      }
    }, FRAME_MS);
    api.lifecycle.onDispose(() => {
      if (timer !== undefined) clearInterval(timer);
    });
  }

  api.slots.register({
    slots: {
      home_logo() {
        const theme = api.theme.current;
        const width = api.renderer.width || WORDMARK_WIDTH;
        if (width < COMPACT_THRESHOLD) {
          return box({ flexDirection: "column" }, [
            text({ fg: theme.accent }, ["SUPRACODE"]),
            text({ fg: theme.textMuted }, [TAGLINE]),
          ]);
        }
        const center = frame * SWEEP_STEP - SWEEP_HALF;
        const done = settled();
        const rows: JSX.Element[] = [];
        for (const row of WORDMARK) {
          const segments: unknown[] = [];
          for (const run of sweepRuns(row, center, done)) {
            if (!run.text) continue;
            segments.push(text({ fg: run.hot ? theme.accent : theme.textMuted }, [run.text]));
          }
          rows.push(box({ flexDirection: "row" }, segments));
        }
        rows.push(text({ fg: theme.textMuted }, [TAGLINE]));
        return box({ flexDirection: "column" }, rows);
      },
      home_footer() {
        const theme = api.theme.current;
        const bits: string[] = ["▲ SUPRACODE"];
        try {
          const count = api.state.session.count();
          if (typeof count === "number" && count > 0) {
            bits.push(`${count} session${count === 1 ? "" : "s"}`);
          }
        } catch {
          // Host state shape varies; brand line stands alone.
        }
        try {
          const servers = api.state.mcp();
          if (Array.isArray(servers) && servers.length > 0) {
            const up = servers.filter((s) => s.status === "connected").length;
            bits.push(`MCP ${up}/${servers.length}`);
          }
        } catch {
          // MCP state unavailable; omit rather than guess.
        }
        return text({ fg: theme.textMuted }, [bits.join(" · ")]);
      },
    },
  });
};

const plugin: TuiPluginModule = { id: SUPRACODE_ID, tui };

export default plugin;
