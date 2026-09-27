// Stands in for `claude -p --input-format stream-json`: answers the get_usage control request after a delay.
import fs from "node:fs";
const log = (ev) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, `claude ${ev} ${Date.now()}\n`);
log("start");
process.stdin.resume();
setTimeout(() => {
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "1", response: {
    subscription_type: "max", rate_limits: { limits: [{ kind: "session", percent: 42, resets_at: "2026-06-25T09:50:00Z" }] },
  } } }));
  log("end");
  process.exit(0);
}, Number(process.env.FAKE_DELAY_MS ?? 0));
