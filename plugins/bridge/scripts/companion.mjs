#!/usr/bin/env node
// Companion for headless agent CLIs (cursor-agent, agy, claude, codex): maps task/status/result onto `<cli> -p --output-format json`
// (codex: `codex exec --json`).
// Plain Node CLI, so any host that can run a shell command (Claude Code, Codex, cursor, agy) can use it.
//
//   task [--cli cursor|agy|claude|codex] [--write | --mode M] [--model M] [--effort E]
//        [--resume-last | --resume ID] [--background] <prompt...>
//   status [job-id]        (with an id: recent tool activity from the event log)
//   result [job-id]
//   wait <job-id> [--timeout SECONDS]  (blocks until the job ends, then prints like result; exit 2 on timeout)
//   cancel [job-id]
//   models [cursor] [agy] [claude] [codex] [--refresh]  (cached a day; what --model / --effort accept, asked live from each CLI)
//   comment <job-id> <text> (agy, claude: fed to a running job; agy runs it as the next turn,
//                            claude folds it into the current turn if one is in progress)
//
// Safe default: without --write the run is read-only (cursor: --mode ask, agy/claude: plan, codex: read-only sandbox).
// Only one --write job may run per directory at a time.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// One state dir for every host (Claude Code, Codex, ...), so all of them see the same jobs.
// Not CLAUDE_PLUGIN_DATA: shells often inherit another plugin's value.
const STATE_DIR = process.env.COMPANION_HOME || path.join(os.homedir(), ".agent-bridge");
const JOBS_DIR = path.join(STATE_DIR, "jobs");
const LAST_FILE = path.join(STATE_DIR, "last-session.json");

function die(msg) {
  process.stderr.write(`companion: ${msg}\n`);
  process.exit(1);
}

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2));
}

const withNode = (bin) => (/\.m?js$/.test(bin) ? [process.execPath, bin] : [bin]);

// Launch cursor-agent without going through cursor-agent.cmd
// (cmd -> powershell -> ps1 re-quotes %* and delayed expansion eats "!").
function cursorLauncher(env = process.env) {
  if (env.CURSOR_AGENT_BIN) return withNode(env.CURSOR_AGENT_BIN);
  if (process.platform === "win32") {
    const root = path.join(env.LOCALAPPDATA || "", "cursor-agent", "versions");
    // Same ordering as cursor-agent.ps1: YYYY.MM.DD[-HH-MM-SS]-commit, newest first.
    const key = (n) => {
      const m = n.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/);
      return m && [m[1], m[2].padStart(2, "0"), m[3].padStart(2, "0"), m[4] || "00", m[5] || "00", m[6] || "00"].join("");
    };
    const latest = (fs.existsSync(root) ? fs.readdirSync(root) : [])
      .filter(key).sort((a, b) => key(b).localeCompare(key(a)))[0];
    if (latest) return [path.join(root, latest, "node.exe"), path.join(root, latest, "index.js")];
  }
  return ["cursor-agent"];
}

// Windows installs codex as a .cmd shim; run its codex.js directly so prompts skip cmd quoting.
function codexLauncher(env = process.env) {
  if (env.CODEX_BIN) return withNode(env.CODEX_BIN);
  if (process.platform === "win32") {
    for (const d of (env.PATH ?? "").split(path.delimiter)) {
      const js = path.join(d, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(js)) return [process.execPath, js];
    }
  }
  return ["codex"];
}

