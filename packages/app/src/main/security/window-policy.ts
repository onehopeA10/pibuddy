/**
 * 主窗口安全策略（SEC-001）。
 *
 * 把「加载面 / 导航面 / 开窗面 / 外链面 / 权限面」五个攻击面集中收窄在这一个文件里：
 *
 *   1. CSP        —— webRequest.onHeadersReceived 注入响应头（覆盖 dev 的 http:// 加载路径），
 *                    packaged 的 file:// 加载不经过 webRequest，由 renderer/index.html 的
 *                    <meta http-equiv> 覆盖，两处内容必须与 CSP_POLICY 一致。
 *   2. 导航       —— will-navigate 只放行应用自身 origin，其余 preventDefault 后交给外链通道。
 *   3. 开窗       —— setWindowOpenHandler 恒 deny，绝不开新 BrowserWindow。
 *   4. 外链       —— openExternalSafely 是全仓**唯一**调用 shell.openExternal 的地方。
 *   5. 权限       —— setPermissionRequestHandler / setPermissionCheckHandler 默认全拒，
 *                    只放行「主窗口 + media + 纯 audio」（语音输入需要麦克风）。
 */
import { app, session, shell, type BrowserWindow, type WebContents } from "electron";

/**
 * 内容安全策略。
 *
 * 唯一的放宽项是 style-src 的 'unsafe-inline'：naive-ui 在运行时通过 CSSOM 注入
 * <style> 元素，去掉它整个 UI 会失去样式。script-src / object-src / base-uri
 * **不放宽**，因此即便模型输出被注入到 DOM 里也无法执行脚本。
 *
 * img-src 必须保留 data: 与 blob:：图片附件走 base64 data URL 预览，
 * 去掉会直接打断多模态输入。
 */
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

/** 外链允许的 scheme 白名单。除此之外一律拒绝（含 file:/javascript:/data:/vbscript:/search-ms: 等）。 */
const EXTERNAL_SCHEME_ALLOWLIST = new Set(["https:", "http:", "mailto:"]);

/** 控制字符：URL 里出现即视为构造攻击（NUL 截断、CR/LF 注入等）。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

export type SecurityLogger = {
  warn(event: string, fields?: Record<string, unknown>): void;
};

/** 由 applyWindowPolicy 注入；未注入时退化为 console，保证纯 node 测试可用。 */
let logger: SecurityLogger = {
  warn(event, fields) {
    console.warn(`[security] ${event}`, fields ?? {});
  },
};

export function setSecurityLogger(next: SecurityLogger): void {
  logger = next;
}

/** dev 下的渲染进程 origin（vite dev server）；packaged 下为 null。 */
function devRendererOrigin(): string | null {
  const raw = process.env.ELECTRON_RENDERER_URL;
  if (app.isPackaged || !raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * 是否是「应用自身」的地址。
 * packaged 走 file://（loadFile），dev 走 ELECTRON_RENDERER_URL 的 origin —— 后者必须放行，
 * 否则 vite HMR 的整页刷新会被 will-navigate 拦掉，热更新直接失效。
 */
export function isAppUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "file:") return true;
  const dev = devRendererOrigin();
  return dev !== null && url.origin === dev;
}

/**
 * 规范化并校验一个外链，安全时交给系统浏览器打开。
 *
 * 全仓唯一的 shell.openExternal 出口。返回是否真的打开。
 */
export async function openExternalSafely(raw: unknown): Promise<boolean> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    logger.warn("external_link_blocked", { reason: "shape" });
    return false;
  }
  if (CONTROL_CHARS.test(raw)) {
    logger.warn("external_link_blocked", { reason: "control_char" });
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    logger.warn("external_link_blocked", { reason: "unparsable" });
    return false;
  }
  if (!EXTERNAL_SCHEME_ALLOWLIST.has(url.protocol)) {
    logger.warn("external_link_blocked", { reason: "scheme", scheme: url.protocol });
    return false;
  }
  try {
    await shell.openExternal(url.toString());
    return true;
  } catch {
    logger.warn("external_link_blocked", { reason: "open_failed", scheme: url.protocol });
    return false;
  }
}

/** 权限判定的纯函数部分，便于单测与两个 handler 复用。 */
function isPermissionAllowed(
  isMainWindow: boolean,
  permission: string,
  mediaTypes: readonly string[] | undefined
): boolean {
  if (!isMainWindow) return false;
  if (permission !== "media") return false;
  // 只需要麦克风。mediaTypes 缺失或含 video 一律拒绝。
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) return false;
  return mediaTypes.every((t) => t === "audio");
}

/**
 * 给主窗口装上全部安全策略。应在 BrowserWindow 创建后立即调用。
 */
export function applyWindowPolicy(
  win: BrowserWindow,
  opts?: { logger?: SecurityLogger }
): void {
  if (opts?.logger) setSecurityLogger(opts.logger);

  const defaultSession = session.defaultSession;

  // 1) CSP：响应头下发，覆盖 dev 的 http:// 加载路径
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP_POLICY],
      },
    });
  });

  // 2) 导航：非应用 origin 一律拦下，能走外链的交给系统浏览器
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    logger.warn("navigation_blocked", { scheme: safeScheme(url) });
    void openExternalSafely(url);
  });

  // 3) 开窗：恒 deny；target=_blank 的外链改由系统浏览器承接
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url);
    return { action: "deny" };
  });

  // 4) 权限：默认全拒，只放行主窗口的麦克风
  const isMainWindow = (wc: WebContents): boolean =>
    !win.isDestroyed() && wc === win.webContents;

  defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] } | undefined)?.mediaTypes;
    const allowed = isPermissionAllowed(isMainWindow(wc), permission, mediaTypes);
    if (!allowed) logger.warn("permission_denied", { permission });
    callback(allowed);
  });

  defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => {
    // check handler 的 details 用单数 mediaType，统一成数组再判定
    const single = (details as { mediaType?: string } | undefined)?.mediaType;
    const mediaTypes =
      (details as { mediaTypes?: string[] } | undefined)?.mediaTypes ??
      (single && single !== "unknown" ? [single] : undefined);
    return isPermissionAllowed(wc !== null && isMainWindow(wc), permission, mediaTypes);
  });
}

function safeScheme(raw: string): string {
  try {
    return new URL(raw).protocol;
  } catch {
    return "invalid";
  }
}
