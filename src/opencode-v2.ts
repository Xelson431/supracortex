// Deliberately separate from ./opencode.ts: OpenCode V2 must not evaluate the
// legacy adapter or its incompatible plugin helper imports.
export { SupraCortexV2 as default, SupraCortexV2, OPENCODE_V2_PLUGIN_ID, userTask } from "../packages/opencode/src/plugin-v2.ts";