// Per-CLI differences. Everything else (jobs, resume-last, output) is shared.
const CLIS = {
  cursor: {
    launcher: cursorLauncher,
    env: { CURSOR_INVOKED_AS: "cursor-agent.cmd" },
    // --trust: -p refuses untrusted directories (exit 1, no JSON).
    base: ["-p", "--trust", "--output-format", "json"],
    modes: ["ask", "plan"], // first = read-only default
    write: ["--force"],
    resume: (id) => ["--resume", id],
    effort: false,
    prompt: (p) => [p],
    parse: (o) => ({ ok: !o.is_error, text: o.result, sessionId: o.session_id }),
    // stream-json events (background jobs).
    resultOf: (ev) => (ev.type === "result" ? ev : null),
    progress: (ev) => {
      if (ev.type === "assistant") return `say: ${ev.message?.content?.map((c) => c.text).join("") ?? ""}`;
      if (ev.type !== "tool_call" || ev.subtype !== "started") return null;
      const k = Object.keys(ev.tool_call ?? {}).find((n) => n.endsWith("ToolCall"));
      return k && `tool: ${k.replace(/ToolCall$/, "")} ${JSON.stringify(ev.tool_call[k].args ?? {})}`;
    },
    // No stream-json input: follow-ups only via --resume-last after the job ends.
    inputMsg: null,
    // "id - Display Name" lines under a header. Effort is baked into the model id (-low, -high, -fast, ...).
    models: { args: ["models"], grouped: true, parse: (out) => out.split("\n").map((l) => l.match(/^(\S+) - (.+?)[\s​]*$/)).filter(Boolean).map((m) => [m[1], m[2]]) },
  },
  claude: {
    launcher: (env = process.env) => withNode(env.CLAUDE_BIN || "claude"),
    env: {},
    base: ["-p", "--output-format", "json"],
    modeFlag: "--permission-mode",
    modes: ["plan"],
    // Same reach as cursor --force / agy --dangerously-skip-permissions: edits and commands.
    write: ["--permission-mode", "bypassPermissions"],
    resume: (id) => ["--resume", id],
    effort: true,
    stream: ["--verbose"], // print mode refuses stream-json output without it
    prompt: (p) => ["--", p],
    parse: (o) => ({ ok: !o.is_error, text: o.result, sessionId: o.session_id }),
    resultOf: (ev) => (ev.type === "result" ? ev : null),
    // Messages arriving mid-turn are folded into that turn, so count what the CLI says is queued.
    turnsLeft: (ev) => ev.queued_turn_count ?? 0,
    progress: (ev) => {
      if (ev.type !== "assistant") return null;
      return (ev.message?.content ?? []).map((c) => (c.type === "tool_use" ? `tool: ${c.name} ${JSON.stringify(c.input ?? {})}`
        : c.type === "text" && c.text.trim() ? `say: ${c.text}` : null)).filter(Boolean).join(" | ") || null;
    },
    inputMsg: (t) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: t }] } })}\n`,
    // No list command, but the stream-json `initialize` control request returns what /model shows (no model call).
    models: {
      args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"hooks":{}}'],
      input: '{"type":"control_request","request_id":"1","request":{"subtype":"initialize"}}\n',
      parse: (out) => {
        const line = out.split("\n").find((l) => l.includes('"control_response"'));
        return (line ? JSON.parse(line).response?.response?.models ?? [] : []).map((m) => [m.value,
          `${m.displayName}${m.resolvedModel && m.resolvedModel !== m.value ? ` (${m.resolvedModel})` : ""} - ${m.description ?? ""}`
          + (m.supportedEffortLevels ? ` [effort ${m.supportedEffortLevels.join("|")}]` : " [no effort]"), m.resolvedModel]);
      },
    },
    efforts: "low|medium|high|xhigh|max",
  },
  agy: {
    launcher: (env = process.env) => withNode(env.AGY_BIN || "agy"),
    env: {},
    base: ["--output-format", "json", "--disable-slash-commands"],
    modes: ["plan"],
    write: ["--dangerously-skip-permissions"],
    resume: (id) => ["--conversation", id],
    effort: true,
    // -p takes the prompt as its value; the attached form survives prompts starting with "-".
    prompt: (p) => [`-p=${p}`],
    parse: (o) => ({ ok: o.status === "SUCCESS", text: o.response, sessionId: o.conversation_id }),
    resultOf: (ev) => (ev.event === "result" ? ev.result : null),
    progress: (ev) => {
      const s = ev.step_update;
      if (s?.step_type === "user_input") return "turn started";
      if (s?.step_type === "tool" && s.state === "ACTIVE") return `tool: ${s.tool_name} ${JSON.stringify(s.tool_info?.parameters ?? {})}`;
      return null;
    },
    // --input-format stream-json: each stdin line runs as the next turn after the current one ends.
    inputMsg: (t) => `${JSON.stringify({ event: "user", message: { role: "user", content: [{ type: "text", text: t }] } })}\n`,
    // "id<TAB>Display Name" lines after a "Fetching..." line.
    models: { args: ["models"], grouped: true, parse: (out) => out.split("\n").map((l) => l.trimEnd().split("\t")).filter((p) => p.length === 2).map(([id, name]) => [id, name]) },
    efforts: "low|medium|high|max",
  },
  codex: {
    launcher: codexLauncher,
    env: {},
    base: ["exec", "--json", "--skip-git-repo-check"],
    // workspace-write: edits inside cwd, commands sandboxed (no network). --write lifts the sandbox entirely.
    modes: ["read-only", "workspace-write"],
    // -c, not -s: `exec resume` has no --sandbox flag.
    modeArgs: (m) => ["-c", `sandbox_mode="${m}"`],
    write: ["--dangerously-bypass-approvals-and-sandbox"],
    resume: (id) => ["resume", id],
    effort: (e) => ["-c", `model_reasoning_effort="${e}"`],
    prompt: (p) => ["--", p],
    // --json is an event stream in the foreground too: session id, last message and outcome arrive separately.
    parseStream: (out) => {
      let ok = false, text, sessionId, err;
      for (const l of out.split("\n")) {
        let ev;
        try { ev = JSON.parse(l); } catch { continue; }
        if (ev.type === "thread.started") sessionId = ev.thread_id;
        else if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text;
        else if (ev.type === "turn.completed") ok = true;
        else if (ev.type === "turn.failed" || ev.type === "error") err = ev.error?.message ?? ev.message;
      }
      return { ok: ok && !err, text: err ?? text, sessionId };
    },
    resultOf: () => null,
    progress: (ev) => {
      const it = ev.item;
      if (ev.type === "item.completed" && it?.type === "agent_message") return `say: ${it.text}`;
      if (ev.type !== "item.started" || !it || it.type === "reasoning") return null;
      return `tool: ${it.type} ${it.command ?? it.query ?? JSON.stringify(it.changes ?? it.arguments ?? {})}`;
    },
    // No stream-json input: follow-ups only via --resume after the job ends.
    inputMsg: null,
    // Raw catalog as JSON, no model call; hidden entries are internal (review model etc.).
    models: {
      args: ["debug", "models"],
      parse: (out) => JSON.parse(out).models.filter((m) => m.visibility !== "hide").map((m) => [m.slug,
        `${m.display_name} - ${m.description} [effort ${m.supported_reasoning_levels.map((l) => l.effort).join("|")}, default ${m.default_reasoning_level}]`]),
    },
    efforts: "per model, see [effort ...]",
  },
};

export const parseModels = (cli, out) => CLIS[cli].models.parse(out);

// cursor lists every effort/thinking/fast combination as its own id (~240 lines). Fold them per base model,
// listing the exact suffixes that exist, so nothing is composed by guess.
const VARIANT = /(?:-(?:thinking|none|minimal|low|medium|high|xhigh|max|fast))+$/;
export function groupVariants(rows) {
  const groups = new Map();
  for (const [id, name] of rows) {
    const base = id.replace(VARIANT, "");
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push([id.slice(base.length) || "(none)", name]);
  }
  return [...groups].map(([base, vs]) => {
    if (vs.length === 1 && vs[0][0] === "(none)") return [base, vs[0][1]];
    const name = vs.map(([, n]) => n).sort((a, b) => a.length - b.length)[0]
      .replace(/(\s+\(?(low|medium|high|extra high|xhigh|max|fast|thinking|none|minimal)\)?)+$/i, "");
    return [base, `${name} - variants: ${vs.map(([s]) => s).join(" ")}`];
  });
}

// Names carry the version; compare it here so the reader need not. A family is the id's words without
// numbers (claude-opus-4-6 and claude-4.6-opus are both "claude opus"). Families of two or more keep the CLI's
// order, each under a "### name" header with its members newest first; one-member families follow under
// "### single". Only versions within a family are compared: names say nothing about strength or price across
// families. A third row field (an alias's resolved id) is ranked in place of the id.
const VERSION = /^([a-z]?)(\d+(?:\.\d+)*)$/;
export function rankModels(rows) {
  const fams = new Map();
  for (const row of rows) {
    const words = [], ver = [];
    for (const t of (row[2] ?? row[0]).split("-")) {
      const m = t.match(VERSION);
      if (!m) words.push(t);
      else { if (m[1]) words.push(m[1]); ver.push(...m[2].split(".").map(Number)); }
    }
    const key = [...words].sort().join(" ");
    if (!fams.has(key)) fams.set(key, []);
    fams.get(key).push({ row, ver, label: words.join(" ") });
  }
  const cmp = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (b[i] ?? -1) - (a[i] ?? -1);
    return 0;
  };
  const out = [], single = [];
  for (const ms of fams.values()) {
    if (ms.length === 1) { single.push(ms[0].row.slice(0, 2)); continue; }
    ms.sort((a, b) => cmp(a.ver, b.ver));
    const top = ms[0].ver;
    out.push([`### ${ms[0].label}`], ...ms.map(({ row: [id, name], ver }) => [id, cmp(ver, top) ? name : `[latest] ${name}`]));
  }
  return out.length && single.length ? [...out, ["### single"], ...single] : [...out, ...single];
}

