---
description: Reset generated supracortex data (cache/index/sessions/metrics). Requires confirmation.
agent: build
---

The user wants to reset supracortex data with target: $ARGUMENTS

Valid targets: cache, index, sessions, metrics, all-generated, all.

IMPORTANT: `all` deletes durable memory too. Confirm the target with the user before running. Only durable memory is at risk with `all`; other targets are safe generated data.

Once confirmed, run:

!`node "__CI_CLI__" reset $ARGUMENTS --yes`

Report what was removed.
