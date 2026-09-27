// Run: node plugins/usage/scripts/test/usage.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agyRows, claudePlan, claudeRows, codexFromCli, codexRows, cursorRows, fmtReset, jsonReport } from "../usage.mjs";

// Claude: `limits` wins (carries per-model scopes); buckets are the fallback.
const limits = claudeRows({ five_hour: { utilization: 1 }, limits: [
  { kind: "session", percent: 42, resets_at: "2026-06-25T09:50:00Z" },
  { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "Opus" } } },
] });
assert.deepEqual(limits.map((r) => [r.window, r.used]), [["5h session", 42], ["7d week (Opus)", 10]]);
assert.deepEqual(claudeRows({ five_hour: { utilization: 42 }, seven_day: { utilization: 63 }, limits: [] }).map((r) => r.used), [42, 63]);

assert.equal(claudePlan({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" }), "Max 5x");
assert.equal(claudePlan({ subscriptionType: "claude_max", rateLimitTier: "default_claude_max_20x" }), "Max 20x");
assert.equal(claudePlan({ subscriptionType: "max" }), "Max"); // CLI reports no tier
assert.equal(claudePlan({ subscriptionType: "pro", rateLimitTier: "default_claude_ai" }), "Pro");
assert.equal(claudePlan({ subscriptionType: "enterprise" }), "Enterprise");
assert.equal(claudePlan({}), undefined);

// Codex: windows by length, epoch seconds, credits only when present.
const cx = codexRows({ rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: 1782402328 },
  secondary_window: { used_percent: 3, limit_window_seconds: 604800 } }, credits: { has_credits: true, balance: "5" } });
assert.deepEqual(cx.map((r) => r.window), ["5h session", "7d week", "credits"]);
assert.equal(cx[0].resetsAt.getTime(), 1782402328000);
assert.equal(cx[2].note, "balance 5");
// app-server fallback maps onto the same rows.
const cli = codexFromCli({ planType: "plus", primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1782402328 },
  secondary: { usedPercent: 3, windowDurationMins: 10080 }, credits: { hasCredits: false, unlimited: false, balance: 0 } });
assert.equal(cli.plan_type, "plus");
assert.deepEqual(codexRows(cli).map((r) => [r.window, r.used]), [["5h session", 7], ["7d week", 3]]);
assert.equal(codexRows(cli)[0].resetsAt.getTime(), 1782402328000);

// Cursor: monthly pools, reset at billing cycle end (ms as a string).
const cu = cursorRows({ billingCycleEnd: "1790823601000", planUsage: { totalPercentUsed: 27.2, apiPercentUsed: 69 } });
assert.deepEqual(cu.map((r) => [r.window, r.used]), [["month total", 27.2], ["month other models", 69]]);
assert.equal(cu[0].resetsAt.getTime(), 1790823601000);

// Antigravity: group x window, fraction remaining -> percent used.
const ag = agyRows({ groups: [{ displayName: "Gemini Models", buckets: [
  { window: "weekly", resetTime: "2026-10-03T16:21:36Z", remainingFraction: 0.75 }, { window: "5h", remainingFraction: 1 }] }] });
assert.deepEqual(ag.map((r) => [r.window, r.used]), [["7d week (Gemini Models)", 25], ["5h session (Gemini Models)", 0]]);
assert.equal(ag[0].resetsAt.toISOString(), "2026-10-03T16:21:36.000Z");

// --json: raw numbers, ISO times, per-service error.
const js = jsonReport(["codex", "agy"], [{ status: "fulfilled", value: [{ ...cx[0], plan: "plus" }, cx[2]] },
  { status: "rejected", reason: new Error("no login") }], new Date("2026-01-01T00:00:00Z"));
assert.equal(js.checkedAt, "2026-01-01T00:00:00.000Z");
assert.equal(js.services.codex.plan, "plus");
assert.deepEqual(js.services.codex.windows[0], { window: "5h session", usedPercent: 7, remainingPercent: 93, resetsAt: "2026-06-25T15:45:28.000Z" });
assert.deepEqual(js.services.codex.windows[1], { window: "credits", usedPercent: null, remainingPercent: null, resetsAt: null, note: "balance 5" });
assert.deepEqual(js.services.agy, { error: "no login" });

const now = new Date(2026, 0, 1, 10, 0);
assert.match(fmtReset(new Date(2026, 0, 1, 12, 5), now), /1\/1 12:05 \(in 2h05m\)/);
assert.match(fmtReset(new Date(2026, 0, 3, 13, 0), now), /in 2d3h/);

// End to end through fake CLIs. Empty config dirs leave no login to read, so the CLIs answer even when a token.mjs
// (see viaToken in usage.mjs) is present. The fakes log when they start and
// answer; overlapping lifetimes show the sources run side by side (one after the other, they could not overlap).
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeLog = path.join(empty, "fake.log");
const r = spawnSync(process.execPath, [path.join(here, "..", "usage.mjs"), "claude", "codex", "--json"], { encoding: "utf8", env: {
  ...process.env, CLAUDE_CONFIG_DIR: empty, CODEX_HOME: empty, FAKE_DELAY_MS: "1500", FAKE_LOG: fakeLog,
  CLAUDE_BIN: path.join(here, "fake-claude.mjs"), CODEX_BIN: path.join(here, "fake-codex.mjs"),
} });
const at = Object.fromEntries(fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => { const [cli, ev, t] = l.split(" "); return [`${cli} ${ev}`, Number(t)]; }));
fs.rmSync(empty, { recursive: true, force: true });
const svc = JSON.parse(r.stdout).services;
assert.deepEqual(svc.claude, { plan: "Max", windows: [{ window: "5h session", usedPercent: 42, remainingPercent: 58, resetsAt: "2026-06-25T09:50:00.000Z" }] });
assert.deepEqual(svc.codex, { plan: "plus", windows: [{ window: "5h session", usedPercent: 7, remainingPercent: 93, resetsAt: "2026-06-25T15:45:28.000Z" }] });
assert.ok(at["claude start"] < at["codex end"] && at["codex start"] < at["claude end"], `claude and codex ran one after the other: ${JSON.stringify(at)}`);
console.log("ok");
