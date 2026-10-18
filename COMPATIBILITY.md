# Compatibility

This document records the environment SupraCortex was built against, the hosts
that have actually been exercised, and the API assumptions the adapters depend
on. Status is as of **2026-10-17**. If a host or dependency changes, the
compatibility suite is the first place a break should surface.

Verification levels used below:

- **Live-tested**: a real host session was run against this repository's build.
- **Wiring live-verified**: the real host binary accepted, listed, and removed
  the server against this repository's build in an isolated config directory,
  but a full model-driven session was not exercised.
- **Fixture/tarball-verified only**: config generation/merge/uninstall and the
  packed MCP stdio server are covered by tests, but no live session of that host
  was run.
- **Documented only**: wiring is documented and may have config fixtures; there
  is no live-session verification claim.
- **Untested**: no verification claim.

## Verified environment

| Component | Version | Notes |
|---|---|---|
| OpenCode | 1.18.32 | V1 plugin host (`opencode --version`) |
| `@opencode-ai/plugin` | 1.18.32 | V1 plugin + tool API (pinned in `package.json`) |
| `@opencode/plugin` | 2.0.16 | V2 plugin API (pinned in `package.json`) |
| `@opencode-ai/sdk` | 1.18.32 | Client used for git/MCP discovery (transitive) |
| Node.js | 22.23.1 | Built CLI + stdio MCP server; declared minimum is 22.6 |
| pnpm | 11.9.0 | Workspace manager; npm also works |
| MCP SDK | 1.29.0 | `@modelcontextprotocol/sdk` (pinned) |
| CI platforms | Ubuntu, macOS (release-gating); Windows (best-effort) | Workflow matrix runs all three; Windows failures are visible but non-blocking |

## MCP toolset

MCP hosts receive the tools documented in [MCP_PROTOCOL.md](./MCP_PROTOCOL.md):
the stable `cortex_*` set plus the experimental graph, Jev, and capability
tools. The native OpenCode adapter is a **superset**: it adds lifecycle hooks and
orchestration tools (planning, file claims, cache validation, compaction, sweep,
metrics, SupraSpace sync, graph export).

Host capabilities are not identical. MCP is tools-only here: automatic context
injection, lifecycle hooks, usage observation, and other host-side integration
are available only where the adapter is supported. Do not assume equivalent
behavior across hosts.

## Host status

| Host | Wiring | Status |
|---|---|---|
| OpenCode 1.18.32 (V1) | Native V1 plugin via `supracortex init` | **Live-tested on this machine** |
| OpenCode 2.0.16 (V2) | Native V2 plugin | **Fixture/tarball-verified only**; no separate live V2 session recorded here |
| Claude Code 2.1.283 | `supracortex connect claude` (user scope) or project `init` | **Wiring live-verified**: add/list/remove in an isolated `CLAUDE_CONFIG_DIR` reported `Connected`; full model session not exercised |
| Codex CLI 0.162.1 | `supracortex connect codex` (`~/.codex/config.toml`) or project `init` | **Wiring live-verified**: add/list/remove in an isolated `HOME`; `mcp list` does not health-check, so liveness is covered by the stdio handshake test |
| Pi | Bundled extension; adapter is experimental | **Fixture/tarball-verified only**; no live session here; the pinned upstream patch is not shipped |
| Cursor | `mcpServers` config fixture / custom target | **Documented only**; no live session |
| Gemini CLI | `mcpServers` config fixture (bare style) | **Documented only**; no live session |
| DeepSeek Harness | MCP stdio via custom target or `connect generic` snippet | **Untested** |
| Other MCP stdio clients | `connect generic` snippet or `--target name=path[:bare]` | **Documented only**; verify in your client |
| ChatGPT web | Local stdio server | **Unsupported**; a browser session cannot launch a local stdio MCP server |

"Fixture/tarball-verified" means the generated configuration is tested for
create/merge/uninstall and the MCP server is tested over real stdio from the
packed artifact. It does not assert that the vendor's current client was run
against it.

## OpenCode version matrix

| OpenCode | Status | Notes |
|---|---|---|
| 1.18.x | Yes (verified 1.18.32) | Target. `dispose`, `tool`, and `experimental.chat.system.transform` are present. |
| 1.17.x and earlier | Untested | Plugin API may differ; `doctor` reports mismatches. |
| 1.19+ | Expected | Uses hooks present in 1.18; re-run compatibility tests after upgrading. |

## Node.js matrix

| Node | Status | Notes |
|---|---|---|
| >= 22.6 | Yes | Built CLI and stdio MCP server (`node:sqlite`). Running `.ts` sources directly needs Node's default type-stripping, enabled by default only on newer 22.x; 22.6–22.17 need `--experimental-strip-types` (the MCP source fallback passes it). |
| 22.0–22.5 | Partial | `node:sqlite` may need a flag. The JSONL driver is unaffected. |
| < 22 | No | Required built-ins are unavailable. |

