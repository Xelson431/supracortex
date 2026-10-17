# Agent guide

SupraCortex is a local-first, host-agnostic project-memory and context engine
for coding agents. One core engine, host adapters, a stdio MCP server, and a CLI.
Read [README.md](./README.md) for the product overview and
[MCP_PROTOCOL.md](./MCP_PROTOCOL.md) for the tool contract.

## Repository map

| Path | Responsibility |
|---|---|
| `packages/core` | The engine: memory, indexing, context selection, storage, orchestration, events, metrics, code graph, cache, diagnostics, Jev, vault, SupraSpace, importers. No host coupling. |
| `packages/opencode` | OpenCode adapter: V1 `plugin.ts` and V2 `plugin-v2.ts`, native tools and lifecycle hooks, host wiring/connect, and the CLI core. |
| `packages/pi` | Pi host adapter. Experimental; its pinned upstream patch is not shipped. |
| `packages/tui` | Brand TUI plugin for OpenCode. Branding only; the host supplies the UI runtime. |
| `src/` | Public API (`api.ts`), stdio MCP server (`mcp.ts`), protocol contract and limits (`protocol.ts`). |
| `scripts/` | `cli.ts` dispatcher, `build.ts`, and the POSIX `supracortex-mcp` launcher. |
| `templates/` | Shipped assets: central config, OpenCode plugin entry, slash commands, and the agent skill. |
| `tests/` | unit / integration / acceptance / compatibility / evaluation. |

Entry points: bin `supracortex` → `dist/cli.js`; package exports `.` `/protocol`
`/mcp` `/opencode` `/opencode-v2`; MCP host shim `supracortex-mcp`.

## Architecture boundary

- `packages/core` is host-agnostic. It must not import OpenCode, Pi, or TUI code.
- Adapters (`packages/opencode`, `packages/pi`, `src/mcp.ts`) may import core;
  the dependency never points the other way.
- `src/protocol.ts` is the MCP contract: tool names, input/output schemas,
  aliases, and the 32k input / 48k output limits. Change it deliberately.
- `src/mcp.ts` is the stdio transport. Protocol JSON goes to stdout; diagnostics
  go to stderr.
- Stable MCP tools: `cortex_context`, `cortex_search`, `cortex_record`,
  `cortex_status`, `cortex_timeline`, `cortex_detail`, `cortex_handoff`,
  `cortex_resume`, `cortex_review`, `cortex_safety`.
- Experimental MCP tools: `cortex_graph_*`, `cortex_jev_status`,
  `cortex_jev_review`, `cortex_capabilities`. They may change.
- The native OpenCode adapter is a superset: it adds lifecycle hooks and
  planning, file-claim, cache-validation, compaction, sweep, metrics, and
  SupraSpace tools.

## Verify before shipping

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm verify        # typecheck + tests + build + evaluation/benchmarks
pnpm verify:packed # tarball E2E gate
```

Run the narrowest gate that covers your change, and never report a count of
tests that the run did not produce.

## Do not claim

- That SupraCortex makes no network calls in general. The deterministic path is
  local, but Jev is enabled by default and sends bounded snippets to OpenRouter
  (or the configured provider) only when a key is configured.
- Provider billing or token reductions. Token figures are estimates; there is no
  provider prompt caching.
- Support for a host that has not been live-verified here. OpenCode V1 is
  live-tested; OpenCode V2 is fixture/tarball-verified only; Claude Code and
  Codex are wiring live-verified (full model session not exercised); Pi is
  experimental and fixture/tarball-verified only; Cursor and Gemini are
  documented only; DeepSeek Harness is untested; ChatGPT web is unsupported for
  local stdio.
- That experimental tools or config fields are stable.
- That memory is reactivated implicitly. `refresh-evidence` only updates hashes;
  `approve` activates.
- That SQLite silently falls back to JSONL. A configured SQLite store that
  cannot open fails closed.

## Conventions

- Keep host-specific code in adapters; never add host imports to core.
- Preserve the untrusted-data fencing on retrieved memory and files.
- Do not commit runtime state from `.supracortex/` or generated build output.
- Update the contract docs when a stable tool, schema, or limit changes.
