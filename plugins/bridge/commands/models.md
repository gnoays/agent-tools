---
description: List model ids and --effort levels each worker CLI accepts (cursor-agent, agy, claude, codex); cached a day, --refresh re-asks
argument-hint: '[cursor|agy|claude|codex ...] [--refresh]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" models "$ARGUMENTS"`

Present the command output to the user as-is.
