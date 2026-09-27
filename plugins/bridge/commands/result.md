---
description: Show the final output of a finished background agent job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize it. Keep the `[<cli> session: ...]` line so the work can be resumed.
