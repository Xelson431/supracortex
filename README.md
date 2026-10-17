# SupraCortex

Local-first project memory for coding agents.

SupraCortex gives coding agents one durable, evidence-backed memory store per
project. Claude Code, Codex, OpenCode, and any other MCP stdio client can reach
the same store over the Model Context Protocol, and the bundled CLI can inspect
and manage it directly. Retrieval is deterministic and explained, so an agent
gets bounded context instead of a flooded prompt.

SupraCortex ships as a stdio MCP server, a CLI, an optional native OpenCode
adapter, and a portable agent skill. Pi support is experimental and requires a
pinned upstream patch that is not shipped with the package.

## Why it exists

- **Memory across hosts.** Durable facts, decisions, conventions, failures,
  constraints, and task outcomes live in one project-local `.supracortex/`
  store. Any host that launches the MCP server against the same project root
  reads the same memory.
- **Evidence and freshness.** Durable entries carry source references and
  hashes. Contradictions are surfaced instead of silently overwritten, and
  changed evidence marks an entry `stale` rather than pretending it is current.
- **Bounded context.** Every selected memory entry and file has a reason, a
  token estimate, and a hard budget. Large files become summaries or references
  instead of consuming the prompt.
- **Review before activation.** Imported or candidate content stays a candidate
  until an explicit `approve`. Memory is never reactivated implicitly.

## Install and quickstart

Requirements: **Node.js >= 22.6** for the CLI and MCP server. OpenCode is
**not** required.

```bash
npm install -g supracortex
cd /path/to/your/project

supracortex init --yes              # wire this project (plan only without --yes)
supracortex connect claude          # or: supracortex connect codex
supracortex doctor
```

- `supracortex init --yes` detects supported hosts and writes the project-local
  wiring and guidance it owns. Run it inside each project you want SupraCortex
  to remember.
- `supracortex connect claude` registers the server at Claude Code user scope;
  `supracortex connect codex` writes a marker-fenced block in
  `~/.codex/config.toml`. `supracortex connect generic` prints a standard
  `mcpServers` JSON snippet instead of editing a file.
- The MCP server entry point hosts should launch is `supracortex mcp` (or the
  installed `supracortex-mcp` shim, or
  `node node_modules/supracortex/dist/cli.js mcp` on Windows). Launch it with
  its working directory set to the project root, or set `SUPRACORTEX_ROOT`, so
  every host shares one `.supracortex/`.
- `supracortex doctor` checks wiring, storage, and host configuration.

A local install works the same way with `npx`:

```bash
npm install supracortex
npx supracortex init --yes
npx supracortex connect generic
npx supracortex doctor
```

For a host that follows the standard `mcpServers` convention but has no
built-in adapter, point `--target` at its config file:
`supracortex init --yes --target mycli=.mycli/mcp.json[:bare]` (the `:bare`
suffix omits the `type` field for clients that reject it). This is a wiring
convention, not a live-verification claim.

From a source checkout, build first and use the Node entrypoint:

```bash
pnpm install && pnpm run build
node dist/cli.js init --yes
node dist/cli.js connect generic
node dist/cli.js doctor
```

## Core workflow

| Stage | What it does | Surface |
|---|---|---|
| **Record** | Store a verified memory or task outcome. Durable facts, decisions, conventions, and constraints require `sourceReferences`; likely secrets are redacted. | `cortex_record` |
| **Retrieve** | Build a bounded context packet for the task, or search memory directly. Treat the packet as guidance to verify against source. | `cortex_context`, `cortex_search` |
| **Review** | List candidates and move entries through `approve`, `edit`, `dispute`, `invalidate`, `pin`, `suppress`, or `purge`. | `cortex_review` |
| **Handoff** | Capture goal, completed work, tests, risks, and next actions in a bounded capsule; resume it later. | `cortex_handoff`, `cortex_resume` |
| **Recovery** | If evidence changed, `refresh-evidence` accepts the current file hashes, then `approve` performs the explicit activation. Age alone only sets `needsReverifyAt`; it never changes `status`. | `cortex_review`, `cortex_sweep` |

Memory status is explicit: `stale` means an evidence mismatch or an explicit
invalidation, not mere age. Unresolved failures and active constraints are never
expired. Imported or candidate content never becomes active without an explicit
`approve`.

## Tool stability

The MCP tool set is versioned by the toolset API contract (`2.0.0`), separate
from the date-based MCP protocol version negotiated by the SDK.

| Tier | Tools |
|---|---|
| **STABLE** | `cortex_context`, `cortex_search`, `cortex_record`, `cortex_status`, `cortex_timeline`, `cortex_detail`, `cortex_handoff`, `cortex_resume`, `cortex_review`, `cortex_safety` |
| **EXPERIMENTAL** | `cortex_graph_status`, `cortex_graph_rebuild`, `cortex_graph_query`, `cortex_graph_path`, `cortex_graph_explain`, `cortex_graph_impact`, `cortex_jev_status`, `cortex_jev_review`, `cortex_capabilities` |

