# agent-tools

Plugins for Claude Code and Codex that work across agent CLIs.

| Plugin | What it does |
|---|---|
| **bridge** | Delegates tasks to headless agent CLIs (cursor-agent, agy, claude, codex) and supervises them: background jobs, wait, follow-up comments, resume. Before a task it warns if the chosen model's quota pool is nearly used up (with the usage plugin). |
| **usage** | Shows remaining quota for Claude Code, Codex, Cursor and Antigravity (agy) as a table or JSON. It makes no model calls. |

## Requirements

- Node.js 22 or newer
- For bridge: whichever worker CLIs you want to delegate to (`cursor-agent`, `agy`, `claude`, `codex`), installed and logged in
- For usage: the CLIs you want to check, logged in (Claude and Codex are asked through their CLIs; Cursor and agy through the tokens their CLIs store locally)
- Behind a proxy: the CLIs use their own proxy settings. For usage's Cursor and agy checks, also set
  `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY`, on a Node that supports it (`node --help` lists `--use-env-proxy`)

## Install

Claude Code:

```sh
claude plugin marketplace add gnoays/agent-tools
claude plugin install bridge@gnoays-agent-tools
claude plugin install usage@gnoays-agent-tools
```

Codex:

```sh
codex plugin marketplace add gnoays/agent-tools
codex plugin add bridge@gnoays-agent-tools
codex plugin add usage@gnoays-agent-tools
```

## Use

Ask in plain words, for example "hand this refactor to cursor and review the result" or "how much quota is left?".
The skills tell the host agent which script to run. You can also run the scripts directly:

```sh
node plugins/bridge/scripts/companion.mjs task --cli cursor -- "explain src/main.ts"
node plugins/bridge/scripts/companion.mjs models cursor
node plugins/usage/scripts/usage.mjs            # all services
node plugins/usage/scripts/usage.mjs agy --json
```

Workers started by bridge run outside the host's permission system. With `--write` they edit files and run
commands without asking, so pass it only when you want changes.

## Disclaimer

Unofficial; not affiliated with Anthropic, OpenAI, Cursor or Google. The usage plugin reuses the login each CLI
already has, sends it only to the provider that issued it, and may break when a provider changes its service.
Use at your own risk and follow each provider's terms.

## Tests

```sh
node plugins/bridge/scripts/test/companion.test.mjs
node plugins/usage/scripts/test/usage.test.mjs
```

## License

MIT
