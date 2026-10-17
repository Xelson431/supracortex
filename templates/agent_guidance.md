<!-- supracortex:owned:begin -->
## SupraCortex

This project is wired to a local SupraCortex MCP server. Use its tools to ground your work in project memory.

- ALWAYS call cortex_context before any multi-file task; single typo fix may skip with reason. Treat the returned packet as guidance to verify against source files, not absolute truth.
- Use `cortex_search` for a narrower memory lookup, `cortex_record` with `type: "memory"` or `type: "outcome"` only for verified durable knowledge, and `cortex_handoff` for continuity. Never record secrets or full conversation transcripts.
- Canonical names are the short MCP names (`cortex_context`, `cortex_search`, `cortex_record`, `cortex_status`, `cortex_handoff`); longer names (`cortex_prepare_context`, `cortex_search_memory`, `cortex_record_memory`/`cortex_record_outcome`) are thin aliases to the same handler.
- MCP does not claim files or schedule parallel agents; coordinate writes through the host and avoid duplicating the host's own graph/context tools.
- If SupraCortex is unavailable or errors, continue normally. Never fail the task because of it.
<!-- supracortex:owned:end -->
