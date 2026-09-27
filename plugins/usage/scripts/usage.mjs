#!/usr/bin/env node
// Remaining rate-limit quota for Claude Code, Codex, Cursor and Antigravity (agy). Claude and Codex are asked through
// their own CLIs; Cursor and agy through the endpoints their CLIs' usage screens use, authenticated with the tokens
// those CLIs already stored locally. No model call, so checking costs nothing.
//
//   usage.mjs [claude] [codex] [cursor] [agy] [--json]     (default: all, as a Markdown table)
//
// Claude and Codex logins are left to their CLIs (claudeViaCli / codexViaCli say what those read and call); this
// script reads them only through an optional token.mjs (see viaToken). The Cursor and agy requests carry only the
// bearer token and Node's default User-Agent, except agy's: Google rejects clients other than Antigravity
// (UNSUPPORTED_CLIENT), so those say "antigravity/<ver> <os>/<arch>".
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// A *_BIN pointing at a .mjs/.js file (the tests' fake CLIs) runs under this Node.
const withNode = (bin) => (/\.m?js$/.test(bin) ? [process.execPath, bin] : [bin]);

// Async so the sources run side by side (a sync spawn would hold every other check until it exits). Resolves stdout.
async function run(bin, args, { input, ...opts } = {}) {
  const [cmd, ...pre] = withNode(bin);
  const p = promisify(execFile)(cmd, [...pre, ...args], { encoding: "utf8", maxBuffer: 1 << 24, windowsHide: true, ...opts });
  p.child.stdin.end(input);
  return (await p).stdout;
}

// Ask the claude CLI itself. get_usage is a control request of its stream-json protocol; no user message is sent,
// so no model call. Takes ~10-25s, most of it CLI startup (a large session history in ~/.claude/projects can add
// several seconds). Where the CLI gets it (this function never touches the login): its OAuth login, claudeAiOauth in
// $CLAUDE_CONFIG_DIR/.credentials.json (default ~/.claude; on macOS the login keychain item "Claude Code-credentials"),
// sent as a bearer token to GET https://api.anthropic.com/api/oauth/usage with "anthropic-beta: oauth-2025-04-20".
// The answer's rate_limits is that endpoint's body (five_hour, seven_day, limits[] with per-model scopes).
async function claudeViaCli() {
  const out = await run(process.env.CLAUDE_BIN || "claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"hooks":{}}'],
  { input: '{"type":"control_request","request_id":"1","request":{"subtype":"get_usage"}}\n', cwd: os.tmpdir(), timeout: 90000 });
  const line = out.split("\n").find((l) => l.includes('"control_response"'));
  const r = line && JSON.parse(line).response;
  if (r?.subtype !== "success" || !r.response?.rate_limits) throw new Error(r?.error ?? "claude CLI gave no usage");
  return r.response;
}

// Mirrors the Claude app's own mapping: subscriptionType may be "max" or "claude_max". rateLimitTier (e.g.
// "default_claude_max_20x") tells 20x from 5x when the caller has it; the CLI's answer carries no tier, so through
// the CLI Max shows without its multiplier.
// LIMITATION: Enterprise standard/premium needs an org tier field neither source carries.
export function claudePlan(o) {
  const t = o.subscriptionType?.replace(/^claude_/, "");
  if (!t) return undefined;
  if (t.startsWith("max")) {
    const x = /(\d+x)$/.exec(o.rateLimitTier ?? t)?.[1];
    return x ? `Max ${x}` : "Max";
  }
  return t[0].toUpperCase() + t.slice(1);
}

