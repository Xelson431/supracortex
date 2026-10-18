# SupraCortex MCP tool contract

The stdio adapter (`supracortex mcp` or the `supracortex-mcp` shim) exposes the
tools below. Protocol JSON is written to stdout; diagnostics are written only to
stderr. The toolset API version is `2.0.0`; it is distinct from the date-based
MCP protocol version negotiated by the SDK.

## Stability tiers

| Tier | Tools |
|---|---|
| **STABLE** | `cortex_context`, `cortex_search`, `cortex_record`, `cortex_status`, `cortex_timeline`, `cortex_detail`, `cortex_handoff`, `cortex_resume`, `cortex_review`, `cortex_safety` |
| **EXPERIMENTAL** | `cortex_graph_status`, `cortex_graph_rebuild`, `cortex_graph_query`, `cortex_graph_path`, `cortex_graph_explain`, `cortex_graph_impact`, `cortex_jev_status`, `cortex_jev_review`, `cortex_capabilities` |

Stable tools are the supported contract. Experimental tools may change in shape
or behavior between releases; consumers should tolerate additive fields and pin
any integration that depends on their exact output.

The code-graph tools are experimental local navigation: they require an explicit
`cortex_graph_rebuild` before queries return a generation. Automatic graph hints
are off by default and require both a built generation and
`graph.automaticContext: true`.

## Stable tools

| Tool | Purpose |
|---|---|
| `cortex_context` | Prepare a bounded, explained context packet for a task. Read-only and deterministic. |
| `cortex_search` | Search persistent memory for relevant entries. Read-only. |
| `cortex_record` | Record a verified memory entry or task outcome. Durable kinds require source references; secret-shaped content is redacted. |
| `cortex_status` | Report enabled state, storage, counts, and the last error. Read-only. |
| `cortex_timeline` | Return a bounded chronological window of structural events. Read-only. |
| `cortex_detail` | Show one structural event by id. Read-only. |
| `cortex_handoff` | Create a bounded handoff capsule with goal, work, risks, and next actions. |
| `cortex_resume` | Read a previously created handoff capsule. Read-only. |
| `cortex_review` | List candidates or move an entry through the review actions below. |
| `cortex_safety` | Report observed local evidence for changed files. It never runs git, tests, shells, or scanners. |

## Inputs and output shape

- Inputs use strict schemas and are bounded per field and as a complete JSON
  argument payload (**32,000 UTF-8 bytes**).
- `content[0]` is always a JSON text block containing the tool result. If an
  advisory is present (for example the untrusted-data notice on
  `cortex_context` / `cortex_search`), it is a separate trailing text item and
  is never merged into the validated JSON payload.
- `structuredContent` carries the same JSON object as `content[0]`. A non-object
  result is wrapped as `{ "value": ... }`.
- Text and `structuredContent` are each bounded to **48,000 UTF-8 bytes**. An
  oversized result returns a small, valid truncation envelope
  (`truncated`, `limitBytes`, `result`) rather than half-serialized JSON.
- Tool listings include strict input and output JSON schemas plus
  read-only/destructive annotations where applicable. Output schemas are
  advertised permissively so a host validating `structuredContent` cannot reject
  a committed result; the server still validates strictly before returning.
- Disabled projects return `{ "disabled": true, "noop": true }` successfully and
  perform no writes. Invalid input is a model-visible tool error.
- An abort signal observed before a mutating commit returns an error and does not
  mutate storage.

The server advertises tools only: no resource, prompt, or completion capability
is exposed until it has a stable, bounded implementation.

Durable writes are `active` by default when they carry evidence. Pass
`status: "candidate"` to submit a durable entry for review without evidence;
the entry then appears in `cortex_review` `list` and activates only via
`approve`.

## `cortex_review` actions

| Action | Semantics |
|---|---|
| `list` | List entries by status (default `candidate`). Read-only. |
| `approve` | Verify every hashed file reference against the current index, then set the entry `active`. This is the activation step. |
| `edit` | Update content, confidence, or tags. Does not re-verify evidence. |
| `dispute` | Mark the entry `disputed` for contradiction review. |
| `invalidate` | Mark the entry `stale` explicitly because its evidence is no longer trusted. |
| `pin` | Add the `pinned` tag so retrieval keeps the entry prominent. |
| `suppress` | Set the entry to `forgotten` so it is no longer surfaced. |
| `purge` | Delete the entry. Destructive and irreversible. |
| `refresh-evidence` | Re-read current hashed file references, store the new hashes, set `lastVerifiedAt`, and clear `needsReverifyAt`. It never activates the entry. If any referenced file is missing, the action fails with the `missing` paths, changes nothing, and writes no audit row. |

Age-based re-verification sets `needsReverifyAt` without changing `status`.
`stale` means an evidence mismatch or explicit invalidation. The recovery order
is `refresh-evidence`, then `approve` when activation is intended.

`cortex_record` accepts an explicit verified memory or task outcome only;
candidate or imported text is not recorded as active memory through this
surface. Imported or candidate content never becomes active without an explicit
`approve`.

`cortex_safety` reports observed evidence only and never runs git, tests, shells,
or scanners.

## Output guarantees

- A normal result is a single, schema-valid JSON object in `content[0]` and
  `structuredContent`; optional advisory text is separate.
- Results never exceed the 48,000-byte cap; oversized results are replaced by a
  valid truncation envelope.
- Unknown input fields are rejected rather than ignored.
- Tools annotated read-only do not mutate memory, tasks, or graph state.
  Mutating tools either commit fully or return an error without committing when
  aborted first.
- Disabled projects are a successful no-op, not an error.
