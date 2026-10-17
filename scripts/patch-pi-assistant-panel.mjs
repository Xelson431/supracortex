/** Patch authoring helper for pinned Pi 0.87.1's bundled assistant renderer. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory) throw new Error("Pass the pnpm patch directory");
const file = join(directory, "dist/bundle/chunks/chunk-OJP47DM6.js");
const original = readFileSync(file, "utf8");
const before = 'render(width){let lines=super.render(width);return this.hasToolCalls||lines.length===0||(lines[0]=OSC133_ZONE_START+lines[0],lines[lines.length-1]=OSC133_ZONE_END+OSC133_ZONE_FINAL+lines[lines.length-1]),lines}updateContent(message,isStreaming=this.isStreaming)';
const after = [
  'render(width){let shouldPanel=!this.hasToolCalls&&process.env.SUPRACODE_PANELS==="1"&&width>=24&&this.lastMessage?.content.some(c2=>c2.type==="text"&&c2.text.trim()||c2.type==="thinking"&&c2.thinking.trim()),lines=super.render(shouldPanel?width-4:width);',
  'if(lines.length&&shouldPanel){',
  'let inner=width-4,onlyThinking=this.lastMessage.content.every(c2=>c2.type!=="text"||!c2.text.trim()),label=onlyThinking?"SUPRACODE · THINKING":"ASSISTANT · READ THIS",title=truncateToWidth(label,width-6),',
  'top=theme.fg("text",`╭─ ${title} ${"─".repeat(Math.max(0,width-5-visibleWidth(title)))}╮`),',
  'framed=lines.map(line=>{let clipped=truncateToWidth(line,inner),padding=" ".repeat(Math.max(0,inner-visibleWidth(clipped)));return theme.fg("text","│")+theme.bg("userMessageBg",` ${clipped}${padding} `)+theme.fg("text","│")}),',
  'bottom=theme.fg("text",`╰${"─".repeat(width-2)}╯`);return this.hasToolCalls?[top,...framed,bottom]:[OSC133_ZONE_START+top,...framed,OSC133_ZONE_END+OSC133_ZONE_FINAL+bottom]}',
  'return this.hasToolCalls||lines.length===0||(lines[0]=OSC133_ZONE_START+lines[0],lines[lines.length-1]=OSC133_ZONE_END+OSC133_ZONE_FINAL+lines[lines.length-1]),lines}updateContent(message,isStreaming=this.isStreaming)',
].join("");
if (original.split(before).length === 2) {
  writeFileSync(file, original.replace(before, after));
} else if (original.includes('shouldPanel=!this.hasToolCalls&&process.env.SUPRACODE_PANELS==="1"')) {
  // Assistant framing is already part of the recorded pnpm patch.
} else {
  // The pnpm edit directory may retain the prior patch after patch-commit.
  const oldGuard = 'render(width){let lines=super.render(width);if(lines.length&&process.env.SUPRACODE_PANELS==="1"&&width>=24&&this.lastMessage?.content.some(c2=>c2.type==="text"&&c2.text.trim()||c2.type==="thinking"&&c2.thinking.trim())){';
  const newGuard = 'render(width){let shouldPanel=process.env.SUPRACODE_PANELS==="1"&&width>=24&&this.lastMessage?.content.some(c2=>c2.type==="text"&&c2.text.trim()||c2.type==="thinking"&&c2.thinking.trim()),lines=super.render(shouldPanel?width-4:width);if(lines.length&&shouldPanel){';
  if (original.split(oldGuard).length !== 2 && !original.includes('shouldPanel=process.env.SUPRACODE_PANELS')) {
    throw new Error("Pinned Pi assistant renderer changed or was already patched");
  }
  writeFileSync(file, original.replace(oldGuard, newGuard));
}

// Apply the same framed output to every Pi ToolExecutionComponent: built-in
// shell/filesystem/search tools and external extensions such as subagents.
const toolChunkFile = join(directory, "dist/bundle/chunks/chunk-OJP47DM6.js");
let toolChunk = readFileSync(toolChunkFile, "utf8");
const replaceOne = (from, to, label) => {
  if (toolChunk.split(from).length !== 2) throw new Error(`Pinned Pi tool renderer changed or already patched: ${label}`);
  toolChunk = toolChunk.replace(from, to);
};
replaceOne(
  'getRenderShell(){return this.toolDefinition?.renderShell??"default"}',
  'getRenderShell(){return process.env.SUPRACODE_PANELS==="1"?"self":this.toolDefinition?.renderShell??"default"}',
  "render shell",
);
const toolPanelBranch = [
  'if(process.env.SUPRACODE_PANELS==="1"&&width>=24&&this.imageComponents.length===0){',
  'let tool=this.toolName.toLowerCase(),style=/^(bash|powershell|shell|terminal)$/.test(tool)?{label:"COMMAND · SHELL",color:"warning",background:"toolPendingBg"}:/read|ls/.test(tool)?{label:"FILES · READ",color:"accent",background:"userMessageBg"}:/grep|find|search/.test(tool)?{label:"FILES · SEARCH",color:"mdLink",background:"customMessageBg"}:/edit|write|patch/.test(tool)?{label:`FILES · ${tool.toUpperCase()}`,color:"success",background:"toolSuccessBg"}:/cortex/.test(tool)?{label:`SUPRACORTEX · ${tool.replace(/^cortex[_-]?/,"").toUpperCase()}`,color:"accent",background:"customMessageBg"}:/subagent|delegate|agent|job|task/.test(tool)?{label:`SUBAGENT · ${tool.toUpperCase()}`,color:"mdLink",background:"toolPendingBg"}:{label:tool.toUpperCase(),color:"toolTitle",background:"toolPendingBg"},inner=width-4,content=this.hasRendererDefinition()?this.selfRenderContainer.render(inner):super.render(inner);',
  'this.selfRenderHeight=content.length;if(content.length===0)return[];',
  'let title=truncateToWidth(style.label,width-6),top=theme.fg(style.color,`╭─ ${title} ${"─".repeat(Math.max(0,width-5-visibleWidth(title)))}╮`),',
  'framed=content.map(line=>{let clipped=truncateToWidth(line,inner),padding=" ".repeat(Math.max(0,inner-visibleWidth(clipped)));return theme.fg(style.color,"│")+theme.bg(style.background,` ${clipped}${padding} `)+theme.fg(style.color,"│")}),bottom=theme.fg(style.color,`╰${"─".repeat(width-2)}╯`);return["",top,...framed,bottom]}',
].join("");
replaceOne(
  "render(width){if(this.hideComponent)return[];",
  `render(width){if(this.hideComponent)return[];${toolPanelBranch}`,
  "framed tools",
);
const oldMouse = 'handleMouse(event){if(!this.hasRendererDefinition()||this.getRenderShell()!=="self")return super.handleMouse(event);if(!(event.y<=0||event.y>this.selfRenderHeight))return this.selfRenderContainer.handleMouse({...event,y:event.y-1,height:this.selfRenderHeight})}';
const newMouse = 'handleMouse(event){if(!this.hasRendererDefinition()||this.getRenderShell()!=="self")return super.handleMouse(event);if(process.env.SUPRACODE_PANELS==="1")return event.y>=2&&event.y<=this.selfRenderHeight+1?this.selfRenderContainer.handleMouse({...event,x:event.x-1,y:event.y-2,width:event.width-2,height:this.selfRenderHeight}):void 0;if(!(event.y<=0||event.y>this.selfRenderHeight))return this.selfRenderContainer.handleMouse({...event,y:event.y-1,height:this.selfRenderHeight})}';
replaceOne(oldMouse, newMouse, "mouse offset");
toolChunk += '\nfunction toolPanelStyle(name){const tool=name.toLowerCase();if(/^(bash|powershell|shell|terminal)$/.test(tool))return{label:"COMMAND · SHELL",color:"warning",background:"toolPendingBg"};if(/read|ls/.test(tool))return{label:"FILES · READ",color:"accent",background:"userMessageBg"};if(/grep|find|search/.test(tool))return{label:"FILES · SEARCH",color:"mdLink",background:"customMessageBg"};if(/edit|write|patch/.test(tool))return{label:`FILES · ${tool.toUpperCase()}`,color:"success",background:"toolSuccessBg"};if(/cortex/.test(tool))return{label:`SUPRACORTEX · ${tool.replace(/^cortex[_-]?/,"").toUpperCase()}`,color:"accent",background:"customMessageBg"};if(/subagent|delegate|agent|job|task/.test(tool))return{label:`SUBAGENT · ${tool.toUpperCase()}`,color:"mdLink",background:"toolPendingBg"};return{label:tool.toUpperCase(),color:"toolTitle",background:"toolPendingBg"}}\n';
writeFileSync(toolChunkFile, toolChunk);