// Ask `codex app-server` over JSON-RPC (account/rateLimits/read, no model call; ~3s). The server exits on stdin EOF
// but drops pending requests, so stdin closes only after the answer.
// Where it gets it (this function never touches the login): the ChatGPT login in $CODEX_HOME/auth.json (default
// ~/.codex), tokens.access_token, sent as a bearer token to GET https://chatgpt.com/backend-api/wham/usage.
// An API-key login has no plan quota. The answer is that body in camelCase; codexFromCli maps it back.
function codexViaCli() {
  return new Promise((resolve, reject) => {
    // codex is an npm .cmd shim on Windows, which needs a shell; the command line is constant.
    const [cmd, ...pre] = withNode(process.env.CODEX_BIN || "codex"), opts = { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"] };
    const p = process.platform === "win32" && !pre.length ? spawn(`"${cmd}" app-server`, { ...opts, shell: true }) : spawn(cmd, [...pre, "app-server"], opts);
    const done = (err, v) => { clearTimeout(timer); p.stdin.end(); if (err) p.kill(); err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => done(new Error("codex app-server gave no answer in 60s")), 60000);
    let buf = "";
    p.on("error", (e) => done(e));
    p.on("exit", () => done(new Error("codex app-server exited without rate limits")));
    p.stdout.on("data", (d) => {
      const lines = (buf += d).split("\n");
      buf = lines.pop();
      for (const l of lines) {
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.id !== 2) continue;
        return m.result?.rateLimits ? done(null, m.result.rateLimits) : done(new Error(m.error?.message ?? "codex app-server gave no rate limits"));
      }
    });
    p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"usage","version":"0"}}}\n'
      + '{"jsonrpc":"2.0","method":"initialized"}\n{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read"}\n');
  });
}

// app-server's camelCase rateLimits -> the wham/usage shape codexRows reads.
export function codexFromCli(r) {
  const w = (x) => x && { used_percent: x.usedPercent, limit_window_seconds: x.windowDurationMins * 60, reset_at: x.resetsAt };
  const c = r.credits;
  return { plan_type: r.planType, rate_limit: { primary_window: w(r.primary), secondary_window: w(r.secondary) },
    credits: c && { has_credits: c.hasCredits, unlimited: c.unlimited, balance: c.balance } };
}

// cursor-agent keeps its login in auth.json; the Cursor editor keeps its own in state.vscdb (SQLite), which
// covers editor-only users. Same bearer token kind either way.
async function cursorToken() {
  const cfg = process.platform === "win32" ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const f = process.platform === "win32" ? path.join(cfg, "Cursor", "auth.json")
    : process.platform === "darwin" ? path.join(os.homedir(), ".cursor", "auth.json")
    : path.join(cfg, "cursor", "auth.json");
  if (fs.existsSync(f)) {
    const t = JSON.parse(fs.readFileSync(f, "utf8")).accessToken;
    if (t) return t;
  }
  const db = path.join(cfg, "Cursor", "User", "globalStorage", "state.vscdb");
  if (!fs.existsSync(db)) throw new Error(`no ${f} or ${db}; log in to Cursor or cursor-agent first`);
  const { DatabaseSync } = await import("node:sqlite"); // Node >= 22.5
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    const t = conn.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get()?.value;
    if (!t) throw new Error("no cursorAuth/accessToken in Cursor state.vscdb; log in to Cursor first");
    return String(t);
  } finally { conn.close(); }
}

// agy keeps its live login in the OS keyring (go-keyring service "gemini", user "antigravity");
// ~/.gemini/antigravity-cli/antigravity-oauth-token is only its fallback when no keyring exists.
// The access token lives ~1h and agy refreshes it only while running.
async function agyLogin() {
  let raw;
  if (process.platform === "win32") {
    // Windows Credential Manager generic credential "gemini:antigravity", UTF-8 JSON blob.
    const ps = "Add-Type 'using System;using System.Runtime.InteropServices;public static class Cred{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct C{public int Flags,Type;public string Target,Comment;public long Written;public int BlobSize;public IntPtr Blob;public int Persist,AttrCount;public IntPtr Attrs;public string Alias,User;}[DllImport(\"advapi32\",CharSet=CharSet.Unicode)]static extern bool CredReadW(string t,int y,int f,out IntPtr p);public static string Read(string t){IntPtr p;if(!CredReadW(t,1,0,out p))return \"\";var c=(C)Marshal.PtrToStructure(p,typeof(C));var b=new byte[c.BlobSize];Marshal.Copy(c.Blob,b,0,c.BlobSize);return Convert.ToBase64String(b);}}';[Cred]::Read('gemini:antigravity')";
    const b64 = (await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps])).trim();
    if (b64) raw = Buffer.from(b64, "base64").toString("utf8");
  } else if (process.platform === "darwin") {
    try { raw = (await run("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"])).trim(); } catch {}
    if (raw?.startsWith("go-keyring-base64:")) raw = Buffer.from(raw.slice(18), "base64").toString("utf8");
  }
  // LIMITATION: Linux Secret Service (libsecret) not read; only the file fallback. Add via secret-tool if needed.
  const f = path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  if (!raw && fs.existsSync(f)) raw = fs.readFileSync(f, "utf8");
  if (!raw) throw new Error("no agy login found; log in with agy first");
  return JSON.parse(raw).token ?? {};
}

