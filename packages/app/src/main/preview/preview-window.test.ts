import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 沙箱预览窗口的四层隔离（ART-101 / M5 出口门禁）。
 *
 * ## 这个文件测的是策略，不是窗口
 *
 * `webRequest.onBeforeRequest` 的回调、`webPreferences` 的取值、CSP 头 ——
 * 这三样东西挂在一个真 BrowserWindow 上时只有起一个真 Electron 才验证得到，
 * 而那种测试不会在 CI 里跑，于是等于没有。因此 preview-window.ts 把它们
 * 全部抽成可导出的纯值/纯函数，这里逐条断言；**真机上的 (a)(b)(c) 三条**
 * 由 scripts/preview-sandbox-probe.cjs 起一个真 Electron 分三趟跑
 * （生产配置 / 开 JS / 开 JS 且不注入 CSP），实测结果记在 summary 里。
 */
import type { PreviewResult } from "@pibuddy/contract";

const permissionRequestHandlers: ((wc: unknown, p: string, cb: (v: boolean) => void) => void)[] =
  [];
const permissionCheckHandlers: (() => boolean)[] = [];
const beforeRequestListeners: ((
  details: { url: string },
  callback: (r: { cancel: boolean }) => void
) => void)[] = [];
const headersListeners: ((
  details: { responseHeaders: Record<string, string[]> },
  callback: (r: { responseHeaders: Record<string, string[]> }) => void
) => void)[] = [];

const fakeSession = {
  webRequest: {
    onBeforeRequest: (fn: (typeof beforeRequestListeners)[number]) =>
      beforeRequestListeners.push(fn),
    onHeadersReceived: (fn: (typeof headersListeners)[number]) => headersListeners.push(fn),
  },
  setPermissionRequestHandler: (fn: (typeof permissionRequestHandlers)[number]) =>
    permissionRequestHandlers.push(fn),
  setPermissionCheckHandler: (fn: () => boolean) => permissionCheckHandlers.push(fn),
};

/** 记录窗口都被要求加载了什么。data: URL 回归的判据就是它。 */
const loaded: { file: string[]; url: string[] } = { file: [], url: [] };

vi.mock("electron", () => ({
  app: { getPath: () => tempRoot },
  session: { fromPartition: () => fakeSession },
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: () => {}, on: () => {} };
    on() {}
    once() {}
    show() {}
    close() {}
    destroy() {}
    isDestroyed() {
      return false;
    }
    loadFile(p: string) {
      loaded.file.push(p);
      return Promise.resolve();
    }
    loadURL(u: string) {
      loaded.url.push(u);
      return Promise.resolve();
    }
  },
}));

type Win = typeof import("./preview-window.js");
let win: Win;
let tempRoot = "";

beforeEach(async () => {
  vi.resetModules();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-prevwin-"));
  loaded.file.length = 0;
  loaded.url.length = 0;
  permissionRequestHandlers.length = 0;
  permissionCheckHandlers.length = 0;
  beforeRequestListeners.length = 0;
  headersListeners.length = 0;
  win = await import("./preview-window.js");
  win.__resetPreviewDirs();
  win.__resetBlockedCount();
});

describe("webPreferences", () => {
  it("四道开关全部收紧，且不加载任何渲染侧桥接脚本", () => {
    const prefs = win.previewWebPreferences();
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.partition).toBe("sandbox:preview");
    expect(prefs.webSecurity).toBe(true);
    // 引擎层面关掉 JS：比 CSP 更硬的一道
    expect(prefs.javascript).toBe(false);
    // 没有 preload，也就没有 window.piBuddy，够不到主 renderer
    expect(prefs.preload).toBeUndefined();
    expect(prefs.webviewTag).toBe(false);
  });

  it("分区名与主窗口不同（拿不到主窗口的 cookie 与登录态）", () => {
    expect(win.PREVIEW_PARTITION).toBe("sandbox:preview");
  });
});

describe("CSP", () => {
  it("script-src / connect-src / default-src 全部钉死", () => {
    expect(win.PREVIEW_CSP).toContain("default-src 'none'");
    expect(win.PREVIEW_CSP).toContain("script-src 'none'");
    expect(win.PREVIEW_CSP).toContain("connect-src 'none'");
    expect(win.PREVIEW_CSP).toContain("frame-src 'none'");
    expect(win.PREVIEW_CSP).toContain("img-src 'self' data:");
  });

  it("CSP 真的被注入到该分区的响应头上", () => {
    win.applyPreviewSessionPolicy(fakeSession as never);
    expect(headersListeners).toHaveLength(1);
    let got: Record<string, string[]> | null = null;
    headersListeners[0]({ responseHeaders: { "X-Old": ["1"] } }, (r) => {
      got = r.responseHeaders;
    });
    expect(got!["Content-Security-Policy"]).toEqual([win.PREVIEW_CSP]);
  });
});

