const port = "9222";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
function send(method, params = {}) { return new Promise((res) => { const r = ++id; pending.set(r, res); ws.send(JSON.stringify({ id: r, method, params })); }); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
async function ev(expr) {
  const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) return { ERROR: res.result.exceptionDetails.exception?.description };
  return res.result?.result?.value;
}
const cmds = process.argv.slice(2);
for (const c of cmds) {
  if (c.startsWith("!")) { console.log("EVAL:", JSON.stringify(await ev(c.slice(1)))); continue; }
  if (c.startsWith("~")) { await new Promise(r=>setTimeout(r, Number(c.slice(1)))); continue; }
  // 不 await pi 的返回：扩展命令里的 dialog 会一直阻塞到用户作答
  const r = await ev(`(window.__probe = window.piBuddy.pi.prompt({message:${JSON.stringify(c)}}).then(x=>JSON.stringify(x), e=>"ERR:"+e.message), "sent")`);
  console.log("SENT:", c, "->", r);
}
ws.close();