// Lists what --model / --effort accept, asked live from each CLI. Lists change rarely and asking takes
// seconds, so successful answers are cached for a day; --refresh asks again.
const MODELS_CACHE = path.join(STATE_DIR, "models-cache.json");
const MODELS_TTL = 24 * 3600 * 1000;
async function cmdModels(argv) {
  const refresh = argv.includes("--refresh");
  const names = argv.filter((a) => a !== "--refresh");
  const clis = names.length ? names : Object.keys(CLIS);
  for (const cli of clis) if (!CLIS[cli]) die(`models: unknown cli ${cli}; use ${Object.keys(CLIS).join(" | ")}`);
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(MODELS_CACHE, "utf8")); } catch {}
  // CLIs not in the cache are asked in parallel: each takes seconds to tens of seconds.
  const answers = await Promise.all(clis.map((cli) => {
    const hit = !refresh && cache[cli] && Date.now() - cache[cli].at < MODELS_TTL ? cache[cli] : null;
    return hit ? { hit, parsed: hit.rows } : askModels(CLIS[cli]);
  }));
  clis.forEach((cli, i) => {
    const c = CLIS[cli], { hit, parsed, err } = answers[i];
    if (!hit && parsed.length) cache[cli] = { at: Date.now(), rows: parsed };
    const rows = rankModels(c.models.grouped ? groupVariants(parsed) : parsed);
    const effort = c.efforts ? `--effort ${c.efforts}` : "no --effort";
    const hint = c.models.grouped ? "; --model is the base id + one listed variant, (none) = base alone" : "";
    const age = hit ? `; cached ${Math.floor((Date.now() - hit.at) / 3600000)}h ago, --refresh to re-ask` : "";
    process.stdout.write(`## ${cli}  (${effort}${hint}${age})\n${err ? `error: ${err}\n` : rows.map((r) => r.join("\t")).join("\n") + "\n"}\n`);
  });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MODELS_CACHE, JSON.stringify(cache));
}

