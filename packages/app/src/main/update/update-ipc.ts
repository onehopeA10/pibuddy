/**
 * 更新子系统与 Electron 的接线层，以及九个 IPC handler。
 *
 * UpdateService 本身刻意不认识 electron —— 状态机、调度与去重都要能在纯
 * node 的 vitest 里被断言。真正的 `autoUpdater`、`app.getVersion()`、
 * 窗口广播、偏好落盘全部在这里注入。
 *
 * **本文件不出现 ipcMain.handle**：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame / schema / 尺寸 / 限流）因此对更新通道自动生效。
 */
import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import electronUpdater, { type AppUpdater } from "electron-updater";

import {
  CHANNELS,
  PUSH_CHANNELS,
  updateCheckRequestSchema,
  updateDismissRequestSchema,
  updateInstallRequestSchema,
  updateSetChannelRequestSchema,
  updateToggleRequestSchema,
  voidRequestSchema,
  type UpdateState,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import {
  createShutdownGate,
  defaultShutdownProbe,
  agentActivity,
} from "../lifecycle/graceful-shutdown.js";
import { writeJsonAtomic } from "../fs-atomic.js";
import { log } from "../pi/pi-ipc.js";
import { verifyBeforeInstall } from "./release-integrity.js";
import { UpdateService } from "./update-service.js";
import {
  DEFAULT_UPDATE_PREFS,
  type CancellationTokenLike,
  type UpdaterLike,
  type UpdatePrefs,
  type UpdatePrefsStore,
} from "./update-types.js";

/**
 * electron-updater 是 CJS，`import { autoUpdater } from "electron-updater"`
 * 在 ESM 主进程里会拿到 undefined（具名导出解析不出来）。取默认导出再按需
 * 读属性是唯一能在打包产物里稳定工作的写法。
 *
 * **不在模块顶层解构 autoUpdater**：它是一个 lazy getter，第一次读就会
 * `new NsisUpdater()`，而那个构造函数会同步取 `app.getVersion()`。模块顶层
 * 解构等于「只要有人 import 了 ipc-registry，就必须先有一个完整可用的
 * electron app」—— 实测表现是 sessions-ipc 的单测整个文件跑不起来，堆栈里
 * 却只有一行 ElectronAppAdapter.get version。
 */
function updater(): AppUpdater {
  return electronUpdater.autoUpdater;
}

/**
 * 本版本 electron-updater 是否真的提供可用的取消能力。
 *
 * 读的是普通属性（不是 getter），因此模块加载期读它没有副作用。
 */
export const CANCEL_SUPPORTED = typeof electronUpdater.CancellationToken === "function";

// ---------------------------------------------------------------- 偏好落盘

function prefsPath(): string {
  return path.join(app.getPath("userData"), "update-prefs.json");
}

/**
 * 偏好落盘。
 *
 * 走 fs-atomic 的 writeJsonAtomic 而不是裸 writeFileSync：写到一半掉电时
 * 用户下次启动会拿到半截 JSON，于是 channel 与 dismiss 记录一起丢，
 * 那个已经被「稍后」过的版本会再弹一次。
 */
const diskPrefs: UpdatePrefsStore = {
  load(): UpdatePrefs {
    try {
      const raw = JSON.parse(fs.readFileSync(prefsPath(), "utf8")) as Partial<UpdatePrefs>;
      return { ...DEFAULT_UPDATE_PREFS, ...raw };
    } catch {
      return { ...DEFAULT_UPDATE_PREFS };
    }
  },
  save(prefs: UpdatePrefs): void {
    writeJsonAtomic(prefsPath(), prefs);
  },
};

// ---------------------------------------------------------------- 单例

let instance: UpdateService | null = null;

/**
 * 全应用唯一的 UpdateService。
 *
 * dev 下不给 fake feed 时，构造出来的服务状态恒为 `unsupported`，
 * 且**一次都不会**碰 setFeedURL / checkForUpdates —— 只要那条路存在，
 * 某次调试就可能把开发机指向真实 feed 并装下一个包。
 */
export function updateService(): UpdateService {
  if (instance) return instance;

  const logger = log().child({ mod: "updater" });
  const autoUpdater = updater();

  // electron-updater 自带 electron-log 风格的 logger 接口；这里接的是
  // PiBuddy 唯一的那个 logger（裁定4），不新建第二个日志器。
  autoUpdater.logger = {
    info: (m: unknown) => logger.info("updater", { msg: String(m) }),
    warn: (m: unknown) => logger.warn("updater", { msg: String(m) }),
    error: (m: unknown) => logger.error("updater", { msg: String(m) }),
    debug: (m: unknown) => logger.debug("updater", { msg: String(m) }),
  } as AppUpdater["logger"];

  const gate = createShutdownGate(defaultShutdownProbe(), agentActivity);

  instance = new UpdateService(
    {
      updater: autoUpdater as unknown as UpdaterLike,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      prefs: diskPrefs,
      logger,
      blockers: gate,
      broadcast,
      cancelSupported: CANCEL_SUPPORTED,
      createCancellationToken: CANCEL_SUPPORTED
        ? () => new electronUpdater.CancellationToken() as unknown as CancellationTokenLike
        : undefined,
      verifyBeforeInstall: (candidate) => verifyBeforeInstall(candidate),
      // 只有显式设置了这个环境变量才注入 fake provider；生产二进制里
      // 它不存在，因此这条分支在用户机器上恒不成立。
      fakeFeedUrl: process.env.PIBUDDY_FAKE_UPDATE_FEED ?? null,
    },
    // 代际取进程启动时刻：主进程重启后必然前进，窗口 reload 时不变，
    // 正好是 shouldAcceptEnvelope 需要的语义。
    Math.floor(Date.now() / 1000)
  );
  // 「更新怎么没反应」是这个子系统最常见的现场问题，而它的答案九成在这三个
  // 布尔量里。没有这一行的话，unsupported 与 idle 在日志上完全看不出区别。
  logger.info("update_service_created", {
    isPackaged: app.isPackaged,
    fakeFeed: Boolean(process.env.PIBUDDY_FAKE_UPDATE_FEED),
    status: instance.getState().status,
    cancelSupported: CANCEL_SUPPORTED,
  });
  return instance;
}

/** 推给全部存活窗口。窗口没订阅也不影响状态 —— 状态的真相在 service 里。 */
function broadcast(envelope: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(PUSH_CHANNELS.updateEvent, envelope);
  }
}

