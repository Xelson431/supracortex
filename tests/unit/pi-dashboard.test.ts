import { strict as assert } from "node:assert";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDashboardState, renderDashboard, renderWelcome } from "../../packages/pi/src/dashboard.ts";

test("welcome has a prominent wordmark and a narrow terminal fallback", () => {
  const wide = renderWelcome("repo", 100);
  assert.ok(wide.length >= 8);
  assert.ok(wide.some((line) => line.includes("██")));
  assert.equal(wide[0], "███████╗██╗   ██╗██████╗ ██████╗  █████╗  ██████╗ ██████╗ ██████╗ ███████╗");
  assert.ok(wide.some((line) => line.includes("Know the project. Ship with confidence.")));
  assert.deepEqual(renderWelcome("repo", 40), ["SUPRACODE", "Know the project. Ship with confidence.", "repo"]);
});

test("compact dashboard shows selected models and running agents within two lines", () => {
  const state = createDashboardState("repo\n\u001b[31m");
  state.selectedModel = "provider/main-model";
  state.subagentModel = "provider/agent-model";
  state.jobs = 2;
  state.jevInputTokens = 2540;
  state.jevOutputTokens = 872;
  state.jevCalls = 1;
  state.jev = "on";
  const lines = renderDashboard(state, 80);
  assert.ok(lines.length <= 2);
  assert.ok(lines.join(" ").includes("provider/main-model"));
  assert.ok(lines.join(" ").includes("provider/agent-model"));
  assert.ok(lines.join(" ").includes("Running 2"));
  assert.ok(lines.join(" ").includes("Jev on · 2540/872 tok (1)"));
  assert.ok(lines.length <= 2);
  assert.ok(renderDashboard(state, 40).every((line) => visibleWidth(line) <= 40));
});
