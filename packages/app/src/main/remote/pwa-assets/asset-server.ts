/**
 * 静态壳的服务映射（内嵌资产 → 响应）。零 fs 读（资产是字符串常量）。
 *
 * 本文件在 `pwa-assets/` 子目录：drift 的 capabilitySource 只扫 `main/remote`
 * 顶层，不递归子目录，因此静态壳的服务逻辑与 `connector.remote` 的权限对账互不
 * 牵连（且它本就无任何敏感调用）。
 */
import {
  APP_JS,
  INDEX_HTML,
  MANIFEST_JSON,
  PAIR_HTML,
  PAIR_JS,
  STYLE_CSS,
  SW_JS,
} from "./pwa-content.js";

export interface RemoteAsset {
  contentType: string;
  body: string;
}

const HTML = "text/html; charset=utf-8";
const JS = "application/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const WEBMANIFEST = "application/manifest+json; charset=utf-8";

const MAP: Record<string, RemoteAsset> = {
  "/": { contentType: HTML, body: INDEX_HTML },
  "/index.html": { contentType: HTML, body: INDEX_HTML },
  "/pair.html": { contentType: HTML, body: PAIR_HTML },
  "/app.js": { contentType: JS, body: APP_JS },
  "/pair.js": { contentType: JS, body: PAIR_JS },
  "/style.css": { contentType: CSS, body: STYLE_CSS },
  "/sw.js": { contentType: JS, body: SW_JS },
  "/manifest.webmanifest": { contentType: WEBMANIFEST, body: MANIFEST_JSON },
};

export function serveAsset(pathname: string): RemoteAsset | null {
  return MAP[pathname] ?? null;
}