function askModels(c) {
  return new Promise((resolve) => {
    const [cmd, ...pre] = c.launcher();
    const child = spawn(cmd, [...pre, ...c.models.args], { cwd: os.tmpdir(), windowsHide: true, timeout: 90000, env: { ...c.env, ...process.env } });
    let out = "", errOut = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errOut += d; });
    child.on("error", (e) => resolve({ parsed: [], err: e.message }));
    child.on("close", (code) => {
      let parsed = [];
      try { if (code === 0) parsed = c.models.parse(out); } catch {}
      resolve({ parsed, err: !parsed.length && (errOut || out || `exited ${code}`).trim().split("\n").pop() });
    });
    child.stdin.end(c.models.input ?? "");
  });
}

const lastKey = (cli, cwd) => `${cli}:${path.resolve(cwd)}`;

export function buildArgs(cli, o, lastSession) {
  const c = CLIS[cli];
  if (!c) die(`--cli must be one of ${Object.keys(CLIS).join(", ")}, got ${cli}`);
  if (o.write && o.mode) die("--write and --mode are mutually exclusive");
  if (o.mode && !c.modes.includes(o.mode)) die(`${cli}: --mode must be ${c.modes.join(" or ")}, got ${o.mode}`);
  if (o.effort && !c.effort) die(`${cli}: --effort is not supported`);
  if (o.effort && !/^\w+$/.test(o.effort)) die(`--effort must be a single word, got ${o.effort}`);
  const mode = o.mode || c.modes[0];
  const args = [...c.base, ...(o.write ? c.write : c.modeArgs ? c.modeArgs(mode) : [c.modeFlag ?? "--mode", mode])];
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push(...(typeof c.effort === "function" ? c.effort(o.effort) : ["--effort", o.effort]));
  const resume = o.resume || (o["resume-last"] ? lastSession : undefined);
  if (o["resume-last"] && !resume) die("--resume-last: no previous session for this directory");
  if (resume) args.push(...c.resume(resume));
  return args;
}

