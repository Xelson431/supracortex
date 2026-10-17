import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

function toolPanel(toolName: string): ToolExecutionComponent {
  return new ToolExecutionComponent(toolName, `id-${toolName}`, {}, {}, {}, { requestRender() {} } as never, "/repo");
}

test("all Pi tool executions get a titled category-colored panel", () => {
  initTheme("dark");
  const prior = process.env.SUPRACODE_PANELS;
  try {
    process.env.SUPRACODE_PANELS = "1";
    const cases = [
      ["bash", "COMMAND · SHELL"],
      ["grep", "FILES · SEARCH"],
      ["read", "FILES · READ"],
      ["edit", "FILES · EDIT"],
      ["cortex_delegate", "SUPRACORTEX · DELEGATE"],
      ["subagent", "SUBAGENT · SUBAGENT"],
    ];
    for (const [tool, title] of cases) {
      const rendered = toolPanel(tool!).render(72);
      const plain = rendered.map(stripTerminalSequences);
      assert.ok(plain.some((line) => line.includes(title!)), `${tool} title`);
      assert.ok(plain.some((line) => line.startsWith("╰")), `${tool} bottom outline`);
      assert.ok(rendered.some((line) => line.includes("\u001b[48;2;") || line.includes("\u001b[48;5;")), `${tool} background tint`);
      assert.ok(rendered.every((line) => visibleWidth(line) <= 72), `${tool} width bounded`);
    }
  } finally {
    if (prior === undefined) delete process.env.SUPRACODE_PANELS;
    else process.env.SUPRACODE_PANELS = prior;
  }
});

test("tool results keep Pi's default collapsed preview and Ctrl+O expansion", () => {
  initTheme("dark");
  const prior = process.env.SUPRACODE_PANELS;
  try {
    process.env.SUPRACODE_PANELS = "1";
    const tool = toolPanel("grep");
    const output = Array.from({ length: 14 }, (_, i) => `evidence line ${i + 1}`).join("\n");
    tool.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false } as never);
    const collapsed = tool.render(72).map(stripTerminalSequences).join("\n");
    assert.ok(collapsed.includes("to expand"));
    assert.ok(!collapsed.includes("evidence line 14"));
    (tool as unknown as { setExpanded(expanded: boolean): void }).setExpanded(true);
    const expanded = tool.render(72).map(stripTerminalSequences).join("\n");
    assert.ok(expanded.includes("evidence line 14"));
  } finally {
    if (prior === undefined) delete process.env.SUPRACODE_PANELS;
    else process.env.SUPRACODE_PANELS = prior;
  }
});

test("assistant streaming panel preserves readable text and does not affect plain Pi", () => {
  initTheme("dark");
  const before = process.env.SUPRACODE_PANELS;
  try {
    process.env.SUPRACODE_PANELS = "1";
    const message = { role: "assistant", content: [{ type: "text", text: "Read this response" }], stopReason: "stop" };
    const component = new AssistantMessageComponent(message as never);
    component.updateContent(message as never, true);
    const rendered = component.render(60);
    const lines = rendered.map(stripTerminalSequences);
    assert.ok(lines[0]!.startsWith("╭─ ASSISTANT · READ THIS"));
    assert.ok(lines.some((line) => line.includes("Read this response")));
    assert.ok(lines.at(-1)!.startsWith("╰"));
    assert.ok(lines.every((line) => visibleWidth(line) === 60));
    assert.ok(rendered.some((line) => line.includes("\u001b[48;2;") || line.includes("\u001b[48;5;")), "assistant body has a colored panel background");
    delete process.env.SUPRACODE_PANELS;
    assert.ok(!component.render(60).map(stripTerminalSequences).some((line) => line.startsWith("╭─ ASSISTANT")));
  } finally {
    if (before === undefined) delete process.env.SUPRACODE_PANELS;
    else process.env.SUPRACODE_PANELS = before;
  }
});
