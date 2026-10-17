/** Compact, observed-only SupraCode TUI identity and live session dashboard. */
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface DashboardState {
  project: string;
  cortex: "on" | "off" | "unavailable";
  jev: "on" | "off" | "unknown";
  jevInputTokens: number;
  jevOutputTokens: number;
  jevCalls: number;
  packets: number;
  memories: number;
  reads: number;
  jobs: number;
  lastActivity: string;
  selectedModel: string;
  subagentModel: string;
}

export function createDashboardState(project: string): DashboardState {
  return { project: safe(project), cortex: "off", jev: "unknown", jevInputTokens: 0, jevOutputTokens: 0, jevCalls: 0, packets: 0, memories: 0, reads: 0, jobs: 0, lastActivity: "Starting", selectedModel: "unknown", subagentModel: "default" };
}

function safe(value: string): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "project";
}

/** Large boot mark when there is room, compact mark on narrow terminals. */
export function renderWelcome(
  project: string,
  width: number,
  color: (text: string) => string = (text) => text,
): string[] {
  const name = safe(project);
  if (width < 58) return [color("SUPRACODE"), "Know the project. Ship with confidence.", name];
  return [
    color("███████╗██╗   ██╗██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗"),
    color("██╔════╝██║   ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝"),
    color("███████╗██║   ██║██████╔╝██████╔╝███████║██║     ██║   ██║██║  ██║█████╗  "),
    color("╚════██║██║   ██║██╔═══╝ ██╔══██╗██╔══██║██║     ██║   ██║██║  ██║██╔══╝  "),
    color("███████║╚██████╔╝██║     ██║  ██║██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗"),
    color("╚══════╝ ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝"),
    "Know the project. Ship with confidence.",
    name,
  ];
}

/** Compact outlined navbar; usage values come only from observed engine metrics. */
export function renderDashboard(state: DashboardState, _width: number, color: (text: string) => string = (text) => text): string[] {
  const width = Math.max(1, Math.floor(_width));
  const available = Math.max(1, Math.floor(width));
  const mainModel = safe(state.selectedModel);
  const agentModel = safe(state.subagentModel);
  const activity = `Cortex ${state.cortex} · Jev ${state.jev} · ${state.jevInputTokens}/${state.jevOutputTokens} tok (${state.jevCalls})`;
  const models = `Model ${mainModel} · Agent ${agentModel} · Running ${state.jobs}`;
  const compact = available < 38;
  const lines = compact
    ? [
        truncateToWidth(`${mainModel} · ${agentModel} · ${state.jobs} agents`, available),
        truncateToWidth(`Jev ${state.jevInputTokens}/${state.jevOutputTokens} tok · ${state.jevCalls} calls`, available),
      ]
    : [
        truncateToWidth(models, available),
        truncateToWidth(activity, available),
      ];
  return lines.map(color);
}