// Runs the CLI once and returns { ok, text, sessionId }.
function runCli(cli, args, prompt, cwd) {
  const c = CLIS[cli];
  const [cmd, ...pre] = c.launcher();
  const r = spawnSync(cmd, [...pre, ...args, ...c.prompt(prompt)], {
    cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...c.env, ...process.env },
  });
  if (r.error) return { ok: false, text: `failed to launch ${cmd}: ${r.error.message}` };
  let out;
  try { out = c.parseStream ? c.parseStream(r.stdout) : c.parse(JSON.parse(r.stdout.trim().split("\n").pop())); } catch { out = null; }
  if (r.status !== 0 || !out?.ok) {
    return { ok: false, sessionId: out?.sessionId, text: [`${cli} exited ${r.status}`, r.stdout, r.stderr].filter((s) => s && s.trim()).join("\n").trim() };
  }
  return { ok: true, text: (out.text ?? "").trimEnd(), sessionId: out.sessionId };
}

function rememberSession(cli, cwd, sessionId) {
  if (!sessionId) return;
  const last = readJson(LAST_FILE, {});
  last[lastKey(cli, cwd)] = sessionId;
  writeJson(LAST_FILE, last);
}

const format = (cli, r) => `${r.text}\n${r.sessionId ? `\n[${cli} session: ${r.sessionId}]\n` : ""}`;

// Quota check before a task, from the usage plugin when it is installed next to this one (same repo or same
// plugin cache). Only warns: the user may have named the model. Silent when usage is missing or fails.
// COMPANION_USAGE overrides the script path; "off" disables the check.
const QUOTA_WARN = 80;
function usageScript() {
  if (process.env.COMPANION_USAGE) return process.env.COMPANION_USAGE === "off" ? null : process.env.COMPANION_USAGE;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.join(here, "..", "..", "usage", "scripts", "usage.mjs");
  if (fs.existsSync(repo)) return repo;
  const cache = path.join(here, "..", "..", "..", "usage"); // <cache>/<marketplace>/usage/<version>/scripts
  let vers = [];
  try { vers = fs.readdirSync(cache); } catch {}
  const num = (v) => v.split(".").map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (num(a)[i] !== num(b)[i]) return num(b)[i] - num(a)[i]; return 0; };
  const f = vers.sort(cmp).map((v) => path.join(cache, v, "scripts", "usage.mjs")).find((p) => fs.existsSync(p));
  return f ?? null;
}

// Which of a CLI's usage windows the given model draws on (see the pools in choosing-models.md).
export function poolWindows(cli, model, windows) {
  const m = (model ?? "").toLowerCase();
  const tag = (w) => w.window.match(/\(([^)]+)\)/)?.[1].toLowerCase();
  return windows.filter((w) => w.usedPercent != null && ({
    claude: () => !tag(w) || m.includes(tag(w).split(" ")[0]),
    cursor: () => w.window.includes(!m || /^(auto|composer|cursor-grok|grok)/.test(m) ? "Cursor models" : "other models"),
    agy: () => tag(w)?.startsWith(!m || m.startsWith("gemini") ? "gemini" : "claude"),
  }[cli] ?? (() => true))());
}

