/**
 * SupraCode brand TUI plugin for OpenCode V2. V2's slot API does not expose
 * V1's `home_logo`; prepend the home-specific logo through the `app` slot and
 * keep the persistent status in `home.footer`. The application slot content
 * is left intact; only a small brand block is prepended on the home route.
 */
import { createElement, insert, setProp } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";

const WORDMARK = [
  "███████╗██╗   ██╗██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔════╝██║   ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "███████╗██║   ██║██████╔╝██████╔╝███████║██║     ██║   ██║██║  ██║█████╗  ",
  "╚════██║██║   ██║██╔═══╝ ██╔══██╗██╔══██║██║     ██║   ██║██║  ██║██╔══╝  ",
  "███████║╚██████╔╝██║     ██║  ██║██║  ██║╚██████╗╚████╔╝██████╔╝███████╗",
  "╚══════╝ ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝",
];
const TAGLINE = "Know the project. Ship with confidence.";
const COMPACT_AT = 58;
const STEP = 3;
const BAND = 5;

function node(tag: string, props: Record<string, unknown>, children: unknown[] = []): JSX.Element {
  const out = createElement(tag);
  for (const [key, value] of Object.entries(props)) setProp(out, key, value);
  for (const child of children) insert(out, child);
  return out as JSX.Element;
}

function text(value: string, fg?: string): JSX.Element {
  return node("text", fg ? { fg } : {}, [value]);
}

function logo(width: number, frame: number): JSX.Element {
  if (width < COMPACT_AT) {
    return node("box", { flexDirection: "column", marginBottom: 1 }, [
      text("SUPRACODE", "#62D6FF"),
      text(TAGLINE, "#8797A8"),
    ]);
  }
  const center = frame * STEP - BAND;
  const rows: JSX.Element[] = [];
  for (const row of WORDMARK) {
    const runs: JSX.Element[] = [];
    let current = "";
    let hot: boolean | undefined;
    for (let i = 0; i < row.length; i++) {
      const nextHot = frame > Math.ceil((WORDMARK[0]!.length + BAND) / STEP) || Math.abs(i - center) <= BAND;
      if (hot !== undefined && nextHot !== hot) {
        runs.push(text(current, hot ? "#62D6FF" : "#697887"));
        current = "";
      }
      current += row[i];
      hot = nextHot;
    }
    if (current) runs.push(text(current, hot ? "#62D6FF" : "#697887"));
    rows.push(node("box", { flexDirection: "row" }, runs));
  }
  rows.push(text(TAGLINE, "#8797A8"));
  return node("box", { flexDirection: "column", marginBottom: 1 }, rows);
}

const plugin = Plugin.define({
  id: "supracode.brand.v2",
  setup(context) {
    let frame = 0;
    const timer = setInterval(() => {
      frame++;
      context.renderer.requestRender();
      if (frame > Math.ceil((WORDMARK[0]!.length + BAND) / STEP)) clearInterval(timer);
    }, 120);

    const disposeApp = context.ui.slot({
      prepend: "app",
      render: () => {
        // `app` exists on both routes. Preserve the full home art on home, but
        // show a compact indicator above active sessions.
        const route = context.ui.router.current();
        const width = Math.max(1, context.renderer.width || 80);
        if (route.type === "home") return logo(width, frame);
        return node("box", { flexDirection: "row", marginBottom: 1 }, [text("▲ SUPRACODE", "#62D6FF")]);
      },
    });

    const disposeFooter = context.ui.slot({
      append: "home.footer",
      render: () => {
        let count = 0;
        try { count = context.data.session.list().length; } catch { /* no session state yet */ }
        const mcp = context.data.location.mcp.server.list() ?? [];
        const connected = mcp.filter((server) => server.status.status === "connected").length;
        return text(`▲ SUPRACODE · ${count} sessions · MCP ${connected}/${mcp.length}`, "#8797A8");
      },
    });
    return () => {
      clearInterval(timer);
      disposeFooter();
      disposeApp();
    };
  },
});

export default plugin;
