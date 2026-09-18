import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { registerIpc, disposeClientFor } from "./ipc.js";
import { disposeAllWorkspaceResources } from "./workspace/workspace-ipc.js";
// 全应用共享的 logger（内核设施，在 whenReady 之后才可用：依赖 userData 路径）。
// 早先这里另起了一个惰性实例，与 pi 域那一个并存 —— 同一个目录被两个实例
// 各自算着 written 字节数，轮转判定因此各算各的。现在只有 log.ts 一处。
import { log } from "./log.js";
import { runPostUpdateHealthCheck } from "./health/startup-health.js";
import { applyWindowPolicy } from "./security/window-policy.js";
import { armUpdateChecks, disposeUpdateService } from "./update/update-ipc.js";
// 远程访问（connector.remote）：按持久配置恢复服务（若上次开着），退出时拆监听。
// 从没配过远程的用户，restore 一个字节都不碰（默认对外零暴露）。
import { disposeRemoteResources, restoreRemoteServerIfEnabled } from "./remote/remote-manager.js";
// 智能家居基座（home.assistant）：退出时收 tool bridge 的 named pipe 监听、
// WS 会话与 sqlite 句柄。能力未启用时这些资源本来就不存在，dispose 是空转。
import { disposeHomeResources } from "./home/home-ipc.js";
// 能力包 pi 资源装卸（R4）：接线薄层，物化器本体是纯逻辑（capability-assets.ts）。
import { syncCapabilityAssetsOnStartup } from "./capability/capability-assets-wiring.js";
// 后台会话池：应用退出时必须把全部后台 pi runtime 收掉（窗口关闭 ≠ 停止，但
// window-all-closed 在本应用即退出路径）。池状态机与派生 host 各收各的：
// shutdownAll 走池的记账 + host.stop，stopAll 兜底清掉池外/迟到的 runtime。
import { agentPool, poolRuntimeHost } from "./agent-pool/pool.js";
// 备份恢复的套用点（BKP-101）。必须跑在 registerIpc() 之前：那之后任意一个
// store 都可能被打开，而 Windows 上对已打开的 sqlite 文件 rename 覆盖会 EPERM，
// 表现是「恢复成功了但数据没变」。
import { applyPendingRestoreOnStartup } from "./backup/backup-ipc.js";
import { disposeMcpResources } from "./mcp/mcp-ipc.js";
import { disposePackageCommands } from "./pi-resources/package-install.js";
import { shutdownTasksResources } from "./tasks/tasks-ipc.js";
import { loadSettings, saveSettings } from "./settings.js";
import { themeChrome, TITLE_BAR_HEIGHT } from "./theme-chrome.js";
import { decideClose, promptCloseChoice } from "./close-behavior.js";
import {
  destroyAppTray,
  hideWindowToTray,
  revealMainWindow,
  resolveAppIconPath,
} from "./app-tray.js";

let applicationShutdown: Promise<void> | null = null;
let quitting = false;
let askingClose = false;

function requestQuit(): void {
  quitting = true;
  destroyAppTray();
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    void shutdownApplication();
    return;
  }
  for (const win of windows) win.close();
}

function trayHandlers(): { onShow: () => void; onQuit: () => void } {
  return {
    onShow: () => {
      revealMainWindow();
    },
    onQuit: () => requestQuit(),
  };
}

function shutdownApplication(): Promise<void> {
  if (applicationShutdown) return applicationShutdown;
  applicationShutdown = Promise.resolve().then(async () => {
    try {
      await shutdownTasksResources();
    } catch (err) {
      log().warn("tasks_shutdown_failed", { error: String(err) });
    }

    // 从这里开始才允许扫池：tasks 的 abort/finally 已经停完它拥有的 runtime，
    // 因而 expected-stop 不可能在池清空之后再触发一次 retry 复活进程。
    disposeUpdateService();
    disposeAllWorkspaceResources();
    agentPool().shutdownAll();
    poolRuntimeHost().stopAll();
    disposeMcpResources();
    disposePackageCommands();
    try {
      await disposeRemoteResources();
    } catch (err) {
      log().warn("remote_shutdown_failed", { error: String(err) });
    }
    disposeHomeResources();
    app.quit();
  });
  return applicationShutdown;
}

