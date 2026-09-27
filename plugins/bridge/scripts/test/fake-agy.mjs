// Stand-in for agy: echoes its argv (or each stream-json turn) back in agy's JSON shape.
import readline from "node:readline";

const args = process.argv.slice(2);
const i = args.indexOf("--conversation");
const conv = i >= 0 ? args[i + 1] : "conv-new";

if (args.includes("--input-format")) {
  // One turn per stdin line, run sequentially like the real CLI; each takes ~1.5s.
  const lines = [];
  let busy = false, closed = false;
  const next = () => {
    if (busy) return;
    const line = lines.shift();
    if (line === undefined) { if (closed) process.exit(0); return; }
    busy = true;
    const text = JSON.parse(line).message.content[0].text;
    console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "user_input", state: "DONE" } }));
    console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "a.txt" } } } }));
    setTimeout(() => {
      console.log(JSON.stringify({ event: "result", result: { conversation_id: conv, status: "SUCCESS", response: `turn: ${text}\n` } }));
      busy = false;
      next();
    }, 1500);
  };
  readline.createInterface({ input: process.stdin })
    .on("line", (l) => { lines.push(l); next(); })
    .on("close", () => { closed = true; next(); });
} else {
  if (args.at(-1) === "-p=FAIL") { console.log(JSON.stringify({ status: "ERROR", response: "nope" })); process.exit(0); }
  console.log(JSON.stringify({ conversation_id: conv, status: "SUCCESS", response: JSON.stringify(args) + "\n" }));
}