// Cached a few minutes: the claude check alone takes ~20s, and a burst of dispatches would repeat it.
const QUOTA_CACHE = path.join(STATE_DIR, "quota.json"), QUOTA_TTL = 5 * 60000;
export function quotaWarning(cli, model) {
  const script = usageScript();
  if (!script) return "";
  const cache = readJson(QUOTA_CACHE, {});
  let windows = Date.now() - (cache[cli]?.at ?? 0) < QUOTA_TTL ? cache[cli].windows : null;
  if (!windows) {
    const r = spawnSync(process.execPath, [script, cli, "--json"], { encoding: "utf8", timeout: 60000, windowsHide: true });
    try { windows = JSON.parse(r.stdout).services[cli].windows; } catch { return ""; }
    if (!windows) return "";
    writeJson(QUOTA_CACHE, { ...cache, [cli]: { at: Date.now(), windows } });
  }
  const hot = poolWindows(cli, model, windows).filter((w) => w.usedPercent >= QUOTA_WARN);
  return hot.map((w) => `warning: ${cli} ${w.window} is ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ""}; consider a roomier pool (usage plugin)`).join("\n");
}

function cmdTask(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      cli: { type: "string", default: "cursor" },
      write: { type: "boolean" }, mode: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
      "resume-last": { type: "boolean" }, resume: { type: "string" }, background: { type: "boolean" },
    },
  });
  const prompt = positionals.join(" ").trim();
  if (!prompt) die("task: prompt is required");
  const cwd = process.cwd();
  const args = buildArgs(o.cli, o, readJson(LAST_FILE, {})[lastKey(o.cli, cwd)]);
  const running = loadJobs().filter((j) => j.status === "running" && j.cwd === cwd);
  // LIMITATION: only background jobs are tracked, so a concurrent foreground --write is not caught.
  // A sandboxed mode that can still edit (codex workspace-write) counts as a writer too.
  const writes = !!o.write || o.mode === "workspace-write";
  const writer = writes && running.find((j) => j.write);
  if (writer) die(`job ${writer.id} (${writer.cli}) is already writing in this directory; wait for it or cancel it`);
  const sibling = o["resume-last"] && running.find((j) => j.cli === o.cli);
  if (sibling) die(`--resume-last is ambiguous while ${o.cli} job ${sibling.id} is running; pass --resume <session-id>`);
  const warn = quotaWarning(o.cli, o.model);
  if (warn) process.stderr.write(`${warn}\n`);

  if (!o.background) {
    const r = runCli(o.cli, args, prompt, cwd);
    rememberSession(o.cli, cwd, r.sessionId);
    process.stdout.write(format(o.cli, r));
    process.exit(r.ok ? 0 : 1);
  }

  const id = randomUUID().slice(0, 8);
  const job = { id, cli: o.cli, cwd, args, prompt, write: writes, status: "running", startedAt: new Date().toISOString() };
  writeJson(path.join(JOBS_DIR, `${id}.json`), job);
  const child = spawn(process.execPath, [process.argv[1], "_run", id], {
    cwd, detached: true, stdio: "ignore", windowsHide: true,
  });
  job.pid = child.pid;
  writeJson(path.join(JOBS_DIR, `${id}.json`), job);
  child.unref();
  process.stdout.write(`${o.cli} job ${id} started in background.\nCheck: status ${id} / Fetch: result ${id}\n`);
}

const jobFile = (id, ext = "json") => path.join(JOBS_DIR, `${id}.${ext}`);
const updateJob = (id, patch) => writeJson(jobFile(id), { ...readJson(jobFile(id), {}), ...patch });

