/**
 * 沙箱预览窗口（ART-101）——「恶意文档打不开宏、也连不上外网」的那道结构。
 *
 * 四层隔离，缺一层这条门禁都是空的：
 *
 *   1. **独立分区** `partition: 'sandbox:preview'`。不是主窗口的 session，
 *      因此拿不到主窗口的 cookie、localStorage、任何已登录凭据。
 *   2. **没有渲染侧桥**。这个窗口不加载主进程的那个桥接脚本，于是它连
 *      `window.piBuddy` 都没有 —— 即便脚本真的跑起来了，它也发不出任何
 *      一条 IPC，够不到主 renderer 的任何东西。
 *   3. **javascript: false**。整个窗口的 JS 引擎是关的。这是比 CSP 更硬的
 *      一道：CSP 靠的是内容自己声明的规则被正确执行，这个是引擎层面不给跑。
 *   4. **webRequest 全量拦截 + CSP 头**。任何一个 http(s) 请求在发出去
 *      之前就被 cancel；CSP 再把 script-src / connect-src 都钉死成 none。
 *
 * ## 为什么权限处理器必须在这个分区上再注册一遍
 *
 * TASK-004 的 setPermissionRequestHandler 挂在 `defaultSession` 上。新建的
 * 分区**不继承** defaultSession 的策略，它继承的是 Electron 的默认策略
 * ——而默认策略对不少 permission 是放行的。少了下面那两行，这个窗口能
 * 弹麦克风、地理位置、通知授权，而主窗口一切正常，测不出来。
 */
import { app, BrowserWindow, session, type Session } from "electron";
import type { PreviewResult } from "@pibuddy/contract";
import fs from "node:fs";
import path from "node:path";

/** 预览窗口专属分区名。写成常量，避免第二处手抄出一个不同的字符串。 */
export const PREVIEW_PARTITION = "sandbox:preview";

/**
 * 预览窗口的 CSP。
 *
 * 与主窗口的策略是**两套**，刻意不复用：主窗口要跑自己的脚本、要连
 * 自己的 origin，预览窗口这两样都不需要，因此这里能收到 `default-src
 * 'none'` 这个主窗口永远做不到的程度。
 *
 * `style-src 'unsafe-inline'` 是唯一的放宽项：转换产物里的排版全靠内联
 * 样式，去掉之后预览是一坨没有格式的文字。样式不能执行代码，代价可接受。
 */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * 本分区允许加载的本地目录（转换输出目录）。
 *
 * 用集合而不是「凡是 file:// 都放行」：file:// 放行等价于让文档里的
 * `<img src="file:///C:/Users/…/id_rsa">` 去探测本机任意文件是否存在，
 * 而存在性本身就是信息泄漏。
 */
const allowedDirs = new Set<string>();

/** 登记一个允许被本分区读取的本地目录（转换产物落在那里）。 */
export function allowPreviewDir(dir: string): void {
  allowedDirs.add(path.resolve(dir));
}

export function forgetPreviewDir(dir: string): void {
  allowedDirs.delete(path.resolve(dir));
}

/** 仅供单测：清空白名单。 */
export function __resetPreviewDirs(): void {
  allowedDirs.clear();
}

/**
 * 判定一个请求要不要被 cancel。
 *
 * 判据只有一条：**必须是 file:// 且落在某个已登记的转换输出目录里**。
 * 其余一切（http / https / ws / data 的顶层文档 / 别处的 file）一律 cancel。
 * 抽成纯函数是为了让它能被直接断言 —— 挂在 webRequest 回调里的逻辑
 * 只有起一个真窗口才测得到，而那种测试没人会在 CI 里跑。
 */
export function shouldCancelRequest(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "file:") return true;
  let target: string;
  try {
    target = path.resolve(decodeURIComponent(parsed.pathname).replace(/^\/([a-zA-Z]:)/, "$1"));
  } catch {
    return true;
  }
  for (const dir of allowedDirs) {
    const rel = path.relative(dir, target);
    // 用 path.relative 而不是 startsWith：`/out-evil` 以 `/out` 开头，
    // 但它显然不在 `/out` 里面（与 workspace-registry 同一判据，CT-18）。
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return false;
  }
  return true;
}

/** 被拦下来的请求计数。UI 与单测据它断言「确实拦到了东西」。 */
let blockedCount = 0;
export function blockedRequestCount(): number {
  return blockedCount;
}
export function __resetBlockedCount(): void {
  blockedCount = 0;
}

/**
 * 给预览分区装上四道策略：请求拦截、CSP 头、权限请求、权限查询。
 *
 * 幂等：重复调用只是把同一批回调重新挂一遍（Electron 的这几个 setter
 * 都是「后一次覆盖前一次」的语义）。
 */
export function applyPreviewSessionPolicy(target: Session): void {
  target.webRequest.onBeforeRequest((details, callback) => {
    if (shouldCancelRequest(details.url)) {
      blockedCount++;
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });

  target.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [PREVIEW_CSP],
      },
    });
  });

  // 全拒。预览一份不可信文档不需要麦克风、不需要位置、不需要通知，
  // 也不需要读剪贴板 —— 任何一个「看起来无害」的放行都是一条外泄通道。
  target.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

/** 已经开着的预览窗口。previewId → 窗口。 */
const windows = new Map<string, BrowserWindow>();

export interface OpenPreviewOptions {
  previewId: string;
  title: string;
  /** 已经转换好的结果；HTML 由本文件按纯文本转义后生成 */
  result: PreviewResult;
}

/**
 * 把结果渲染成一段**纯静态 HTML**。
 *
 * 全部内容都经 escapeHtml，转换产物里的任何标签都变成可见的字面量 ——
 * 加上 javascript:false 与 script-src 'none'，这里是三重保险。
 */
