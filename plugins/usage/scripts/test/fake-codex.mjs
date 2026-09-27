// Stands in for `codex app-server`: answers account/rateLimits/read (JSON-RPC id 2) after a delay, exits on stdin EOF.
import fs from "node:fs";
const log = (ev) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, `codex ${ev} ${Date.now()}\n`);
log("start");
let buf = "";
process.stdin.on("data", (d) => {
  const lines = (buf += d).split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (JSON.parse(l).id !== 2) continue;
    setTimeout(() => {
      log("end");
      console.log(JSON.stringify({ id: 2, result: { rateLimits: {
        planType: "plus", primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1782402328 },
      } } }));
    }, Number(process.env.FAKE_DELAY_MS ?? 0));
  }
});
process.stdin.on("end", () => process.exit(0));
