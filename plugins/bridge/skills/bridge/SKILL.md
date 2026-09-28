---
name: bridge
description: Delegate coding or research work to another headless agent CLI (cursor-agent, agy, claude, codex) and supervise it — run jobs in the background, wait, review the diff and tests, send follow-ups. Use when the user asks to hand a task to cursor / agy / claude / codex, or to split a large task across agents, or asks which models / effort levels a CLI accepts.
---

# bridge: delegate and supervise

All actions go through one script. `<root>` is the directory two levels above this file.

```
node <root>/scripts/companion.mjs task --cli cursor|agy|claude|codex [flags] -- "<task>"
node <root>/scripts/companion.mjs status [id] | result [id] | wait <id> [--timeout S] | cancel <id> | comment <id> <text>
node <root>/scripts/companion.mjs models [cursor|agy|claude|codex] [--refresh] # ids --model accepts, --effort levels; cached a day
```

Run it outside any command sandbox (in Codex: request escalated permissions): it writes job state under
`~/.agent-bridge` and the worker CLI needs the network.

Flags: `--write` (edits and commands unsandboxed; default is read-only), `--mode` (codex `workspace-write`: edits in cwd, sandboxed commands), `--model <name>`, `--effort` (agy, claude, codex),
`--background`, `--resume <session-id>`, `--resume-last`. Foreground output ends with `[<cli> session: <id>]`.

Model and effort: leave both off (each CLI's default) unless the user names one. Before choosing yourself,
read `~/.agent-bridge/models.md` if it exists, else `choosing-models.md` next to this file.
Take ids from `models`, never from memory. If a worker rejects an id, rerun `models <cli> --refresh`.
`task` prints `warning: ... % used` on stderr when the model's quota pool is nearly out (needs the usage plugin):
switch to a roomier pool unless the user named that model.

## Supervising a large task

You are the supervisor: you split, dispatch, judge. You do not write the code yourself.

1. **Split** into pieces with clear, independently checkable outcomes. Put acceptance criteria (tests to pass, files in scope) into every task text; the worker sees nothing but that text.
2. **Dispatch** with `--background`. Read-only investigations may run in parallel. At most one `--write` job per directory — the script refuses a second one.
3. **Wait** with `wait <id>` (returns the result; exit 2 = still running, call again). Use `status <id>` to look at progress without blocking.
4. **Judge** it yourself: read the actual diff (`git diff`) and run the tests. Do not trust the worker's own summary.
5. **Fix loop**: send corrections with `comment <id>` while it runs (agy, claude) or `task --resume <session-id>` after it ends. With several jobs of one CLI, always pass the session id; `--resume-last` is refused while a sibling job runs.
6. **Stop after 3 fix rounds** on the same piece and ask the user — do not keep rewriting and spending unattended.
7. **Report**: what each worker did, what you verified, what is left.

Workers run outside the host's permission system: `--write` lets them edit files and run commands unprompted. Only pass it when the user asked for changes.