// Background worker: streams events to <id>.log, feeds queued comments (agy) to stdin,
// and records the combined outcome of every turn.
function cmdRun([id]) {
  const job = readJson(jobFile(id), null);
  if (!job) die(`unknown job ${id}`);
  const c = CLIS[job.cli];
  const args = job.args.map((a, i) => (job.args[i - 1] === "--output-format" ? "stream-json" : a));
  args.push(...(c.stream ?? []));
  if (c.inputMsg) args.push("--input-format", "stream-json");
  const [cmd, ...pre] = c.launcher();
  const child = spawn(cmd, [...pre, ...args, ...(c.inputMsg ? [] : c.prompt(job.prompt))], {
    cwd: job.cwd, windowsHide: true, env: { ...c.env, ...process.env },
    stdio: [c.inputMsg ? "pipe" : "ignore", "pipe", "pipe"],
  });
  updateJob(id, { childPid: child.pid, acceptsComments: !!c.inputMsg });

  const log = fs.createWriteStream(jobFile(id, "log"));
  const results = [];
  let stderr = "", all = "", pending = 0, queueOffset = 0, poll;
  const send = (t) => { child.stdin.write(c.inputMsg(t)); pending++; };
  // Comments appended by `comment <id>` since the last poll.
  const drainQueue = () => {
    const q = jobFile(id, "queue");
    if (!fs.existsSync(q)) return;
    const lines = fs.readFileSync(q, "utf8").split("\n").slice(queueOffset, -1);
    queueOffset += lines.length;
    for (const l of lines) send(JSON.parse(l));
  };
  if (c.inputMsg) {
    send(job.prompt);
    poll = setInterval(drainQueue, 1000);
  }

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    if (c.parseStream) all += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      log.write(`${line}\n`);
      let r;
      try { r = c.resultOf(JSON.parse(line)); } catch { continue; }
      if (!r) continue;
      results.push(c.parse(r));
      pending = c.turnsLeft ? c.turnsLeft(r) : pending - 1;
      if (c.inputMsg && pending === 0) {
        drainQueue();
        // LIMITATION: a comment landing between this drain and stdin.end() is lost; `comment` checks acceptsComments to narrow the window.
        if (pending === 0) { clearInterval(poll); updateJob(id, { acceptsComments: false }); child.stdin.end(); }
      }
    }
  });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", (e) => { stderr += `failed to launch ${cmd}: ${e.message}`; });
  child.on("close", (code) => {
    clearInterval(poll);
    log.end();
    if (c.parseStream) results.push(c.parseStream(all));
    const sessionId = results.findLast((r) => r.sessionId)?.sessionId;
    rememberSession(job.cli, job.cwd, sessionId);
    const ok = code === 0 && results.length > 0 && results.every((r) => r.ok);
    const text = ok
      ? results.map((r) => (r.text ?? "").trimEnd()).join("\n\n---\n\n")
      : [`${job.cli} exited ${code}`, ...results.map((r) => r.text), stderr].filter((s) => s && s.trim()).join("\n").trim();
    updateJob(id, { status: ok ? "done" : "failed", finishedAt: new Date().toISOString(), sessionId, output: text, acceptsComments: false });
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function loadJobs() {
  const jobs = (fs.existsSync(JOBS_DIR) ? fs.readdirSync(JOBS_DIR) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(JOBS_DIR, f), null)).filter(Boolean);
  for (const j of jobs) {
    // Worker died without writing a result (killed, reboot).
    if (j.status === "running" && j.pid && !alive(j.pid)) Object.assign(j, { status: "failed", output: "worker process exited without a result" });
  }
  return jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function pickJob(id, filter = () => true) {
  const jobs = loadJobs();
  const job = id ? jobs.find((j) => j.id === id) : jobs.filter((j) => j.cwd === process.cwd()).find(filter);
  if (!job) die(id ? `unknown job ${id}` : "no matching job for this directory");
  return job;
}

// Last N human-readable progress lines from the job's event log.
function progressOf(j, n = 10) {
  const f = jobFile(j.id, "log");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").map((l) => {
    try { return CLIS[j.cli].progress(JSON.parse(l)); } catch { return null; }
  }).filter(Boolean).slice(-n).map((s) => (s.length > 160 ? `${s.slice(0, 157)}...` : s));
}

