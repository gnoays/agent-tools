---
description: Wait for a background agent job to finish and show its result (gives up after 100s; run again to keep waiting)
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" wait --timeout 100 "$ARGUMENTS"`

Present the full command output to the user. Do not summarize it. Keep the `[<cli> session: ...]` line so the work can be resumed.
