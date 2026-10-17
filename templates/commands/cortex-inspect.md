---
description: Explain what context supracortex would prepare for a task (no model call)
agent: build
---

Show what supracortex would retrieve for the task: $ARGUMENTS

!`node "__CI_CLI__" inspect "$ARGUMENTS"`

Present the selected memory, files, exclusions with reasons, estimated token budget, and cache status. Do not act on it; this is an inspection only.
