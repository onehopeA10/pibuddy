/**
 * 界面配色的渲染侧落点。
 *
 * 真相在设置文件里（settings.theme，主进程持有）；这里做三件事：
 *   1. 把它写到 `<html data-theme>`，tokens.css 据此切颜色 token；
 *   2. 换 highlight.js 的样式表 —— 它的 token 颜色是按深 / 浅底各出一套的，
 *      深色那套放在浅底上几乎看不见，所以不能只切我们自己的 token；
 *   3. 在 localStorage 记一份**只用于首帧**的副本：设置要过一次 IPC 才到，
 *      不缓存的话浅色用户每次启动都会先闪一下深色。
 */
import type { AppTheme } from "@contract";
import hljsDark from "highlight.js/styles/github-dark.css?inline";
import hljsLight from "highlight.js/styles/github.css?inline";

const CACHE_KEY = "pibuddy.theme";
const HLJS_STYLE_ID = "pibuddy-hljs-theme";

function isTheme(value: unknown): value is AppTheme {
  return value === "dark" || value === "light";
}

/** 首帧用的缓存值；没有或不合法时回落到深色（与 schema 默认一致）。 */
export function readCachedTheme(): AppTheme {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    return isTheme(cached) ? cached : "dark";
  } catch {
    return "dark";
  }
}

/** 把配色落到 DOM。可重复调用，同值时是空操作。 */
export function applyTheme(theme: AppTheme): void {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;

  let style = document.getElementById(HLJS_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = HLJS_STYLE_ID;
    document.head.appendChild(style);
  }
  const css = theme === "light" ? hljsLight : hljsDark;
  if (style.textContent !== css) style.textContent = css;

  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // 隐私模式 / 配额满：缓存只影响首帧观感，写不进去就算了
  }
}
