/**
 * 通过 CDP 的 Input.dispatchDragEvent 往渲染进程投一个**带真实 OS 路径**的文件拖拽。
 *
 * 合成 DragEvent 做不到这件事：webUtils.getPathForFile 对 JS 里 new 出来的 File
 * 只会返回空串，附件条目因此加不进去。
 *
 *   node scripts/cdp-drop-file.mjs "D:\\path\\to\\note.txt"
 */
const port = process.env.CDP_PORT ?? "9222";
const filePath = process.argv[2];

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
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

// 没有 dragover 的 preventDefault，Chromium 根本不会把 drop 派发给页面。
await send("Runtime.evaluate", {
  expression:
    "window.__dropProbe || (window.__dropProbe = (window.addEventListener('dragover', function(e){e.preventDefault();}), 1))",
});

const data = { items: [], files: [filePath], dragOperationsMask: 1 };
for (const type of ["dragEnter", "dragOver", "drop"]) {
  const r = await send("Input.dispatchDragEvent", { type, x: 600, y: 700, data });
  if (r.error) console.error(type, r.error);
}
console.log("dropped:", filePath);
ws.close();
