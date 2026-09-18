/**
 * 系统托盘：窗口收到托盘之后，从这里再打开或退出。
 */
import { BrowserWindow, Menu, Tray, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";

let tray: Tray | null = null;

export function resolveAppIconPath(): string {
  const candidates = [
    path.join(import.meta.dirname, "../../build/icon.png"),
    path.join(import.meta.dirname, "../../build/icon.ico"),
    path.join(import.meta.dirname, "../../src/renderer/src/assets/logo.png"),
    path.join(import.meta.dirname, "../../../../images/logo.png"),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0];
}

export function ensureAppTray(handlers: { onShow: () => void; onQuit: () => void }): void {
  if (tray) return;
  const image = nativeImage.createFromPath(resolveAppIconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("PiBuddy");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开", click: handlers.onShow },
      { type: "separator" },
      { label: "退出", click: handlers.onQuit },
    ])
  );
  tray.on("click", handlers.onShow);
}

export function destroyAppTray(): void {
  tray?.destroy();
  tray = null;
}

export function hideWindowToTray(
  win: BrowserWindow,
  handlers: { onShow: () => void; onQuit: () => void }
): void {
  ensureAppTray(handlers);
  win.setSkipTaskbar(true);
  win.hide();
}

export function revealWindow(win: BrowserWindow): void {
  win.setSkipTaskbar(false);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function revealMainWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return null;
  revealWindow(win);
  return win;
}
