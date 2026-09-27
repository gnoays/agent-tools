// Run: node plugins/bridge/scripts/test/companion.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const companion = path.join(here, "..", "companion.mjs");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
const env = { ...process.env, COMPANION_HOME: home,
  CURSOR_AGENT_BIN: path.join(here, "fake-cursor-agent.mjs"), AGY_BIN: path.join(here, "fake-agy.mjs"),
  CLAUDE_BIN: path.join(here, "fake-claude.mjs"), CODEX_BIN: path.join(here, "fake-codex.mjs"),
  COMPANION_USAGE: path.join(home, "fake-usage.mjs") };
// Stand-in for the usage plugin: cursor's other-models pool is nearly out, its own pool is not.
fs.writeFileSync(env.COMPANION_USAGE, `console.log(JSON.stringify({ services: { cursor: { windows: [
  { window: "month Cursor models", usedPercent: 15 }, { window: "month other models", usedPercent: 84, resetsAt: "2026-10-01T00:00:00Z" }] } } }));`);
const run = (...a) => spawnSync(process.execPath, [companion, ...a], { cwd: home, env, encoding: "utf8" });
const argsOf = (stdout) => JSON.parse(stdout.split("\n")[0]);

// cursor: default is read-only, always trusted; "!" survives.
let r = run("task", "hi there!");
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(argsOf(r.stdout), ["-p", "--trust", "--output-format", "json", "--mode", "ask", "hi there!"]);
assert.match(r.stdout, /\[cursor session: sess-new\]/);

// --write maps to --force; --mode plan passes through; conflict and unsupported flags rejected.
assert.ok(argsOf(run("task", "--write", "x").stdout).includes("--force"));
assert.ok(!argsOf(run("task", "--write", "x").stdout).includes("--mode"));
assert.deepEqual(argsOf(run("task", "--mode", "plan", "x").stdout).slice(4, 6), ["--mode", "plan"]);
assert.equal(run("task", "--write", "--mode", "ask", "x").status, 1);
assert.equal(run("task", "--effort", "high", "x").status, 1);

// --resume-last reuses the session recorded for this cli + cwd.
assert.deepEqual(argsOf(run("task", "--resume-last", "more").stdout).slice(-3), ["--resume", "sess-new", "more"]);

// Failure is surfaced with exit 1.
r = run("task", "FAIL");
assert.equal(r.status, 1);
assert.match(r.stdout, /boom/);

// agy: read-only default is plan, prompt attached to -p, a leading "-" survives.
r = run("task", "--cli", "agy", "--", "-dash prompt");
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(argsOf(r.stdout), ["--output-format", "json", "--disable-slash-commands", "--mode", "plan", "-p=-dash prompt"]);
assert.match(r.stdout, /\[agy session: conv-new\]/);
assert.ok(argsOf(run("task", "--cli", "agy", "--write", "x").stdout).includes("--dangerously-skip-permissions"));
assert.deepEqual(argsOf(run("task", "--cli", "agy", "--effort", "high", "x").stdout).slice(5, 7), ["--effort", "high"]);
assert.equal(run("task", "--cli", "agy", "--mode", "ask", "x").status, 1);
// resume-last is per cli: agy gets its own conversation, not cursor's session.
assert.deepEqual(argsOf(run("task", "--cli", "agy", "--resume-last", "more").stdout).slice(-3), ["--conversation", "conv-new", "-p=more"]);
r = run("task", "--cli", "agy", "FAIL");
assert.equal(r.status, 1);
assert.match(r.stdout, /ERROR/);

// claude: plan by default, "--" guards the prompt, write bypasses permissions.
r = run("task", "--cli", "claude", "--effort", "high", "--", "-x");
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(argsOf(r.stdout), ["-p", "--output-format", "json", "--permission-mode", "plan", "--effort", "high", "--", "-x"]);
assert.match(r.stdout, /\[claude session: claude-new\]/);
assert.ok(argsOf(run("task", "--cli", "claude", "--write", "x").stdout).includes("bypassPermissions"));