function createWindow(): void {
  // 窗口外壳颜色跟随设置里的配色（深 / 浅）；之后用户在设置里切换时由
  // misc-ipc 的 settings:set 调 applyThemeChrome 原地刷新。
  const chrome = themeChrome(loadSettings().theme);
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: "PiBuddy · AI 办公小助手",
    autoHideMenuBar: true,
    backgroundColor: chrome.backgroundColor,
    // 窗口 / 任务栏图标。dev 下从 build/ 读（electron-builder 的 buildResources
    // 目录），打包后由 electron-builder 内嵌进 exe，这里的路径仅影响 dev。
    icon: resolveAppIconPath(),
    // 隐藏系统标题栏：原生那条颜色由系统定，与应用主体割裂。
    // 渲染侧用 .app-header 自己画顶栏（同时是拖拽区），窗口的最小化 /
    // 最大化 / 关闭按钮由 Electron 以 overlay 形式画在右上角，颜色对齐
    // tokens.css 的 --bg-app / --text-primary（见 theme-chrome.ts）。
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: chrome.overlayColor,
      symbolColor: chrome.symbolColor,
      height: TITLE_BAR_HEIGHT,
    },
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
  applyWindowPolicy(win, { logger: log() });

  const wcId = win.webContents.id;
  win.on("close", (event) => {
    const decision = decideClose({
      quitting,
      action: loadSettings().closeAction,
    });
    if (decision === "allow-quit") {
      quitting = true;
      destroyAppTray();
      return;
    }
    event.preventDefault();
    if (decision === "hide-tray") {
      hideWindowToTray(win, trayHandlers());
      return;
    }
    if (askingClose) return;
    askingClose = true;
    void promptCloseChoice(
      {
        showMessageBox: (owner, opts) => dialog.showMessageBox(owner as BrowserWindow, opts),
        saveCloseAction: (action) => {
          saveSettings({ closeAction: action });
        },
      },
      win
    )
      .then((choice) => {
        askingClose = false;
        if (choice === "tray") hideWindowToTray(win, trayHandlers());
        else if (choice === "quit") requestQuit();
      })
      .catch((err: unknown) => {
        askingClose = false;
        log().warn("close_choice_failed", { error: String(err) });
      });
  });
  win.on("closed", () => {
    disposeClientFor(wcId);
    // 文件树 watcher 与搜索子进程都是**看不见的**泄漏：前者的表现是几小时后
    // 文件树停止刷新，后者的表现是任务管理器里越攒越多的子进程。两者都不
    // 报错，只能靠在这里显式收掉。
    disposeAllWorkspaceResources();
  });

  // 主窗口可交互之后才排更新检查（30s 后首检，见 UpdateService）。
  // 不在 whenReady 里排：那会儿主线程正忙着渲染首屏，一次网络请求足以
  // 让首帧再晚半秒。
  //
  // **两个事件都挂，先到者生效。** `ready-to-show` 不是一个有保证会触发的
  // 事件：窗口以默认 show:true 创建时，Electron 在某些平台/时序下不会再发它。
  // 实测现象是 armUpdateChecks() 与启动健康检查双双一次都没跑过，而日志里
  // 没有任何异常 —— 「自动更新为什么从来不检查」的答案就藏在这一行里。
  let windowReadyFired = false;
  const onWindowReady = (): void => {
    if (windowReadyFired) return;
    windowReadyFired = true;
    log().info("window_ready", { wcId });
    armUpdateChecks();
    // 更新之后的第一次启动才真的跑三项检查（判据是 pending-update marker）。
    // 失败不抛到调用栈上：健康检查本身把应用搞挂，是最难查的一类问题。
    void runPostUpdateHealthCheck(win)
      .then(({ ran, result, safeMode }) => {
        // 无条件记一行。只在 ran 为真时记的话，「健康检查根本没跑」和
        // 「跑了且一切正常」在日志上完全一样 —— 而这两者需要查的方向相反。
        log().info("startup_health", {
          ran,
          ok: result?.ok ?? null,
          failed: result?.failed ?? [],
          safeMode: safeMode.active,
        });
      })
      .catch((err: unknown) => {
        log().warn("startup_health_crashed", { error: String(err) });
      });
  };
  win.once("ready-to-show", onWindowReady);
  win.webContents.once("did-finish-load", onWindowReady);

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
    revealMainWindow();
  });

  void app.whenReady().then(async () => {
    log().info("app_ready", {
      version: app.getVersion(),
      platform: process.platform,
    });
    // 待套用的恢复（若有）在这里生效，**必须 await 且必须在 registerIpc 之前**。
    await applyPendingRestoreOnStartup();
    registerIpc();
    createWindow();
    // 能力装配已在 registerIpc() 里完成，此处 isCapabilityEnabled 可信。恢复须
    // 在窗口存在之后：远程「发 prompt」复用的是聚焦窗口的 runtime client。
    void restoreRemoteServerIfEnabled();
    // 能力包携带的 pi 资源装卸（REQ-0001 R4）：启用的物化到 ~/.pi/agent，
    // 停用的收回。同样要求装配已完成（读 currentResolution）；旁路动作，
    // 失败记日志不拦启动。
    void syncCapabilityAssetsOnStartup();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else revealMainWindow();
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    destroyAppTray();
  });

  app.on("window-all-closed", () => {
    void shutdownApplication();
  });
}
