/**
 * 沙箱预览窗口的真机探针（ART-101 c[1] / M5 出口门禁）。
 *
 *     pnpm --filter @pibuddy/app build
 *     npx electron scripts/preview-sandbox-probe.cjs
 *
 * 起**真** Electron 窗口，用生产代码里的同一个 previewWebPreferences 与
 * 同一套 session 策略加载一段敌意 HTML（外链图片 + 外链脚本 + 内联脚本），
 * 分两趟测：
 *
 *   nojs 趟 —— 生产配置原样（javascript 关）。断言文档能加载，且
 *              executeJavaScript **抛错** —— JS 引擎真的是关的。
 *   js   趟 —— 只把 javascript 打开、其余一字不动。这一趟量 (b)(c)。
 *   nocsp趟 —— javascript 打开且**不注入 CSP 头**。这一趟量 (a)：
 *              把 CSP 那层拿掉之后，两个 https 请求才会真的走到
 *              webRequest，于是「onBeforeRequest 各被调用一次且入参
 *              为 {cancel:true}」才**测得到**。
 *
 * ## 两处与原始收敛条件的出入（实测结论，不是绕过）
 *
 *   1. 生产配置下 onBeforeRequest **收不到**那两个 https 请求 —— CSP 的
 *      `default-src 'none'` 在渲染进程里就把它们掐了，根本没进网络栈。
 *      这比「进了网络栈再被 cancel」更强。webRequest 是它后面的兜底，
 *      因此单独用 nocsp 趟去证明那一层是活的。
 *   2. `performance.getEntriesByType('resource').length === 0` 在
 *      Chromium 上做不到：**被拦掉的请求照样会留下一条时序条目**，
 *      只是 transferSize / encodedBodySize / duration 全为 0。因此判据
 *      改成「每一条的 transferSize 与 encodedBodySize 都是 0」——
 *      语义是同一个：一个字节都没进来。
 *
 * 三趟必须在**三个进程**里跑（同一进程内建过第二个窗口就会 ERR_FAILED，
 * 那是 Electron 的行为不是被测策略），由 --pass 参数选。
 *
 * 退出码 0 = 全过；1 = 任意一条不成立，并打印实际值。
 */
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HOSTILE = `<!doctype html><html><head><meta charset="utf-8"><title>SAFE</title></head><body>
<img src="https://example.com/x.png">
<script src="https://example.com/y.js"></script>
<script>document.title='PWNED'</script>
<p>hostile</p></body></html>`;

const checks = [];
function check(name, ok, detail) {
  checks.push([name, ok, detail]);
}

