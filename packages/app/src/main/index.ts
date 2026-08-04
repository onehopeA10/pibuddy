import { app, BrowserWindow } from "electron";
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
  applyWindowPolicy(win, { logger: log() });

  const wcId = win.webContents.id;
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
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    log().info("app_ready", {
      version: app.getVersion(),
      platform: process.platform,
    });
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
    });
  });

  app.on("window-all-closed", () => {
    // 更新检查的定时器已经 unref 过，这里再显式拆一次：崩溃现场里
    // 「进程退不掉」的原因往往就是某个没人清的 timer。
    disposeUpdateService();
    disposeAllWorkspaceResources();
    // 后台池的全部 pi 子进程在退出前收掉——后台 runtime 没有窗口跟着陪葬，
    // 不显式停就是任务管理器里越攒越多的孤儿 pi 进程（ISS-002 生命周期收尾）。
    agentPool().shutdownAll();
    poolRuntimeHost().stopAll();
    // 显式停远程监听 + 关 sqlite 句柄：崩溃现场里「进程退不掉 / 端口没释放」
    // 的原因往往就是某个没人收的 listener。
    void disposeRemoteResources();
    // 家居基座的 named pipe 监听 / WS 会话 / sqlite 句柄同理显式收掉。
    disposeHomeResources();
    app.quit();
  });
}