const expired = (t) => t.expiry && Date.now() >= Date.parse(t.expiry);

async function agyToken() {
  let t = await agyLogin();
  if (expired(t)) {
    // Any agy command refreshes the keyring token; `agy models` is the cheapest (no model call).
    try { await run(process.env.AGY_BIN || "agy", ["models"], { timeout: 60000 }); } catch {}
    t = await agyLogin();
    if (expired(t)) throw new Error("agy token expired and agy models did not refresh it; run agy once");
  }
  if (!t.access_token) throw new Error("no access_token in agy login");
  return t.access_token;
}

// Proxies: only via NODE_USE_ENV_PROXY=1 + HTTPS_PROXY (README).
async function getJson(url, token, body, extra) {
  const headers = { Authorization: `Bearer ${token}`, ...extra, ...(body && { "Content-Type": "application/json" }) };
  const r = await fetch(url, { method: body ? "POST" : "GET", headers, body, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Rows: { window, used (percent 0-100), resetsAt (Date) }.
export function claudeRows(d) {
  const label = (l) => {
    const base = l.kind === "session" ? "5h session" : l.kind?.startsWith("weekly") ? "7d week" : (l.group ?? l.kind);
    const model = l.scope?.model?.display_name;
    return model ? `${base} (${model})` : base;
  };
  if (d.limits?.length) return d.limits.map((l) => ({ window: label(l), used: l.percent, resetsAt: l.resets_at && new Date(l.resets_at) }));
  return [["5h session", d.five_hour], ["7d week", d.seven_day]].filter(([, b]) => b)
    .map(([window, b]) => ({ window, used: b.utilization, resetsAt: b.resets_at && new Date(b.resets_at) }));
}

export function codexRows(d) {
  const win = (w) => (w.limit_window_seconds === 18000 ? "5h session" : w.limit_window_seconds === 604800 ? "7d week" : `${Math.round(w.limit_window_seconds / 3600)}h`);
  const rows = [d.rate_limit?.primary_window, d.rate_limit?.secondary_window].filter(Boolean)
    .map((w) => ({ window: win(w), used: w.used_percent, resetsAt: w.reset_at && new Date(w.reset_at * 1000) }));
  const c = d.credits;
  if (c?.has_credits || c?.unlimited) rows.push({ window: "credits", used: null, note: c.unlimited ? "unlimited" : `balance ${c.balance}` });
  return rows;
}

// Cursor meters spend per billing month, not rolling windows. Two pools, named as on the dashboard:
// "Cursor models" (Auto, Composer, Grok: autoPercentUsed) and "other models" (third-party at API prices:
// apiPercentUsed). total is the combined gauge, not their sum; it can look fine while one pool is nearly out.
export function cursorRows(d) {
  const p = d.planUsage ?? {};
  const resetsAt = d.billingCycleEnd && new Date(Number(d.billingCycleEnd));
  return [["month total", p.totalPercentUsed], ["month Cursor models", p.autoPercentUsed], ["month other models", p.apiPercentUsed]]
    .filter(([, v]) => v != null).map(([window, used]) => ({ window, used, resetsAt }));
}

// Antigravity: per model group (Gemini / Claude+GPT), a 5-hour and a weekly window, as fraction remaining.
export function agyRows(d) {
  const win = (w) => (w === "5h" ? "5h session" : w === "weekly" ? "7d week" : w);
  return (d.groups ?? []).flatMap((g) => (g.buckets ?? []).map((b) => ({
    window: `${win(b.window)} (${g.displayName})`,
    used: b.remainingFraction == null ? null : (1 - b.remainingFraction) * 100,
    resetsAt: b.resetTime && new Date(b.resetTime),
  })));
}

const pad = (n) => String(n).padStart(2, "0");
export function fmtReset(t, now = new Date()) {
  if (!t) return "";
  const mins = Math.max(0, Math.round((t - now) / 60000));
  const left = mins >= 1440 ? `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h` : `${Math.floor(mins / 60)}h${pad(mins % 60)}m`;
  return `${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())} (in ${left})`;
}

// A token.mjs placed next to this file may return the same data by calling the endpoints named above with the
// CLIs' stored logins (~2s instead of the CLI's 3-25s). None ships here; without one, or when it fails, the CLI answers.
async function viaToken(name) {
  try { return await (await import("./token.mjs"))[name]({ getJson, run }); } catch { return null; }
}

const SOURCES = {
  claude: async () => {
    const u = await viaToken("claude") ?? await claudeViaCli();
    return claudeRows(u.rate_limits).map((r) => ({ ...r, plan: claudePlan({ subscriptionType: u.subscription_type, rateLimitTier: u.rate_limit_tier }) }));
  },
  codex: async () => {
    const d = await viaToken("codex") ?? codexFromCli(await codexViaCli());
    return codexRows(d).map((r) => ({ ...r, plan: d.plan_type }));
  },
  cursor: async () => {
    const t = await cursorToken();
    const [d, prof] = await Promise.all([
      getJson("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", t, "{}"),
      getJson("https://api2.cursor.sh/auth/full_stripe_profile", t).catch(() => ({})), // plan label only; usage still shows without it
    ]);
    return cursorRows(d).map((r) => ({ ...r, plan: prof.membershipType }));
  },
  agy: async () => {
    const token = await agyToken();
    // LIMITATION: version pinned to the agy tested (1.2.11); bump if Google starts rejecting it.
    const ua = `antigravity/1.2.11 ${process.platform === "win32" ? "windows" : process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`;
    // The daily host is the one agy itself calls. The prod cloudcode-pa host answers the same request
    // with placeholders (remainingFraction 1, reset = now + window), so usage would always read 0%.
    const base = "https://daily-cloudcode-pa.googleapis.com/v1internal:";
    const lca = await getJson(`${base}loadCodeAssist`, token, JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }), { "User-Agent": ua });
    const p = lca.cloudaicompanionProject;
    const project = typeof p === "string" ? p : p?.id;
    if (!project) throw new Error("agy account has no Code Assist project (loadCodeAssist)");
    const d = await getJson(`${base}retrieveUserQuotaSummary`, token, JSON.stringify({ project }), { "User-Agent": ua });
    return agyRows(d).map((r) => ({ ...r, plan: lca.paidTier?.name ?? lca.currentTier?.name }));
  },
};

// For scripts: raw numbers and ISO-8601 UTC times instead of the table's rounded, local-time text.
export function jsonReport(names, results, now = new Date()) {
  return {
    checkedAt: now.toISOString(),
    services: Object.fromEntries(results.map((r, i) => [names[i], r.status === "rejected" ? { error: r.reason.message } : {
      plan: r.value[0]?.plan ?? null,
      windows: r.value.map((row) => ({
        window: row.window,
        usedPercent: row.used ?? null,
        remainingPercent: row.used == null ? null : Math.max(0, 100 - row.used),
        resetsAt: row.resetsAt ? row.resetsAt.toISOString() : null,
        ...(row.note && { note: row.note }),
      })),
    }])),
  };
}

async function main(names) {
  const json = names.includes("--json");
  names = names.filter((n) => n !== "--json");
  const picked = names.length ? names : Object.keys(SOURCES);
  const bad = picked.find((n) => !SOURCES[n]);
  if (bad) { console.error(`usage.mjs: unknown source ${bad}; use ${Object.keys(SOURCES).join(" | ")} [--json]`); process.exit(1); }
  // Independent: one failing source still reports the other.
  const results = await Promise.allSettled(picked.map((n) => SOURCES[n]()));
  if (json) {
    console.log(JSON.stringify(jsonReport(picked, results), null, 2));
    process.exit(results.some((r) => r.status === "rejected") ? 1 : 0);
  }
  const lines = ["| service | window | used | remaining | resets |", "|---|---|---:|---:|---|"];
  let failed = false;
  results.forEach((r, i) => {
    const name = picked[i];
    if (r.status === "rejected") { failed = true; lines.push(`| ${name} | error | | | ${r.reason.message.replace(/\|/g, "/")} |`); return; }
    for (const row of r.value) {
      const used = row.used == null ? "" : `${Math.round(row.used)}%`;
      const left = row.used == null ? (row.note ?? "") : `${Math.max(0, 100 - Math.round(row.used))}%`;
      lines.push(`| ${name}${row.plan ? ` (${row.plan})` : ""} | ${row.window} | ${used} | ${left} | ${fmtReset(row.resetsAt)} |`);
    }
  });
  console.log(`${lines.join("\n")}\n\nchecked ${fmtReset(new Date()).split(" (")[0]}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