// codex: read-only sandbox via -c (resume has no -s), effort via -c, resume is a subcommand, events parsed from the stream.
r = run("task", "--cli", "codex", "--effort", "high", "--", "-x");
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(argsOf(r.stdout), ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-c", 'model_reasoning_effort="high"', "--", "-x"]);
assert.match(r.stdout, /\[codex session: codex-new\]/);
assert.deepEqual(argsOf(run("task", "--cli", "codex", "--write", "--resume-last", "y").stdout).slice(3),
  ["--dangerously-bypass-approvals-and-sandbox", "resume", "codex-new", "--", "y"]);
assert.equal(run("task", "--cli", "codex", "--effort", 'x" y', "z").status, 1);
assert.deepEqual(argsOf(run("task", "--cli", "codex", "--mode", "workspace-write", "z").stdout).slice(3, 5), ["-c", 'sandbox_mode="workspace-write"']);
r = run("task", "--cli", "codex", "FAIL");
assert.equal(r.status, 1);
assert.match(r.stdout, /boom/);

// models: each CLI's list format, zero-width padding stripped; claude answers the initialize control request.
const { parseModels } = await import("../companion.mjs");
assert.deepEqual(parseModels("cursor", "Available models\n\nauto - Auto (default)\ngrok-4.7-low-fast - Grok 4.7  Low Fast​​\n"),
  [["auto", "Auto (default)"], ["grok-4.7-low-fast", "Grok 4.7  Low Fast"]]);
assert.deepEqual(parseModels("agy", "Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\r\n"), [["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"]]);
assert.deepEqual(parseModels("claude", `{"type":"system"}\n${JSON.stringify({ type: "control_response", response: { response: { models: [
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable", supportedEffortLevels: ["low", "max"] },
  { value: "haiku", resolvedModel: "haiku", displayName: "Haiku 4.5", description: "Fastest" }] } } })}\n`),
[["opus", "Opus 5.5 (claude-opus-5-5) - Most capable [effort low|max]", "claude-opus-5-5"], ["haiku", "Haiku 4.5 - Fastest [no effort]", "haiku"]]);
assert.deepEqual(parseModels("codex", JSON.stringify({ models: [
  { slug: "gpt-x", display_name: "GPT-X", description: "Workhorse.", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
  { slug: "internal", visibility: "hide" }] })), [["gpt-x", "GPT-X - Workhorse. [effort low|high, default medium]"]]);
// cursor: variants fold per base model, suffixes listed exactly; a lone base id stays as-is.
const { groupVariants } = await import("../companion.mjs");
assert.deepEqual(groupVariants([["auto", "Auto (default)"], ["gpt-5.3-codex", "Codex 5.3"], ["gpt-5.3-codex-low-fast", "Codex 5.3 Low Fast"],
  ["claude-opus-5-thinking-high", "Claude Opus 5 Thinking High"], ["claude-opus-5-low", "Claude Opus 5 Low"]]), [
  ["auto", "Auto (default)"], ["gpt-5.3-codex", "Codex 5.3 - variants: (none) -low-fast"],
  ["claude-opus-5", "Claude Opus 5 - variants: -thinking-high -low"]]);
// rank: family = words without numbers (either word order), numeric version compare (5.10 > 5.9),
// aliases ranked by their resolved id, ties both latest, one-member families last under "single".
const { rankModels } = await import("../companion.mjs");
assert.deepEqual(rankModels([["auto", "A"], ["gpt-5.9", "G9"], ["claude-4.6-opus", "O46"], ["gpt-5.10", "G10"],
  ["opus", "Op", "claude-opus-5-5"], ["claude-opus-5-5", "O55"], ["gpt-5.10-mini", "M"]]), [
  ["### gpt"], ["gpt-5.10", "[latest] G10"], ["gpt-5.9", "G9"],
  ["### claude opus"], ["opus", "[latest] Op"], ["claude-opus-5-5", "[latest] O55"], ["claude-4.6-opus", "O46"],
  ["### single"], ["auto", "A"], ["gpt-5.10-mini", "M"]]);
assert.equal(run("models", "nope").status, 1);
// models: a fresh cache answers without asking the CLI; --refresh would ask again.
fs.writeFileSync(path.join(home, "models-cache.json"), JSON.stringify({ codex: { at: Date.now(), rows: [["gpt-x", "X"]] } }));
assert.match(run("models", "codex").stdout, /cached 0h ago[^]*gpt-x\tX/);

const sleep = (ms) => spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const startJob = (...a) => run("task", "--background", ...a).stdout.match(/job (\w+) started/)[1];
function waitFor(id, re, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const out = run("status", id).stdout;
    if (re.test(out)) return out;
    assert.ok(Date.now() < deadline, `job ${id} never matched ${re}: ${out}`);
    sleep(200);
  }
}

// cursor background: progress from stream-json, then result.
let id = startJob("--", "bg cursor");
let st = waitFor(id, /done|failed/);
assert.match(st, /tool: read \{"path":"a.txt"\}/);
r = run("result", id);
assert.equal(r.status, 0, r.stdout + r.stderr);
assert.match(r.stdout, /job \w+ \(cursor\): done/);
assert.match(r.stdout, /bg cursor/);
assert.match(run("status", "").stdout, new RegExp(id));
assert.equal(run("comment", id, "more").status, 1); // cursor takes no comments

// agy background with a queued comment: both turns run in one process.
id = startJob("--cli", "agy", "--", "first");
// One argument, as the /comment slash command passes "$ARGUMENTS".
for (const deadline = Date.now() + 10000; run("comment", `${id} second turn`).status !== 0; sleep(100)) {
  assert.ok(Date.now() < deadline, "comment never accepted");
}
st = waitFor(id, /done|failed/);
assert.match(st, /turn started/);
assert.match(st, /tool: view_file/);
r = run("result", id);
assert.equal(r.status, 0, r.stdout + r.stderr);
assert.match(r.stdout, /turn: first\n\n---\n\nturn: second turn/);
assert.match(r.stdout, /\[agy session: conv-new\]/);
assert.equal(run("comment", id, "late").status, 1); // finished jobs reject comments

// claude background: a mid-turn comment folds into the same turn; wait returns the result.
id = startJob("--cli", "claude", "--", "first");
waitFor(id, /tool: Read/);
r = run("comment", id, "extra");
assert.equal(r.status, 0, r.stdout + r.stderr);
r = run("wait", id);
assert.equal(r.status, 0, r.stdout + r.stderr);
assert.match(r.stdout, /seen: first \+ extra/);

// codex background: result assembled from the event stream, command shown as progress.
id = startJob("--cli", "codex", "--", "bg codex");
st = waitFor(id, /done|failed/);
assert.match(st, /tool: command_execution ls/);
r = run("result", id);
assert.equal(r.status, 0, r.stdout + r.stderr);
assert.match(r.stdout, /bg codex/);
assert.match(r.stdout, /\[codex session: codex-new\]/);

// cancel: a slow job stops and stays cancelled. While it runs (as a writer),
// a second --write and an ambiguous --resume-last are refused, and wait times out.
id = startJob("--write", "--", "SLOW");
waitFor(id, /tool: read/);
assert.match(run("task", "--cli", "agy", "--write", "x").stderr, /already writing/);
assert.match(run("task", "--resume-last", "x").stderr, /ambiguous/);
assert.equal(run("wait", id, "--timeout", "1").status, 2);
r = run("cancel", id);
assert.equal(r.status, 0, r.stderr);
sleep(500);
assert.match(run("status", id).stdout, /cancelled/);
assert.equal(run("result", id).status, 1);

// quota: warn only when the chosen model's pool is nearly out.
assert.doesNotMatch(run("task", "--model", "composer-2.5", "hi").stderr, /warning/);
assert.match(run("task", "--model", "gpt-5.5-medium", "hi").stderr, /warning: cursor month other models is 84% used, resets 2026-10-01/);
const { poolWindows } = await import("../companion.mjs");
const agyW = [{ window: "5h session (Gemini Models)", usedPercent: 1 }, { window: "5h session (Claude and GPT models)", usedPercent: 2 }];
assert.deepEqual(poolWindows("agy", undefined, agyW), [agyW[0]]);
assert.deepEqual(poolWindows("agy", "claude-opus-4-6-thinking", agyW), [agyW[1]]);
const clW = [{ window: "7d week", usedPercent: 1 }, { window: "7d week (Fable)", usedPercent: 2 }];
assert.deepEqual(poolWindows("claude", "opus", clW), [clW[0]]);
assert.deepEqual(poolWindows("claude", "claude-fable-5-1", clW), clW);

fs.rmSync(home, { recursive: true, force: true });
console.log("ok");
