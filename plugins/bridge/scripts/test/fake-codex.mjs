// Stand-in for codex exec --json: echoes argv back as the agent message, in codex's event stream.
const args = process.argv.slice(2);
const r = args.indexOf("resume");
const ev = (o) => console.log(JSON.stringify(o));
ev({ type: "thread.started", thread_id: r >= 0 ? args[r + 1] : "codex-new" });
ev({ type: "item.started", item: { type: "command_execution", command: "ls" } });
if (args.at(-1) === "FAIL") { ev({ type: "turn.failed", error: { message: "boom" } }); process.exit(1); }
setTimeout(() => {
  ev({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(args) } });
  ev({ type: "turn.completed", usage: {} });
}, 200);
