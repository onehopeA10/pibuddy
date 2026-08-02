import { app, BrowserWindow } from "electron";
import path from "node:path";
import { registerIpc, disposeClientFor } from "./ipc.js";
import { createLogger, type Logger } from "./logger.js";
import { applyWindowPolicy } from "./security/window-policy.js";
import { armUpdateChecks, disposeUpdateService } from "./update/update-ipc.js";

/** 全应用唯一的 logger 实例，在 whenReady 之后才可用（依赖 userData 路径）。 */
let logger: Logger | null = null;
export function mainLogger(): Logger {
  if (!logger) {
    logger = createLogger({ dir: path.join(app.getPath("userData"), "logs") });
  }
  return logger;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: "PiBuddy · AI 办公小助手",
    autoHideMenuBar: true,
    backgroundColor: "#f7f7f8",
    webPreferences: {
      // .cjs 不是笔误：沙箱化 preload 只支持 CommonJS，见 electron.vite.config.ts
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用 contextBridge / ipcRenderer / webUtils，无任何 node 内建依赖，
      // 因此可以运行在沙箱里（SEC-001）。开启后渲染进程失去所有 node 能力。
      sandbox: true,
    },
  });

  // CSP / 导航拦截 / 开窗拒绝 / 外链白名单 / 权限最小化，全部集中在 window-policy
  applyWindowPolicy(win, { logger: mainLogger() });

  const wcId = win.webContents.id;
  win.on("closed", () => disposeClientFor(wcId));

  // 主窗口可交互之后才排更新检查（30s 后首检，见 UpdateService）。
  // 不在 whenReady 里排：那会儿主线程正忙着渲染首屏，一次网络请求足以
  // 让首帧再晚半秒。
  win.once("ready-to-show", () => armUpdateChecks());

  // 生产二进制里即使外部注入了 ELECTRON_RENDERER_URL 也不得加载远程地址
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    mainLogger().info("app_ready", {
      version: app.getVersion(),
      platform: process.platform,
    });
    registerIpc();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // 更新检查的定时器已经 unref 过，这里再显式拆一次：崩溃现场里
    // 「进程退不掉」的原因往往就是某个没人清的 timer。
    disposeUpdateService();
    app.quit();
  });
}
