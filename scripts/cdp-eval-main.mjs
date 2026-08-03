/**
 * cdp-eval.mjs 的定向版：只连**主窗口**的 target。
 *
 * ART-101 之后应用里会同时存在预览窗口（沙箱、无 piBuddy）与主窗口，
 * 而 cdp-eval.mjs 取的是 `find(t => t.type === "page")` 的第一个 ——
 * 预览一开，它就打到预览窗口上去了，报一句
 * 「Cannot read properties of undefined (reading 'preview')」，
 * 看起来像是 preload 挂了，其实只是连错了窗口。
 *
 *   node scripts/cdp-eval-main.mjs "await window.piBuddy.settings.get()"
 */
const port = process.env.CDP_PORT ?? "9222";
const expression = process.argv.slice(2).join(" ");
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("out/renderer/index.html"));
if (!page) throw new Error("没有找到主窗口 target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); p(msg); }
});
const send = (method, params = {}) =>
  new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(res.result.exceptionDetails.exception, null, 1));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(res.result?.result?.value ?? res.result?.result, null, 1));
}
ws.close();
