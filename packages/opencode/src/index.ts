/**
 * Public API for @local/supracortex-opencode.
 */

export { SupraCortex, SupraCortex as default, PLUGIN_VERSION } from "./plugin.ts";
export { SupraCortexV2, OPENCODE_V2_PLUGIN_ID, userTask } from "./plugin-v2.ts";
export { loadConfig, stripJsonc, projectConfigPath, globalConfigPath } from "./config-loader.ts";
export { FeatureGate } from "./feature-gate.ts";
export { PluginRuntime } from "./runtime.ts";
export { buildTools, guard } from "./tools/index.ts";
export { createEngine, gatherInputs, parsePorcelain, createStore } from "./lifecycle.ts";
export { discoverSkills, parseSkill } from "./skills-discovery.ts";
export { discoverMcpServers, normalizeServers, classifyTool } from "./mcp-discovery.ts";
export {
  ABSOLUTE_PACKET_MAX_BYTES,
  DEFAULT_PACKET_MAX_BYTES,
  PACKET_MARKER,
  UNTRUSTED_DATA_BEGIN,
  UNTRUSTED_DATA_END,
  UNTRUSTED_JSON_PREFIX,
  renderPacketForPrompt,
  renderPacketForPromptDetailed,
} from "./packet-rendering.ts";
export type { RenderedContextPacket, RenderPacketOptions } from "./packet-rendering.ts";
export * as cli from "./cli-core.ts";
