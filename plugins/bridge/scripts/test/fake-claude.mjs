// Stand-in for claude -p: echoes argv (or the stream-json input) back in claude's result shape.
import readline from "node:readline";

const args = process.argv.slice(2);
const i = args.indexOf("--resume");
const result = (text) => ({ type: "result", subtype: "success", is_error: false, result: text,
  session_id: i >= 0 ? args[i + 1] : "claude-new", queued_turn_count: 0 });

if (args.includes("--input-format")) {
  // Like the real CLI, messages arriving during a turn are folded into it; one arriving
  // while idle starts a new turn. Each turn takes ~5s.
  let turn = null;
  readline.createInterface({ input: process.stdin }).on("line", (l) => {
    const text = JSON.parse(l).message.content[0].text;
    if (turn) return void turn.push(text);
    turn = [text];
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.txt" } }] } }));
    setTimeout(() => { console.log(JSON.stringify(result(`seen: ${turn.join(" + ")}`))); turn = null; }, 5000);
  });
} else {
  console.log(JSON.stringify(result(JSON.stringify(args))));
}