Stable tools are the supported contract. Experimental tools may change in shape
or behavior between releases; treat their output as advisory and pin any
integration that depends on it. The native OpenCode adapter exposes a
**superset**: in addition to the MCP tools it provides the same canonical
handlers, long-form aliases, and orchestration tools such as
`cortex_prepare_context`, `cortex_search_memory`, `cortex_record_memory`,
`cortex_record_outcome`, `cortex_plan_tasks`, `cortex_claim_files`,
`cortex_release_files`, `cortex_validate_cache`, `cortex_compact`,
`cortex_sweep`, `cortex_metrics`, and `cortex_sync_supraspace`.

### Retrieval quality

Self-reported benchmark results, reproducible from this repository with
`node benchmarks/eval.ts --retriever deterministic --corpus 1.0.1` and the
`fts5` equivalent. Corpus 1.0.1 has 93 entries with deduped labels; these are
recall@5 on the answerable subsets (51 tuning / 38 holdout queries).

| Retriever | Tuning | Holdout |
|---|---|---|
| Deterministic (default) | 0.866 | 0.868 |
| SQLite FTS5 sidecar (opt-in) | 0.927 | 0.934 |

These are self-reported measurements, not an independent evaluation. They
describe retrieval on this corpus, not savings on provider billing.

## Privacy and data

- **Local storage.** Runtime state lives under `<project>/.supracortex/`.
  JSONL is the default. SQLite is opt-in via `storage.driver: "sqlite"`,
  requires a SQLite runtime (`node:sqlite`, or `bun:sqlite` under Bun), and adds
  an FTS5 retrieval sidecar at `state/store.sqlite`. A configured SQLite store
  that cannot open surfaces an error; it does **not** silently switch to JSONL.
- **Git boundary.** SupraCortex generates `.supracortex/.gitignore`, which
  ignores everything under the runtime directory except `.gitignore`,
  `config.jsonc`, `config.schema.json`, and `.supracortexignore`. Runtime
  memory, tasks, cache, and timelines stay out of version control unless you
  deliberately un-ignore specific files.
- **What is excluded.** API keys, tokens, cookies, credentials, private keys,
  `.env`-shaped files, and full conversation transcripts are not persisted.
  Secret-shaped content is redacted before storage, but redaction is a
  best-effort heuristic, not a guarantee.
- **Injection mirror.** The OpenCode adapter's injection mirror stores a
  digested request id, never the raw prompt or query text.
- **Jev egress.** Jev is enabled by default but inert without credentials. If
  you provide an OpenRouter key (or another configured decision provider), a
  session may send bounded task snippets to that provider, subject to a
  deadline. Without a credential, the decision layer makes no provider call;
  failures, missing credentials, and uncertain responses fall back to
  deterministic ranking. `cortex_jev_status` reports state without calling the
  provider.
- **Uninstall keeps data by default.** `supracortex uninstall --yes` keeps
  memory and configuration unless you pass `--remove-data`. Use `--global` for
  a global install.

## Host support

Status as of **2026-10-17**. Versions are the ones pinned or recorded in this
repository where applicable: OpenCode V1 plugin `1.18.32`, V2 plugin `2.0.16`,
MCP SDK `1.29.0`, Node.js `22.23.1` (the declared minimum is `22.6`).

| Host | Wiring | Status |
|---|---|---|
| OpenCode 1.18.32 (V1) | Native V1 OpenCode plugin (`supracortex init`) | **Live-tested on this machine** |
| OpenCode 2.0.16 (V2) | Native V2 OpenCode plugin | **Fixture/tarball-verified only**; no separate live V2 session recorded here |
| Claude Code 2.1.283 | `supracortex connect claude` (user scope) or project `init` | **Wiring live-verified**: `mcp add`/`list`/`remove` against the built server reported `Connected`; full model session not exercised |
| Codex CLI 0.162.1 | `supracortex connect codex` (`~/.codex/config.toml`) or project `init` | **Wiring live-verified**: `mcp add`/`list`/`remove` succeeded; `mcp list` does not health-check, so liveness is covered by the real stdio handshake test |
| Pi | Bundled extension (experimental adapter) | **Fixture/tarball-verified only**; no live session on this machine; the pinned upstream patch is not shipped |
| Cursor | `mcpServers` config fixture / custom target | **Documented only**; no live session |
| Gemini CLI | `mcpServers` config fixture (bare style) | **Documented only**; no live session |
| DeepSeek Harness | MCP stdio via custom target or snippet | **Untested** |
| Other MCP stdio clients | `supracortex connect generic` snippet or custom target | **Documented only**; verify in your client |
| ChatGPT web | Local stdio server | **Unsupported**: a browser session cannot launch a local stdio MCP server |