## Windows and shell support

The core, CLI, and stdio MCP server run on Node.js and are designed for macOS,
Linux, and Windows. Ubuntu and macOS are release-gating in CI. **Windows is
best-effort**: the matrix still runs typecheck, tests, and the packed gate, but
Windows failures are non-blocking and are not a support claim. The tests that
are skipped on Windows are POSIX-specific (file modes, read-only rename
semantics, recycled-PID locks, multi-process SQLite children).

The `supracortex-mcp` launcher is a **POSIX bash script** and is not supported
on Windows. On Windows, invoke the Node entrypoint:

```powershell
node C:\path\to\supracortex\dist\cli.js mcp
node C:\path\to\supracortex\dist\cli.js init --yes
node C:\path\to\supracortex\dist\cli.js doctor
```

For an installed package use
`node node_modules\supracortex\dist\cli.js ...`. Bash, Zsh, Fish, PowerShell,
and CMD can invoke the Node CLI; unusual shells are not claimed as verified.
Host applications remain responsible for their own platform support.

## Recorded API assumptions

These were verified by inspecting installed type definitions and docs.

### Plugin API (`@opencode-ai/plugin`)

- A plugin is `(input, options?) => Promise<Hooks>`, exported as a named export.
  `PluginInput = { client, project, directory, worktree, serverUrl, $,
  experimental_workspace }`.
- `Hooks` includes `dispose()`, `event`, `config`, `tool`, `chat.message`,
  `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`,
  `tool.execute.before`, `tool.execute.after`, `shell.env`, and experimental
  hooks including `experimental.chat.system.transform`.
- `dispose()` exists and is used to flush metrics. There is no documented
  hot-unload; full module unload requires a new session.
- Tools use `tool()` with zod argument shapes. `ToolContext` supplies
  `sessionID`, `messageID`, `agent`, `directory`, `worktree`, `abort`,
  `metadata()`, and `ask()`.

### Commands

OpenCode does not support plugin-registered commands. Commands are markdown
files in `.opencode/commands/` (project) or
`~/.config/opencode/commands/` (global), with frontmatter and template features.
This project installs its slash commands as markdown files that shell out to the
CLI.

### Plugin load locations

- Project: `.opencode/plugins/`. Global: `~/.config/opencode/plugins/`.
- `supracortex init` writes its project loader to
  `.opencode/plugins/supracortex.ts`; it does not modify unrelated plugin or
  agent files.

### SDK client (`@opencode-ai/sdk`)

- Namespaces used: `find.{text,files,symbols}`, `file.{list,read,status}`,
  `mcp.status`, `vcs.*`, `config`, `session`, `project`, `command.list`.
- MCP discovery uses `client.mcp.status()`; the response shape is normalized
  defensively (array, `{servers:[]}`, or a name→server map).

## Behaviors that depend on optional runtime support

| Behavior | Requires | Fallback |
|---|---|---|
| Git-changed-file bias in context | `$` shell + git available | Omitted; retrieval still works. |
| MCP recommendations | `client.mcp.status()` present | Empty recommendation set. |
| Automatic prompt injection | OpenCode experimental message/system transform hooks and `integration.automaticContextPreparation` | No automatic packet; tools remain callable. |
| SQLite driver | `node:sqlite` (or `bun:sqlite` on Bun) | JSONL is the default. A configured SQLite store that cannot open surfaces an error instead of switching drivers. |
| Full module unload on disable | Not available in OpenCode 1.18.x | Feature gate makes it inert; a new session fully unloads. |
| Code-graph automatic hints | Explicit graph rebuild + `graph.automaticContext: true` | Graph tools still work explicitly; retrieval uses file/memory ranking. |

## Not implemented and not claimed

- **Provider-level prompt caching** (for example Anthropic cache-control) is not
  implemented. Only local summary/context caching exists, and it is never
  labelled as a provider cache hit.
- **Exact provider billing amounts.** The host does not surface per-request
  billed usage to the adapter, so token figures are local estimates.
- **True hot-unload** of the OpenCode plugin module from a running process is not
  supported by the 1.18.x lifecycle.
- **Periodic/timer sweeps.** OpenCode exposes no timer hook, so the staleness
  sweep runs opportunistically (engine init, `session.idle`, `session.deleted`)
  and on demand. It is idempotent.
- **ChatGPT web or any browser-only MCP client.** Local stdio cannot be launched
  from a web session.
- **Unverified host parity.** Supported hosts and their verification level are
  the table above; anything not listed is documented-only or untested.
