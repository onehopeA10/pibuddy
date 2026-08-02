/**
 * `window.piBuddy.update`。
 *
 * 渲染进程在这里能表达的极限是九个意图 + 一个订阅。**没有** feed URL、
 * 没有 token、没有任何文件路径、没有 raw updater 句柄 —— 更新是唯一一个
 * 错了会砸掉用户数据的子系统，它的副作用整体收在主进程里。
 *
 * 九个动作全部返回 `UpdateState`：点完立刻拿到权威快照，不必等推送，
 * 「点了没反应」这类问题在结构上就不成立。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod）——
 * 理由见 bridge.ts 的注释：从主入口做值导入会把 140KB 的 zod 打进一个
 * 开着 sandbox 的安全边界，或者更糟，让整个 preload 静默失败。
 */
import { CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract/channels";
import type { UpdateChannel, UpdateState } from "@pibuddy/contract";
import { invoke, subscribe } from "./bridge.js";

export const update = {
  /** 权威快照。渲染进程挂载时**先取它**，再 onEvent 订阅。 */
  getState: () => invoke<UpdateState>(CHANNELS.updateGetState),

  checkForUpdates: (source: "manual" | "auto" | "startup" = "manual") =>
    invoke<UpdateState>(CHANNELS.updateCheck, { source }),

  downloadUpdate: () => invoke<UpdateState>(CHANNELS.updateDownload),

  cancelDownload: () => invoke<UpdateState>(CHANNELS.updateCancelDownload),

  /**
   * 安装并重启。
   * - `now`   立即（有阻断项时主进程会把清单回传，由界面三选一）
   * - `wait`  等任务结束后安装
   * - `force` 停止任务并安装
   */
  installAndRestart: (mode: "now" | "wait" | "force" = "now") =>
    invoke<UpdateState>(CHANNELS.updateInstall, { mode }),

  setUpdateChannel: (channel: UpdateChannel) =>
    invoke<UpdateState>(CHANNELS.updateSetChannel, { channel }),

  setAutoCheck: (enabled: boolean) =>
    invoke<UpdateState>(CHANNELS.updateSetAutoCheck, { enabled }),

  setAutoDownload: (enabled: boolean) =>
    invoke<UpdateState>(CHANNELS.updateSetAutoDownload, { enabled }),

  dismissVersion: (version: string) =>
    invoke<UpdateState>(CHANNELS.updateDismissVersion, { version }),

  /**
   * 订阅状态推送。payload 是完整的 UpdateEnvelope，**不剥壳**：
   * 代际与序号只有送到渲染进程才能用来丢弃陈旧帧。
   */
  onEvent: (callback: (envelope: unknown) => void) =>
    subscribe(PUSH_CHANNELS.updateEvent, callback),
};
