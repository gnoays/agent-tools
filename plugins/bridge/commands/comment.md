---
description: Send a follow-up instruction to a running background agy or claude job (agy runs it after the current turn; claude folds it into the current one)
argument-hint: '<job-id> <text>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" comment "$ARGUMENTS"`

Present the command output to the user as-is.
