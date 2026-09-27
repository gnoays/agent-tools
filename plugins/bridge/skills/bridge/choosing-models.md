# Choosing a worker model and effort

This is a default policy. If `~/.agent-bridge/models.md` exists, the user wrote their own: follow that instead.

Tags: [official] = the vendor's docs say so; [practice] = common community practice, weigh it lower.

## Start from the defaults

Pass no `--model` and no `--effort` unless the user named one or a rule below clearly applies.
Never type an id from memory. Run `models <cli>`: its ids, descriptions and effort lists are the source.
`models` groups each family (same name, other versions) under a `### name` header, newest first, and tags the newest `[latest]`. Prefer `[latest]` when choosing inside a family.
The tags compare versions only: across families (opus vs gpt, pro vs flash) names do not tell you strength or price.

## Decide by

1. **Cost of a wrong answer.**
   - Cheap to catch (tests exist, the diff is small, you will review it anyway): go light.
   - Expensive to catch (design, security, concurrency, data migration, final review): go strong.
   "Strong" means a stronger model at its default effort. Raising effort is for escalation, after a failure,
   even when the user says "important" or "quality first": that picks the model, not the effort.
2. **Kind of work.**
   - Read-only search, reading code, summarising logs: a light model or low effort.
     [official: Anthropic lists low effort as meant "for subagents"; Haiku for "sub-agent tasks"]
   - Routine edits with acceptance tests: the CLI default.
   - Multi-file design, bugs of unknown cause, reviews: a stronger model or higher effort. [practice]
3. **Context size.** Only text the model must hold at once counts: a log or spec pasted whole.
   Searching a large repo does not need a large-context model; workers search with tools. [practice]
4. **Quota.** Before long or parallel runs, check `usage` (the usage plugin).
   Send work to a pool that still has room.
   - claude: one 5h and one weekly pool. Fable may use only part of the weekly one on Max. [official]
   - codex: 5h and weekly pools. The Fast service tier uses more of them. [official: model catalog]
   - cursor: "Cursor models" (Grok, Composer) and "other models" are billed separately. [official]
   - agy: the Gemini group and the Claude/GPT group are separate. [official]

   Avoid the Fast tier and `-fast` variants unless the user names them, even for hard or urgent tasks:
   they use more of the pool. [official for the Fast tier]
   "Quick" or "urgent" is not naming them.
   Avoid Fable on Max unless named too: it may use only part of the weekly pool (above). [official]

## Escalate, do not start high

- If the worker misunderstood, fix the task text first. That is not a capability problem.
- If a round fails and it looks like capability: raise effort one step, then switch to a stronger model.
  [official: Anthropic's order is to sweep effort before switching model]
- Do not start at max, xhigh or ultra. They cost more and can overthink. [official]
- A retry with the same model and effort is not an escalation. Escalating means changing one of them.
- Two escalations on one piece without progress: stop and ask the user (see SKILL.md, fix loop).

## Per CLI

- **claude**: Opus's default effort is medium; do not raise it by habit. Haiku takes no effort. [official]
- **codex**: `models codex` shows each model's default effort. Omitting `--effort` keeps it.
  For edits that need no network, prefer `--mode workspace-write` over `--write`.
  `ultra` delegates to sub-agents on its own; avoid it for bounded tasks.
- **cursor**: effort and `-fast` are part of the model id; there is no `--effort`.
  Default effort in an id: the base alone if `(none)` is listed, else `-medium`, else the lowest listed. Higher suffixes are escalation.
  `-fast` costs about 2x for speed, not quality. [official]
  `auto` routes per request; pick an explicit id when you need predictable behaviour.
- **agy**: a suffix like `-high` in the id is the effort, chosen as for cursor. Do not also pass `--effort`: the combination is not documented.

## Before sending, check

- The id is in `models` output exactly; for cursor/agy it is base + one listed variant, or the base alone only if `(none)` is listed or it has no variants.
- No raised effort and no high suffix on a first attempt.
- `--write` only when the task edits files; for codex edits without network, `--mode workspace-write`.
- The model's pool is the preferred one above, or you can say why not.

## Report

Say which model and effort each worker used, and why, when it was not the default.
