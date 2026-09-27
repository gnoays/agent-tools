---
description: Show background agent jobs (cursor-agent, agy, claude, codex); with a job id, also recent tool activity for this directory
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" status "$ARGUMENTS"`

Present the command output to the user as-is.
