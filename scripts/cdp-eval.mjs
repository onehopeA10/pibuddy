/**
 * 极简 CDP 客户端：连上 Electron 渲染进程的调试端口，执行一段表达式并打印结果。
 *
 * 用途是给 TASK-006 的 [UI-observable] 收敛条件留下**可复核的证据**，
 * 而不是靠一句「我看过了，没问题」。
 *
 *   node scripts/cdp-eval.mjs "document.querySelectorAll('.session-item').length"
 */
const port = process.env.CDP_PORT ?? "9222";
const expression = process.argv.slice(2).join(" ");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("没有找到渲染进程 target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    p(msg);
  }
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const reqId = ++id;
    pending.set(reqId, resolve);
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
}

await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const res = await send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
if (res.result?.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(res.result.exceptionDetails.exception, null, 1));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(res.result?.result?.value ?? res.result?.result, null, 1));
}
ws.close();