describe("(a) webRequest 拦截", () => {
  it("恶意 HTML 里的两个 https 请求各被 cancel 一次，回调入参都是 {cancel:true}", () => {
    win.applyPreviewSessionPolicy(fakeSession as never);
    expect(beforeRequestListeners).toHaveLength(1);
    const listener = beforeRequestListeners[0];

    // 对应 fixture HTML：<img src="https://example.com/x.png">
    //                  <script src="https://example.com/y.js">
    const urls = ["https://example.com/x.png", "https://example.com/y.js"];
    const calls: { url: string; arg: { cancel: boolean } }[] = [];
    for (const url of urls) {
      listener({ url }, (arg) => calls.push({ url, arg }));
    }

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.arg).toEqual({ cancel: true });
    expect(calls.filter((c) => c.url === urls[0])).toHaveLength(1);
    expect(calls.filter((c) => c.url === urls[1])).toHaveLength(1);
    expect(win.blockedRequestCount()).toBe(2);
  });

  it("非 file 协议一律拦，未登记目录里的 file 也拦", () => {
    const outside = path.join(os.tmpdir(), "elsewhere", "secret.txt");
    expect(win.shouldCancelRequest("http://a.example/x")).toBe(true);
    expect(win.shouldCancelRequest("ws://a.example/x")).toBe(true);
    expect(win.shouldCancelRequest("not a url")).toBe(true);
    expect(win.shouldCancelRequest(`file:///${outside.split(path.sep).join("/")}`)).toBe(true);
  });

  it("只有登记过的转换输出目录里的 file 才放行，且不用字符串前缀判定", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-out-"));
    const allowed = path.join(base, "out");
    const sibling = path.join(base, "out-evil");
    fs.mkdirSync(allowed);
    fs.mkdirSync(sibling);
    win.allowPreviewDir(allowed);

    const toUrl = (p: string) => `file:///${p.split(path.sep).join("/")}`;
    expect(win.shouldCancelRequest(toUrl(path.join(allowed, "a.png")))).toBe(false);
    // "out-evil" 以 "out" 开头，但它显然不在 out 里面
    expect(win.shouldCancelRequest(toUrl(path.join(sibling, "a.png")))).toBe(true);

    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe("预览分区的权限策略", () => {
  it("五种 permission 的两个 handler 全部返回 false", () => {
    win.applyPreviewSessionPolicy(fakeSession as never);
    expect(permissionRequestHandlers).toHaveLength(1);
    expect(permissionCheckHandlers).toHaveLength(1);

    for (const permission of [
      "media",
      "geolocation",
      "notifications",
      "clipboard-read",
      "openExternal",
    ]) {
      let granted: boolean | null = null;
      permissionRequestHandlers[0](null, permission, (v) => {
        granted = v;
      });
      expect(granted, `${permission} 的 request handler`).toBe(false);
      expect(permissionCheckHandlers[0](), `${permission} 的 check handler`).toBe(false);
    }
  });
});

describe("(b)(c) 静态 HTML 生成", () => {
  const result: PreviewResult = {
    kind: "word",
    code: "ok",
    text: `<script>document.title='PWNED'</script><img src="https://example.com/x.png">`,
    suggestion: "",
    notices: [],
    tables: [],
    dataUrl: null,
    sourceName: "evil.docx",
    sizeBytes: 10,
    elapsedMs: 1,
  };

  it("文档内容整体被转义成字面量，页面里没有可执行的 script 元素", () => {
    const html = win.renderPreviewHtml(result);
    // 转义之后原文里的标签只是可见文本
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>document.title");
    expect(html).not.toContain('<img src="https://example.com/x.png">');
    // meta 里再钉一遍 CSP（data: URL 不经 webRequest 的响应头）
    expect(html).toContain("script-src 'none'");
  });

  it("失败时把 SUGGESTION 那句话画在最上面，而不是留一片空白", () => {
    const html = win.renderPreviewHtml({
      ...result,
      code: "password-protected",
      text: "",
      suggestion: "这个文件有密码保护。",
    });
    expect(html).toContain("这个文件有密码保护。");
  });
});

describe("顶层文档必须是白名单内的 file://（data: URL 回归守卫）", () => {
  const result: PreviewResult = {
    kind: "markdown",
    code: "ok",
    text: "正文",
    suggestion: "",
    notices: [],
    tables: [],
    dataUrl: null,
    sourceName: "note.md",
    sizeBytes: 4,
    elapsedMs: 1,
  };

  it("openPreviewWindow 走 loadFile，而且**一次 loadURL 都不调**", () => {
    win.openPreviewWindow({ previewId: "p1", title: "note.md", result });
    expect(loaded.file).toHaveLength(1);
    // 用 data: URL 的话它会被本分区自己的 onBeforeRequest 拦掉：窗口开出来
    // 永远空白，loadURL 的 promise 挂着不结算，且没有任何报错。
    expect(loaded.url).toHaveLength(0);
    expect(loaded.file[0].endsWith("preview.html")).toBe(true);
  });

  it("生成的那一份 HTML 落在已登记目录里，因此顶层文档不会被自己的闸拦掉", () => {
    win.openPreviewWindow({ previewId: "p2", title: "note.md", result });
    const file = loaded.file[0];
    const url = `file:///${file.split(path.sep).join("/")}`;
    expect(win.shouldCancelRequest(url)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("关掉之后目录被摘出白名单并删除（不留残留、也不留一条永久放行）", () => {
    win.openPreviewWindow({ previewId: "p3", title: "note.md", result });
    const file = loaded.file[0];
    const url = `file:///${file.split(path.sep).join("/")}`;
    expect(win.shouldCancelRequest(url)).toBe(false);

    win.closePreviewWindow("p3");
    expect(win.shouldCancelRequest(url)).toBe(true);
    expect(fs.existsSync(win.previewDirFor("p3"))).toBe(false);
  });
});
