/**
 * 窗口「外壳」的颜色：BrowserWindow 底色 + titleBarOverlay（右上角三个窗口
 * 按钮那一块由 Electron 自己画，CSS 管不到）。
 *
 * 值必须与 renderer/src/tokens.css 的 --bg-app / --text-primary 逐字一致，
 * 否则自绘顶栏与窗口按钮区之间会出现一条颜色不同的竖块 —— 这正是当初
 * 隐藏系统标题栏要解决的问题。
 */
import { BrowserWindow } from "electron";
import type { AppTheme } from "@pibuddy/contract";

export interface ThemeChrome {
  /** 窗口底色（首帧、以及渲染进程还没画出来时露出的那块） */
  backgroundColor: string;
  /** titleBarOverlay 底色 */
  overlayColor: string;
  /** 窗口按钮图标颜色 */
  symbolColor: string;
}

const CHROME: Record<AppTheme, ThemeChrome> = {
  dark: { backgroundColor: "#0F1115", overlayColor: "#0F1115", symbolColor: "#E6E8EC" },
  light: { backgroundColor: "#F6F7F9", overlayColor: "#F6F7F9", symbolColor: "#1F2329" },
};

/** 须与 tokens.css 的 --header-height 一致 */
export const TITLE_BAR_HEIGHT = 40;

export function themeChrome(theme: AppTheme | undefined): ThemeChrome {
  return CHROME[theme ?? "dark"];
}

/**
 * 把新配色刷到所有已开窗口。setTitleBarOverlay 只在 Windows / Linux 上存在
 * （macOS 的红绿灯不受它管），缺方法时跳过而不是抛错。
 */
export function applyThemeChrome(theme: AppTheme): void {
  const chrome = themeChrome(theme);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.setBackgroundColor(chrome.backgroundColor);
    if (typeof win.setTitleBarOverlay === "function") {
      win.setTitleBarOverlay({
        color: chrome.overlayColor,
        symbolColor: chrome.symbolColor,
        height: TITLE_BAR_HEIGHT,
      });
    }
  }
}
