/**
 * 启动健康检查的接线层（OBS-101 / UPD-006）。
 *
 * health-check.ts 只有超时与聚合语义，刻意不认识 electron；真正的三个探针、
 * marker 目录与 safe mode 的落盘发生在这里。
 *
 * ## 只在「更新之后的第一次启动」跑
 *
 * 平时每次启动都跑一遍三项检查，等于给每一次启动都加上一段等待，而它换来的
 * 信息在 99.9% 的情况下是「一切正常」。判据是 pending-update marker 在不在 ——
 * 它由 UpdateService 在 quitAndInstall 之前写下。
 *
 * ## 三种结局
 *
 *   健康  → 写 last-known-good、清 pending marker、失败计数归零
 *   失败  → 失败计数 +1；连续 2 次进安全模式；pending marker **保留**
 *          （下次启动还要再验一遍，一次网络抖动不该被当成"这版坏了"）
 */
import { app, BrowserWindow } from "electron";
import path from "node:path";

import type { HealthCheckResult, SafeModeState } from "@pibuddy/contract";

import { createLogger, type Logger } from "../logger.js";
import {
  RUNTIME_DIR_NAME,
  readRuntimeManifest,
  resolveRuntimeEntry,
} from "../pi-runtime-manifest.js";
import { sessionIndex } from "../sessions/session-index.js";
import { runStartupHealthCheck, type HealthProbes } from "./health-check.js";
import { recordHealthResult, safeModeState } from "./safe-mode.js";
import {
  clearPendingUpdate,
  markerDir,
  readPendingUpdate,
  writeLastKnownGood,
} from "./update-markers.js";

/**
 * **惰性**取 logger，不在模块顶层建。
 *
 * 模块顶层建的话，构造发生在 import 期 —— 那时 main/index.ts 还没调过
 * configureLogging，日志目录仍是回落用的临时目录。表现是这个模块写出来的
 * 每一行都落在 %TEMP% 下，而排查的人在 userData/logs 里翻半天什么都找不到。
 */
let cached: Logger | null = null;
function log(): Logger {
  if (!cached) cached = createLogger("main").child({ mod: "health" });
  return cached;
}

/**
 * 三个真实探针。
 *
 * 每一项都刻意做得很轻：这是**启动路径**上的检查，不是自检套件。
 */
export function electronProbes(win: BrowserWindow | null): HealthProbes {
  return {
    // 会话索引打得开 = SQLite 文件在、schema migration 跑完了。
    // 这是更新后最容易坏的一件事：新版本带了新的 schema 版本。
    dbMigration: async () => {
      // sessionIndex() 的构造函数里就是 DDL + migrate()，取一次单例即可。
      sessionIndex();
    },
    /**
     * 主窗口的 webContents 还在、没崩、没卡在 loading。
     *
     * **不能只挂 `once("did-finish-load")`**：本探针是被 did-finish-load
     * 触发的那条路径调起来的，那一刻 `isLoading()` 可能还没翻转成 false，
     * 而 did-finish-load 已经发过了、不会再发第二次 —— 于是这个 Promise
     * 永远不 resolve，实测表现是 renderer-ready 每次都恰好卡满 5000ms 超时
     * 然后报失败。轮询补上这条竞态。
     */
    rendererReady: async () => {
      if (!win || win.isDestroyed()) throw new Error("no window");
      if (win.webContents.isCrashed()) throw new Error("renderer crashed");
      if (!win.webContents.isLoading()) return;

      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const cleanup = (): void => {
          if (timer) globalThis.clearInterval(timer);
          timer = null;
          win.webContents.off("did-finish-load", ok);
          win.webContents.off("did-fail-load", bad);
        };
        const ok = (): void => {
          cleanup();
          resolve();
        };
        const bad = (): void => {
          cleanup();
          reject(new Error("did-fail-load"));
        };
        win.webContents.once("did-finish-load", ok);
        win.webContents.once("did-fail-load", bad);
        timer = globalThis.setInterval(() => {
          if (win.isDestroyed()) return bad();
          if (!win.webContents.isLoading()) ok();
        }, 100);
      });
    },
    /**
     * 内置 pi 运行时的 manifest 能解析、入口文件在。**不真的 spawn**：
     * 启动路径上多起一个 node 进程，代价比它能发现的问题大。
     *
     * 未打包时直接放行：`process.resourcesPath` 在 dev 下指向 electron 自己的
     * resources 目录，那里从来就没有 pi-runtime。在那里做这项检查，测的是
     * 「有没有打包」而不是「运行时完不完整」，而它的失败会把开发机上的每次
     * 更新演练都染成红色。
     */
    piHandshake: async () => {
      if (!app.isPackaged) return;
      const root = path.join(process.resourcesPath ?? "", RUNTIME_DIR_NAME);
      const manifest = readRuntimeManifest(root);
      resolveRuntimeEntry(root, manifest);
    },
  };
}

/**
 * 更新之后第一次启动才跑的健康检查。
 *
 * 没有 pending marker 时直接返回当前安全模式态，不做任何检查、不写任何文件。
 */
export async function runPostUpdateHealthCheck(
  win: BrowserWindow | null
): Promise<{ ran: boolean; result: HealthCheckResult | null; safeMode: SafeModeState }> {
  const dir = markerDir(app.getPath("userData"));
  const pending = readPendingUpdate(dir);

  if (!pending) {
    // 没更新过也要有一条 last-known-good：否则用户第一次进安全模式时，
    // 「下载上一稳定版本」那个入口不知道该显示哪个版本号。
    //
    // 写失败**必须留痕**。这里早先是裸调用，实测表现是：marker 目录压根没建
    // 出来，而日志里一个字都没有 —— 诊断能力自己先成了盲区。
    try {
      writeLastKnownGood(dir, { version: app.getVersion(), verifiedAt: Date.now() });
    } catch (err) {
      log().warn("last_known_good_write_failed", { dir, error: String(err) });
    }
    return { ran: false, result: null, safeMode: safeModeState(dir) };
  }

  log().info("post_update_health_check_start", {
    fromVersion: pending.fromVersion,
    toVersion: pending.toVersion,
  });

  const result = await runStartupHealthCheck(electronProbes(win));
  const state = recordHealthResult(dir, result);

  if (result.ok) {
    writeLastKnownGood(dir, { version: app.getVersion(), verifiedAt: Date.now() });
    clearPendingUpdate(dir);
    log().info("post_update_health_check_ok", { durations: result.durations });
  } else {
    // pending marker 刻意保留：一次网络抖动不该被当成「这版坏了」，
    // 下次启动还要再验一遍。
    log().error("post_update_health_check_failed", {
      failed: result.failed,
      consecutiveFailures: state.consecutiveFailures,
      safeMode: state.active,
    });
  }

  return { ran: true, result, safeMode: state };
}