function cmdStatus([id]) {
  if (id) {
    const j = pickJob(id);
    const lines = progressOf(j).map((s) => `  ${s}`).join("\n");
    process.stdout.write(`${j.id}  ${j.cli}  ${j.status}  started ${j.startedAt}${j.finishedAt ? `  finished ${j.finishedAt}` : ""}\nprompt: ${j.prompt}\n${lines ? `recent activity:\n${lines}\n` : ""}`);
    return;
  }
  const jobs = loadJobs().filter((j) => j.cwd === process.cwd());
  if (!jobs.length) return void process.stdout.write("no jobs for this directory\n");
  for (const j of jobs) {
    const last = j.status === "running" ? progressOf(j, 1)[0] : "";
    process.stdout.write(`${j.id}  ${j.cli.padEnd(6)}  ${j.status.padEnd(9)}  ${j.startedAt}  ${j.prompt.slice(0, 50).replace(/\s+/g, " ")}${last ? `  | ${last.slice(0, 60)}` : ""}\n`);
  }
}

function cmdResult([id]) {
  const j = pickJob(id, (j) => j.status !== "running");
  if (j.status === "running") die(`job ${j.id} is still running`);
  process.stdout.write(`job ${j.id} (${j.cli}): ${j.status}\n\n${format(j.cli, { text: j.output, sessionId: j.sessionId })}`);
  if (j.status !== "done") process.exit(1);
}

// Default stays under the 10-minute cap hosts put on one shell call; call again to keep waiting.
function cmdWait(argv) {
  const { values: o, positionals: [id] } = parseArgs({ args: argv, allowPositionals: true, options: { timeout: { type: "string", default: "540" } } });
  if (!id) die("usage: wait <job-id> [--timeout SECONDS]");
  const deadline = Date.now() + Number(o.timeout) * 1000;
  while (pickJob(id).status === "running") {
    if (Date.now() >= deadline) {
      process.stdout.write(`job ${id} still running after ${o.timeout}s; run wait again or check status ${id}\n`);
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  cmdResult([id]);
}

function cmdCancel([id]) {
  const j = pickJob(id, (j) => j.status === "running");
  if (j.status !== "running") die(`job ${j.id} is not running (${j.status})`);
  // Kill the worker before the CLI so its close handler cannot overwrite "cancelled".
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(j.pid)], { stdio: "ignore" });
  else for (const pid of [j.pid, j.childPid]) { try { process.kill(pid, "SIGTERM"); } catch {} }
  updateJob(j.id, { status: "cancelled", finishedAt: new Date().toISOString(), output: "cancelled by user", acceptsComments: false });
  process.stdout.write(`job ${j.id} cancelled\n`);
}

// Feed a follow-up to a running job (agy: next turn; claude: folded into the current turn).
function cmdComment(argv) {
  // Slash commands pass "<id> <text>" as one quoted argument.
  const [id, ...words] = argv.length === 1 ? argv[0].trim().split(/\s+/) : argv;
  const text = words.join(" ").trim();
  if (!id || !text) die("usage: comment <job-id> <text>");
  const j = pickJob(id);
  if (!CLIS[j.cli].inputMsg) die(`${j.cli} cannot take comments while running; after it finishes use task --cli ${j.cli} --resume-last`);
  if (j.status !== "running" || !j.acceptsComments) die(`job ${j.id} is no longer accepting comments (${j.status}); use task --cli ${j.cli} --resume-last`);
  fs.appendFileSync(jobFile(j.id, "queue"), `${JSON.stringify(text)}\n`);
  process.stdout.write(`comment queued for job ${j.id}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [sub, ...rest] = process.argv.slice(2);
  // Slash commands pass "$ARGUMENTS" as one (possibly empty) string.
  const argv = rest.length === 1 && sub !== "task" ? rest[0].split(/\s+/).filter(Boolean) : rest;
  const handlers = { task: cmdTask, _run: cmdRun, status: cmdStatus, result: cmdResult, wait: cmdWait, cancel: cmdCancel, comment: cmdComment, models: cmdModels };
  if (!handlers[sub]) die(`usage: companion.mjs ${Object.keys(handlers).filter((h) => h !== "_run").join("|")} ...`);
  handlers[sub](argv);
}
