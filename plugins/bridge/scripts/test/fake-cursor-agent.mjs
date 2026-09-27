// Stand-in for cursor-agent: echoes its argv back as the result.
const args = process.argv.slice(2);
const prompt = args.at(-1);
if (prompt === "FAIL") { console.error("boom"); process.exit(2); }
const i = args.indexOf("--resume");
const result = { type: "result", subtype: "success", is_error: false,
  result: JSON.stringify(args), session_id: i >= 0 ? args[i + 1] : "sess-new" };
if (args[args.indexOf("--output-format") + 1] === "stream-json") {
  console.log(JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: "a.txt" } } } }));
  // SLOW keeps the job running long enough to be cancelled.
  setTimeout(() => console.log(JSON.stringify(result)), prompt === "SLOW" ? 30000 : 200);
} else {
  console.log(JSON.stringify(result));
}
