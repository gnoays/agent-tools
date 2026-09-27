---
name: usage
description: Show remaining Claude Code, Codex, Cursor and Antigravity (agy) quota (Claude/Codex/agy 5-hour and weekly windows, Cursor monthly usage, reset times). Use when the user asks how much usage / quota / limit is left, or before handing a large task to claude, codex, cursor-agent or agy.
---

# usage: remaining quota

`<root>` is the directory two levels above this file. Run:

```
node <root>/scripts/usage.mjs            # all
node <root>/scripts/usage.mjs claude     # or: codex, cursor, agy
node <root>/scripts/usage.mjs --json     # machine-readable (raw numbers, ISO UTC times); only when a script consumes it
```

Needs network access (in Codex: run it outside the sandbox / request escalation).

Show the table as-is, then one line calling out any window at 80% used or more and when it resets.
A row reading `error` means that service could not be checked (not logged in, expired token, network);
pass its message on instead of guessing.
