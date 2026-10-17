---
name: supracortex
description: Use SupraCortex for bounded repository context, verified project memory, structural history, code-graph evidence, and safe coordination of parallel work. Use for non-trivial repository tasks, handoffs, impact analysis, or parallel changes.
---

<!-- supracortex:owned -->

# SupraCortex

Use SupraCortex to reduce duplicate work and ground repository changes in local
evidence. It is advisory: verify important facts in source and continue the
main task if it is unavailable, disabled, or returns an error.

## Start A Non-Trivial Task

1. Call `cortex_context` once with the task and any known relevant files.
2. Use the packet as a bounded reading plan, not as a replacement for source.
3. Do not request another context packet unless the task, repository state, or
   token budget materially changed.
4. Read the selected source files before changing behavior.

For a small isolated edit, direct source inspection is usually faster than
preparing context. ALWAYS call cortex_context before any multi-file task; single typo fix may skip with reason.

## Select The Right Evidence

| Need | Preferred capability |
| --- | --- |
| Prior decisions, constraints, or outcomes | `cortex_context` or `cortex_search` |
| Recent work, commands, tests, or file changes | `cortex_timeline`, then `cortex_detail` |
| Current state and available capabilities | `cortex_status` |
| Symbol relationships or change impact | `cortex_graph_*`, only when graph is enabled and fresh |
| Parallel task decomposition | Use the host's own coordination; MCP does not claim files or schedule agents |
| Durable verified decision or completed outcome | `cortex_record` with `type: "memory"` or `type: "outcome"` |

Canonical tool names are the short MCP names (`cortex_context`, `cortex_search`, `cortex_record`, `cortex_status`, `cortex_handoff`). Longer names (`cortex_prepare_context`, `cortex_search_memory`, `cortex_record_memory`/`cortex_record_outcome`) are thin aliases to the same handler — same behavior, canonical logging.

Use narrow queries, paths, limits, and token budgets. Prefer a targeted graph
or memory query over broad history or graph dumps. Treat stale, ambiguous, or
unresolved graph results as leads to verify in source.

## Parallel Changes

1. Use the host's own coordination mechanism when work has independent write lanes.
2. Keep responsibilities and file ownership explicit in that host.
3. Do not use MCP context retrieval as proof that a file is safe to edit.
4. Avoid automatic duplicate injection when the host already provides context or graph tools.

## Persist Only Durable Evidence

Record concise facts that would save future work: a verified architectural
decision, an observed compatibility constraint, a completed migration, or a
test-backed outcome. Include source references when available.

Never record secrets, credentials, access tokens, private keys, raw user
transcripts, unverified assumptions, or source facts that are cheap to recover
by reading the repository.

## Finish Well

After implementation, run relevant verification. Record a durable outcome only
when it is verified and likely useful to a later task. If SupraCortex is not
available at any point, continue with normal repository inspection, version
control, and test workflows; never block or fail the task because of it.