Status definitions:

- **Live-tested**: a real host session was run on this machine against this
  repository's build.
- **Wiring live-verified**: the real host binary accepted, listed, and removed
  the server against this repository's build (isolated config dirs), but a full
  model-driven session was not exercised.
- **Fixture/tarball-verified only**: config generation/merge and the packed MCP
  stdio server are covered by tests, but no live session of that host was run
  here.
- **Documented only**: wiring is documented and may have config fixtures, but
  there is no verification claim for a live session.
- **Untested**: no verification claim.

MCP hosts receive the tool set defined in [MCP_PROTOCOL.md](./MCP_PROTOCOL.md).
Capabilities differ by host: only the native OpenCode adapter supplies lifecycle
hooks and the additional orchestration tools. See
[COMPATIBILITY.md](./COMPATIBILITY.md) for the full matrix and recorded API
assumptions.

## Limitations and non-goals

- **No agent scheduling.** SupraCortex does not run agents, create background
  work, or replace a host/orchestrator scheduler. It recommends and records;
  the host executes.
- **No embeddings or vector database.** Retrieval is deterministic and lexical:
  path, symbol, tags, recency, git changes, confidence, and memory kind.
- **No provider prompt caching.** Only local summary/context caching exists.
  Local cache hits are never reported as provider cache hits.
- **No billing or token-reduction claims.** Token figures are local estimates.
  MCP metrics describe reduced calls, schema size, and result context, not
  billed provider usage.
- **No silent reactivation.** `refresh-evidence` updates hashes without
  activating an entry; `approve` is the explicit activation step. Imports and
  candidates stay candidates until approved.
- **Code graph is experimental.** It requires an explicit rebuild and is never
  built automatically. Automatic graph hints require both a built generation and
  `graph.automaticContext: true`.
- **Pi is experimental.** The adapter depends on a pinned upstream patch that is
  not shipped with the package, and no live Pi session is claimed.
- **No hot unload in OpenCode.** Disabling makes the adapter operationally inert
  immediately, but a new session is required to fully unload the module.
- **Windows launchers are limited.** The `supracortex-mcp` launcher is a POSIX
  bash script and is not supported on Windows; use the Node entrypoint there.
- **SQLite fails closed.** If `storage.driver` is `"sqlite"` and the database
  cannot open, the engine reports an error rather than silently switching to
  JSONL.
- **No host parity claim.** Features and lifecycle behavior depend on the host;
  see [Host support](#host-support).
- **Pre-0.2 promoted outcomes are not migrated.** Older builds wrote promoted
  outcome memories into `tasks/completed.jsonl`; they remain task records but
  are no longer surfaced as memory entries.

## Troubleshooting and development

```bash
supracortex doctor                 # health checks; exit 1 if a check fails
supracortex status                 # effective state, storage, and last error
supracortex status --json          # machine-readable
supracortex inspect "task query"   # show what context would be prepared
```

- **Host cannot see memory**: launch the MCP server with its working directory
  set to the project root (or export `SUPRACORTEX_ROOT`).
- **Disabled**: check `SUPRACORTEX_DISABLE`, then `supracortex status` for the
  reason and source. A project opt-out lives in
  `<project>/.supracortex/config.jsonc`.
- **Stale selections**: run `supracortex inspect "<query>"`; use
  `cortex_validate_cache` from the OpenCode adapter to drop stale summaries.
- **Corrupt generated state**: `doctor` reports corrupt lines; the store skips
  them. `supracortex reset all-generated --yes` clears generated data without
  deleting durable memory. `reset all --yes` also deletes memory.
- **Windows**: use the Node entrypoints (`node .../dist/cli.js mcp`). The POSIX
  launchers are macOS/Linux only.
- **Upgrading from pre-0.2 builds**: promoted outcome memories that older builds
  wrote into `tasks/completed.jsonl` are not migrated automatically. The task
  records remain on disk and are still owned by the task subsystem, but they are
  no longer surfaced as memory entries. New promoted outcomes are written to
  `memory/outcomes.jsonl`. Task-subsystem records are unaffected.

Development:

```bash
pnpm install
pnpm verify          # typecheck + tests + build + evaluation/benchmarks
pnpm verify:packed   # packed-artifact acceptance gate
```

Individual gates are available as `pnpm run typecheck`, `pnpm test`,
`pnpm run build`, and `pnpm run lint`. Evaluation suites run as part of
`pnpm test`. The compatibility CI matrix runs typecheck, tests, and the packed
tarball gate on Ubuntu, macOS, and Windows.

Further reading: [INSTALL.md](./INSTALL.md) for a step-by-step tutorial,
[MCP_PROTOCOL.md](./MCP_PROTOCOL.md) for the tool contract,
[COMPATIBILITY.md](./COMPATIBILITY.md) for host/version status, and
[SECURITY.md](./SECURITY.md) for the security model.