/** 主窗口可交互后调用：排 30 秒后的首次检查。 */
export function armUpdateChecks(): void {
  updateService().onWindowReady();
}

/** 退出前拆干净（定时器、idle 订阅、updater 监听器）。 */
export function disposeUpdateService(): void {
  instance?.dispose();
  instance = null;
}

// ---------------------------------------------------------------- handler

export function registerUpdateIpc(): void {
  const svc = (): UpdateService => updateService();

  registerHandler<void, UpdateState>(CHANNELS.updateGetState, voidRequestSchema, () =>
    svc().getState()
  );

  registerHandler(CHANNELS.updateCheck, updateCheckRequestSchema, (payload) =>
    svc().checkForUpdates(payload.source)
  );

  registerHandler<void, Promise<UpdateState>>(
    CHANNELS.updateDownload,
    voidRequestSchema,
    () => svc().downloadUpdate()
  );

  registerHandler<void, UpdateState>(CHANNELS.updateCancelDownload, voidRequestSchema, () =>
    svc().cancelDownload()
  );

  registerHandler(CHANNELS.updateInstall, updateInstallRequestSchema, (payload) =>
    svc().installAndRestart(payload.mode)
  );

  registerHandler(CHANNELS.updateSetChannel, updateSetChannelRequestSchema, (payload) =>
    svc().setChannel(payload.channel)
  );

  registerHandler(CHANNELS.updateSetAutoCheck, updateToggleRequestSchema, (payload) =>
    svc().setAutoCheck(payload.enabled)
  );

  registerHandler(CHANNELS.updateSetAutoDownload, updateToggleRequestSchema, (payload) =>
    svc().setAutoDownload(payload.enabled)
  );

  registerHandler(CHANNELS.updateDismissVersion, updateDismissRequestSchema, (payload) =>
    svc().dismissVersion(payload.version)
  );
}
