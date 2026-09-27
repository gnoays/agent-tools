---
description: Cancel a running background agent job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" cancel "$ARGUMENTS"`

Present the command output to the user as-is.