export function renderPreviewHtml(result: PreviewResult): string {
  const head =
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
    `<style>body{font:14px/1.6 system-ui,sans-serif;margin:16px;color:#222;background:#fff}` +
    `pre{white-space:pre-wrap;word-break:break-word}` +
    `.warn{background:#fff7ed;border:1px solid #fdba74;padding:8px 12px;border-radius:6px;margin-bottom:12px}` +
    `</style>`;
  const warn =
    result.code === "ok"
      ? ""
      : `<div class="warn">${escapeHtml(result.suggestion)}</div>`;
  const notices =
    result.notices.length === 0
      ? ""
      : `<div class="warn">${result.notices.map((n) => escapeHtml(n)).join("<br>")}</div>`;
  const img = result.dataUrl
    ? `<img src="${escapeHtml(result.dataUrl)}" alt="${escapeHtml(result.sourceName)}" style="max-width:100%">`
    : "";
  return `<!doctype html><html><head>${head}</head><body>${warn}${notices}${img}<pre>${escapeHtml(
    result.text
  )}</pre></body></html>`;
}

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 预览窗口的 webPreferences。
 *
 * 抽成一个导出的对象是为了让它可被逐字段断言 —— 写在 new BrowserWindow
 * 的参数里，任何一次「顺手打开一个开关」都要起一个真窗口才发现得了。
 */
export function previewWebPreferences(): Electron.WebPreferences {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    // 这个窗口不加载任何渲染侧桥接脚本：它没有 window.piBuddy，
    // 因此够不到主 renderer 的任何东西。
    preload: undefined,
    partition: PREVIEW_PARTITION,
    webSecurity: true,
    allowRunningInsecureContent: false,
    // 引擎层面关掉 JS。比 CSP 更硬：CSP 要靠内容自己声明的规则被正确
    // 执行，这个是根本不给跑。
    javascript: false,
    webviewTag: false,
    devTools: false,
    spellcheck: false,
  };
}

/** 一个预览窗口专属的落盘目录：`<temp>/pibuddy-preview/<previewId>/`。 */
export function previewDirFor(previewId: string): string {
  return path.join(app.getPath("temp"), "pibuddy-preview", previewId);
}

/**
 * 打开（或复用）一个预览窗口。
 *
 * ## 为什么把 HTML 写成文件再 loadFile，而不是 loadURL 一个 data: URL
 *
 * 本分区的请求判据是「必须是 file:// 且落在已登记目录内」，其余一律
 * cancel —— 而**顶层文档本身也要过这道闸**。用 data: URL 的话，
 * 第一个被拦掉的就是页面自己：窗口开出来，永远空白，且没有任何报错
 * （loadURL 的 promise 直接挂着不结算）。收敛前这里正是那么写的，
 * 三大门禁全绿，真机上一开预览就挂死。
 *
 * 写成文件之后 allowPreviewDir / forgetPreviewDir 这对函数才有真实调用
 * 者，file:// 白名单也才真的表达了「只有我们自己刚生成的那一份能读」。
 */
export function openPreviewWindow(options: OpenPreviewOptions): BrowserWindow {
  const previewSession = session.fromPartition(PREVIEW_PARTITION);
  applyPreviewSessionPolicy(previewSession);

  const existing = windows.get(options.previewId);
  const win =
    existing && !existing.isDestroyed()
      ? existing
      : new BrowserWindow({
          width: 900,
          height: 700,
          title: options.title,
          // 直接显示，不走 ready-to-show。那个事件在 data: URL 与
          // 某些平台组合下并不保证触发，而它不触发的表现是「点了预览，
          // 什么都没发生」—— 一个永远不 show 的隐藏窗口。
          show: true,
          webPreferences: previewWebPreferences(),
        });

  windows.set(options.previewId, win);
  win.on("closed", () => {
    windows.delete(options.previewId);
    releasePreviewDir(options.previewId);
  });
  // 开窗与导航一律拒绝：这个窗口只应该显示我们生成的那一段 HTML。
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  const dir = previewDirFor(options.previewId);
  fs.mkdirSync(dir, { recursive: true });
  allowPreviewDir(dir);
  const file = path.join(dir, "preview.html");
  fs.writeFileSync(file, renderPreviewHtml(options.result), "utf8");
  void win.loadFile(file);
  return win;
}

/**
 * 撤销一个预览的落盘目录：先从白名单里摘掉，再删文件。
 *
 * 顺序不能反：先删文件后摘白名单的话，中间那一瞬间白名单里躺着一个
 * 已经不存在的目录，而下一个预览如果复用了同名路径就会被意外放行。
 */
function releasePreviewDir(previewId: string): void {
  const dir = previewDirFor(previewId);
  forgetPreviewDir(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 删不掉不该影响关窗；残留会在下次同 id 打开时被覆盖
  }
}

/** 关掉一个预览窗口。已经关了的返回 false。 */
export function closePreviewWindow(previewId: string): boolean {
  const win = windows.get(previewId);
  if (!win) return false;
  windows.delete(previewId);
  releasePreviewDir(previewId);
  if (!win.isDestroyed()) win.close();
  return true;
}

/** 应用退出时收掉全部预览窗口。 */
export function closeAllPreviewWindows(): number {
  const count = windows.size;
  for (const [previewId, win] of windows) {
    releasePreviewDir(previewId);
    if (!win.isDestroyed()) win.close();
  }
  windows.clear();
  return count;
}

/** 仅供诊断与单测：当前开着的预览窗口数。 */
export function openPreviewCount(): number {
  return windows.size;
}