async function run(mod, { javascript, csp }) {
  // B 趟必须换一个分区：同一个 session 上重复注册 onBeforeRequest 是
  // 「后一次覆盖前一次」，两趟混在一个分区里会互相吃掉对方的计数。
  // 分区名不再叠第三段冒号 —— Electron 对多段冒号的分区名解析不稳，
  // 表现是 loadFile 直接 ERR_FAILED 而 webRequest 一次都不触发。
  const partition = javascript ? (csp ? "preview-jsprobe" : "preview-nocspprobe") : mod.PREVIEW_PARTITION;
  const target = session.fromPartition(partition);
  mod.applyPreviewSessionPolicy(target);

  // 生产策略已经在里面 cancel 了；外面再挂一层只做计数与入参留证。
  const calls = [];
  target.webRequest.onBeforeRequest((details, callback) => {
    const cancel = mod.shouldCancelRequest(details.url);
    calls.push({ url: details.url, arg: { cancel } });
    callback({ cancel });
  });
  target.webRequest.onHeadersReceived((details, callback) => {
    if (!csp) return callback({});
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [mod.PREVIEW_CSP],
      },
    });
  });

  // 顶层文档也要过 onBeforeRequest 那道闸，因此它必须是一个**已登记
  // 目录里的 file://** —— 与 openPreviewWindow 的真实做法一致。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-probe-"));
  const file = path.join(dir, "hostile.html");
  fs.writeFileSync(file, HOSTILE, "utf8");
  mod.allowPreviewDir(dir);

  const prefs = { ...mod.previewWebPreferences(), partition, javascript };
  const win = new BrowserWindow({ width: 640, height: 480, show: false, webPreferences: prefs });

  await win.loadFile(file);
  // 给被拦掉的子资源留出发起的时间：不等的话「一个都没加载」会因为
  // 「还没来得及加载」而假通过。
  await new Promise((r) => setTimeout(r, 1500));

  const https = calls.filter((c) => c.url.startsWith("https://"));
  const img = https.filter((c) => c.url === "https://example.com/x.png");
  const js = https.filter((c) => c.url === "https://example.com/y.js");
  const tag = javascript ? (csp ? "js" : "nocsp") : "nojs";

  if (javascript && !csp) {
    // 只有拿掉 CSP 之后，请求才走得到 webRequest —— 这一趟专门量它。
    check(
      `(${tag}-a1) img 请求恰走到 onBeforeRequest 一次且被 cancel`,
      img.length === 1 && img[0].arg.cancel === true,
      JSON.stringify(img)
    );
    check(
      `(${tag}-a2) script 请求恰走到 onBeforeRequest 一次且被 cancel`,
      js.length === 1 && js[0].arg.cancel === true,
      JSON.stringify(js)
    );
    check(
      `(${tag}-a3) 全部 https 回调入参均为 {cancel:true}`,
      https.length > 0 && https.every((c) => c.arg.cancel === true),
      JSON.stringify(https)
    );
  } else {
    // 生产配置下这两个请求被 CSP 掐在更前面，webRequest 一次都收不到。
    check(
      `(${tag}-a0) 生产配置下 https 请求连网络栈都没进`,
      https.length === 0,
      JSON.stringify(https)
    );
  }

  if (!javascript) {
    let threw = false;
    try {
      await win.webContents.executeJavaScript("1+1");
    } catch {
      threw = true;
    }
    check("(nojs-b0) JS 引擎关闭：连 executeJavaScript 都执行不了", threw, "居然执行成功了");
    check("(nojs-load) 敌意文档本身照常加载出来了", win.webContents.getURL().startsWith("file://"), win.webContents.getURL());
  } else {
    const title = await win.webContents.executeJavaScript("document.title");
    const raw = await win.webContents.executeJavaScript(
      "JSON.stringify(performance.getEntriesByType('resource').map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize})))"
    );
    const entries = JSON.parse(raw);
    console.log(`  [probe] resource entries: ${raw}`);
    if (csp) {
      check(
        `(${tag}-b) 内联脚本未执行`,
        title !== "PWNED",
        `document.title=${JSON.stringify(title)}`
      );
    } else {
      // **阳性对照**：把 CSP 拿掉之后内联脚本必须真的跑起来。
      // 这一条不是「顺便看看」——它是上面那条 (js-b) 不空洞的唯一证明。
      // 没有它的话，一个「HTML 根本没加载」的探针也会让 (js-b) 通过。
      check(
        `(${tag}-b) 阳性对照：拿掉 CSP 之后内联脚本确实执行了`,
        title === "PWNED",
        `document.title=${JSON.stringify(title)}（说明这个探针根本没在测脚本执行）`
      );
    }
    check(
      `(${tag}-c) 没有任何资源真的被下载（每条时序的字节数都是 0）`,
      entries.every((e) => e.transferSize === 0 && e.encodedBodySize === 0),
      raw
    );
  }

  win.destroy();
  mod.forgetPreviewDir(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return calls;
}

app.whenReady().then(async () => {
  const modUrl = pathToFileURL(
    path.join(__dirname, "..", "out", "main", "preview-window.js")
  ).href;
  const mod = await import(modUrl);

  // 两趟必须在**两个进程**里跑：同一进程内先建过一个开着 javascript:false
  // 的窗口之后，再开第二个窗口会直接 ERR_FAILED —— 那是 Electron 的行为，
  // 不是被测策略。用 --pass 参数分开跑，脚本由外面调两次。
  const pass = process.argv.includes("--pass=js")
    ? "js"
    : process.argv.includes("--pass=nocsp")
      ? "nocsp"
      : "nojs";
  let allCalls = [];
  try {
    allCalls = await run(mod, { javascript: pass !== "nojs", csp: pass !== "nocsp" });
  } catch (err) {
    check("探针自身跑完", false, String((err && err.stack) || err));
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  —— ${detail}`}`);
    if (!ok) failed++;
  }
  console.log(`\n经过闸门的请求：${JSON.stringify(allCalls, null, 1)}`);
  app.exit(failed === 0 ? 0 : 1);
});
