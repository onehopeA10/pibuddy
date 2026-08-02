/**
 * 诊断三条通道的接线（OBS-101）。
 *
 * 与其它 *-ipc.ts 同构：**本文件不出现 ipcMain.handle**，注册一律经
 * ipc-guard 的 registerHandler，四道闸因此对诊断通道自动生效。
 *
 * 三条通道都不接受路径形参：导出位置由主进程弹出的保存对话框决定，
 * 收集范围写死在 support-bundle 的 plan() 里。否则 support bundle 会退化成
 * 一条「读任意文件并打包外发」的通用旁路 —— 那比它要解决的问题严重得多。
 */
import { BrowserWindow, app, dialog, shell } from "electron";
import path from "node:path";
import os from "node:os";

import {
  CHANNELS,
  bundleExportRequestSchema,
  voidRequestSchema,
  type BundleExportResult,
  type BundlePreview,
  type DiagnosticsReport,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { createLogger, logDir, type Logger } from "../logger.js";
import { loadSettings } from "../settings.js";
import { markerDir, readPendingUpdate, readHealth } from "../health/update-markers.js";
import { safeModeState } from "../health/safe-mode.js";
import { exportBundle, previewBundle, type BundleSources } from "./support-bundle.js";

/** 惰性取 logger：模块顶层建会在 configureLogging 之前拿到回落目录。 */
let cachedLog: Logger | null = null;
function log(): Logger {
  if (!cachedLog) cachedLog = createLogger("main").child({ mod: "diagnostics" });
  return cachedLog;
}

function stateDir(): string {
  return markerDir(app.getPath("userData"));
}

/**
 * 诊断包的取材范围。**写死在这里**，渲染进程无从影响。
 *
 * crashDumpConsent 从设置里读：默认 `unset`，也就是「没问过就当没同意」。
 */
function sources(): BundleSources {
  const settings = loadSettings();
  const logger = createLogger("main");
  return {
    logFiles: logger.logFiles(),
    settingsFile: path.join(app.getPath("userData"), "settings.json"),
    updateStateDir: stateDir(),
    crashDumpDir: path.join(app.getPath("crashDumps"), "reports"),
    crashDumpConsent: settings.crashDumpConsent ?? "unset",
    systemInfo: {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      locale: app.getLocale(),
      packaged: app.isPackaged,
      piRuntimeMode: settings.piRuntimeMode,
      logDir: logDir(),
    },
  };
}

export function currentReport(): DiagnosticsReport {
  const dir = stateDir();
  return {
    safeMode: safeModeState(dir),
    health: readHealth(dir).lastResult,
    pendingUpdate: readPendingUpdate(dir) !== null,
    currentVersion: app.getVersion(),
  };
}

export function registerDiagnosticsIpc(): void {
  registerHandler<void, BundlePreview>(
    CHANNELS.diagnosticsPreviewBundle,
    voidRequestSchema,
    () => {
      const src = sources();
      const entries = previewBundle(src);
      return {
        entries,
        totalBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0),
        crashDumpConsent: src.crashDumpConsent,
      };
    }
  );

  registerHandler(
    CHANNELS.diagnosticsExportBundle,
    bundleExportRequestSchema,
    async (payload, event): Promise<BundleExportResult> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const suggested = path.join(
        app.getPath("downloads"),
        `pibuddy-diagnostics-${stamp}.zip`
      );

      // 保存对话框是这条链上唯一决定落盘位置的地方。渲染进程给不出路径，
      // 也就无法把诊断包写到它想写的任何地方。
      const picked = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
        title: "导出诊断包",
        defaultPath: suggested,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (picked.canceled || !picked.filePath) {
        return { path: null, entryCount: 0, totalBytes: 0 };
      }

      const result = exportBundle(picked.filePath, sources());
      log().info("support_bundle_exported", {
        entryCount: result.entryCount,
        totalBytes: result.totalBytes,
      });
      // showItemInFolder 只定位文件，不是 openExternal —— 外链出口依然唯一。
      if (payload.reveal) shell.showItemInFolder(result.path);
      return { path: result.path, entryCount: result.entryCount, totalBytes: result.totalBytes };
    }
  );

  registerHandler<void, DiagnosticsReport>(
    CHANNELS.diagnosticsGetReport,
    voidRequestSchema,
    () => currentReport()
  );
}
