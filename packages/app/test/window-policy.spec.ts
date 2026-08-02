import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 窗口安全策略的关键路径断言（不做穷举矩阵）：
 *   1. 外链只放行 https/http/mailto，危险 scheme 与控制字符一律不触达 shell.openExternal
 *   2. 权限处理器只放行「主窗口 + media + 纯 audio」
 *   3. markdown 剥掉非白名单 scheme 的 href，并对超长输出按字节封顶
 *
 * electron 整体打桩：本测试跑在纯 node 的 vitest 里，没有 electron 运行时。
 */
const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  isPackaged: { value: false },
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged.value;
    },
  },
  shell: { openExternal: mocks.openExternal },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: (fn: unknown) => {
          registered.headers = fn;
        },
      },
      setPermissionRequestHandler: (fn: unknown) => {
        registered.permissionRequest = fn;
      },
      setPermissionCheckHandler: (fn: unknown) => {
        registered.permissionCheck = fn;
      },
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registered: Record<string, any> = {};

const { CSP_POLICY, applyWindowPolicy, openExternalSafely } = await import(
  "../src/main/security/window-policy.js"
);
const { renderMarkdown, truncateToolOutput, MAX_TOOL_OUTPUT_BYTES } = await import(
  "../src/renderer/src/markdown.js"
);

/** 最小 BrowserWindow 替身，只保留策略用到的表面 */
function makeFakeWindow() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const webContents = {
    on(event: string, fn: (...args: unknown[]) => void) {
      listeners.set(event, fn);
    },
    setWindowOpenHandler(fn: unknown) {
      registered.windowOpen = fn;
    },
  };
  return {
    webContents,
    isDestroyed: () => false,
    listeners,
  };
}

beforeEach(() => {
  mocks.openExternal.mockClear();
  mocks.isPackaged.value = false;
});

describe("openExternalSafely", () => {
  const blocked = [
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "vbscript:msgbox",
    "search-ms:query=x",
    "https://example.com/a\u0000b",
  ];

  it.each(blocked)("拒绝危险外链且不调用 shell.openExternal: %s", async (raw) => {
    await expect(openExternalSafely(raw)).resolves.toBe(false);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/", "mailto:a@b.com"])("放行 %s", async (raw) => {
    await expect(openExternalSafely(raw)).resolves.toBe(true);
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
  });
});

describe("applyWindowPolicy", () => {
  it("注册 CSP 响应头、导航拦截、开窗拒绝与权限处理器", () => {
    const win = makeFakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyWindowPolicy(win as any);

    // CSP 响应头
    let injected: Record<string, unknown> = {};
    registered.headers(
      { responseHeaders: { "x-existing": ["1"] } },
      (r: { responseHeaders: Record<string, unknown> }) => {
        injected = r.responseHeaders;
      }
    );
    expect(injected["Content-Security-Policy"]).toEqual([CSP_POLICY]);
    expect(CSP_POLICY).toContain("object-src 'none'");
    expect(CSP_POLICY).toContain("img-src 'self' data: blob:");

    // 开窗一律 deny
    expect(registered.windowOpen({ url: "https://example.com/" })).toEqual({
      action: "deny",
    });

    // 导航：应用自身放行，外部 origin 被 preventDefault
    const willNavigate = win.listeners.get("will-navigate")!;
    const evAllowed = { preventDefault: vi.fn() };
    willNavigate(evAllowed, "file:///C:/app/out/renderer/index.html");
    expect(evAllowed.preventDefault).not.toHaveBeenCalled();

    const evBlocked = { preventDefault: vi.fn() };
    willNavigate(evBlocked, "https://evil.example.com/");
    expect(evBlocked.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("权限处理器只放行主窗口的麦克风", () => {
    const win = makeFakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applyWindowPolicy(win as any);
    const handler = registered.permissionRequest;

    const ask = (
      wc: unknown,
      permission: string,
      details?: Record<string, unknown>
    ): boolean => {
      let result: boolean | null = null;
      handler(wc, permission, (allowed: boolean) => (result = allowed), details);
      return result as unknown as boolean;
    };

    expect(ask(win.webContents, "media", { mediaTypes: ["audio"] })).toBe(true);
    expect(ask(win.webContents, "media", { mediaTypes: ["video"] })).toBe(false);
    expect(ask(win.webContents, "media", { mediaTypes: ["audio", "video"] })).toBe(false);
    expect(ask(win.webContents, "geolocation", {})).toBe(false);
    expect(ask({ other: true }, "media", { mediaTypes: ["audio"] })).toBe(false);

    // check handler 用单数 mediaType
    expect(
      registered.permissionCheck(win.webContents, "media", "file://", {
        mediaType: "audio",
      })
    ).toBe(true);
    expect(
      registered.permissionCheck(win.webContents, "media", "file://", {
        mediaType: "video",
      })
    ).toBe(false);
  });
});

describe("markdown 内容限额", () => {
  it("剥掉 javascript: 链接的 href，输出不含该 scheme", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(">x<");
  });

  it("保留 https 链接并剥掉 file: 图片 src", () => {
    expect(renderMarkdown("[a](https://example.com/)")).toContain(
      'href="https://example.com/"'
    );
    const img = renderMarkdown("![i](file:///C:/secret.png)");
    expect(img).not.toContain("file:");
    expect(renderMarkdown("![i](data:image/png;base64,AAAA)")).toContain(
      'src="data:image/png;base64,AAAA"'
    );
  });

  it("超长输出按字节封顶", () => {
    const long = "a".repeat(100000);
    const out = truncateToolOutput(long);
    const bytes = new TextEncoder().encode(out).length;
    const markBytes = bytes - MAX_TOOL_OUTPUT_BYTES;
    expect(bytes).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES + 128);
    expect(markBytes).toBeGreaterThan(0);
    expect(out).toContain("已截断");
    // 中文同样按字节而非字符计
    const cn = truncateToolOutput("中".repeat(50000));
    expect(new TextEncoder().encode(cn).length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES + 128
    );
    // 未超限时原样返回
    expect(truncateToolOutput("short")).toBe("short");
  });
});
