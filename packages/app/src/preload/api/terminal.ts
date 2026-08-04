/**
 * `window.piBuddy.terminal`（coding.terminal / PTY-101，第 25 个命名空间）。
 *
 * 十个方法、十条窄通道，外加一条输出推送订阅。渲染进程能表达的极限是「列出
 * 标签页 / 列出 shell / 开 / 输入 / 缩放 / 取快照 / 清屏 / 杀 / 重启 / 重命名」
 * ——**没有**任何能承载 cwd、shell 命令行或 argv 的形参，也没有
 * `invoke(channel, args)` 那种无约束入口（D4 规则 1）。真正 spawn shell 的地方
 * 在主进程（node-pty），cwd 是 workspace 的 canonical root，且每条通道都要
 * process.shell 授权：渲染进程即便被攻陷，也只能发出这十个意图之一，未授权时
 * 被主进程第五道闸挡下。
 *
 * 输出推送 `onEvent` 收到的是完整 `PiEnvelope<TerminalEventPayload>`：preload
 * 不剥壳，generation/sequence 只有送到渲染进程才用得上（与 agentPool / workflow
 * 同口径，用来丢弃上一代 PTY 的迟到输出）。
 *
 * CHANNELS / PUSH_CHANNELS 只能从 `@pibuddy/contract/channels` 引（不依赖 zod）。
 */
import { CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract/channels";
import type {
  PiEnvelope,
  TerminalActionResult,
  TerminalEventPayload,
  TerminalListResult,
  TerminalProfilesResult,
  TerminalSnapshotResult,
  TerminalTabMeta,
} from "@pibuddy/contract";
import { invoke, subscribe } from "./bridge.js";

export const terminal = {
  /** 列出某工作区当前的全部终端标签页。 */
  list: (workspaceId: string) =>
    invoke<TerminalListResult>(CHANNELS.terminalList, { workspaceId }),

  /** 列出本机可用的 shell profiles + 默认 profile id。 */
  profiles: (workspaceId: string) =>
    invoke<TerminalProfilesResult>(CHANNELS.terminalProfiles, { workspaceId }),

  /** 新开一个终端（在 workspace 目录下 spawn 一个 shell）。profileId 省略走默认。 */
  open: (workspaceId: string, profileId: string | null = null, cols = 80, rows = 24) =>
    invoke<TerminalTabMeta>(CHANNELS.terminalOpen, { workspaceId, profileId, cols, rows }),

  /** 写用户键入 / 粘贴的字节进 PTY 的 stdin。 */
  input: (workspaceId: string, tabId: string, data: string) =>
    invoke<TerminalActionResult>(CHANNELS.terminalInput, { workspaceId, tabId, data }),

  /** 调整 PTY 窗口尺寸。 */
  resize: (workspaceId: string, tabId: string, cols: number, rows: number) =>
    invoke<TerminalActionResult>(CHANNELS.terminalResize, { workspaceId, tabId, cols, rows }),

  /** 取 ring buffer 快照（reload 后重连重建屏幕）。 */
  snapshot: (workspaceId: string, tabId: string) =>
    invoke<TerminalSnapshotResult>(CHANNELS.terminalSnapshot, { workspaceId, tabId }),

  /** 清屏（清主进程 ring buffer；渲染侧另清自己的 xterm）。 */
  clear: (workspaceId: string, tabId: string) =>
    invoke<TerminalActionResult>(CHANNELS.terminalClear, { workspaceId, tabId }),

  /** 显式关闭一个 tab：杀 PTY 及其进程树并移除。 */
  kill: (workspaceId: string, tabId: string) =>
    invoke<TerminalActionResult>(CHANNELS.terminalKill, { workspaceId, tabId }),

  /** 重启：杀旧 PTY、代际 +1、用同样的 shell 重开。 */
  restart: (workspaceId: string, tabId: string) =>
    invoke<TerminalTabMeta>(CHANNELS.terminalRestart, { workspaceId, tabId }),

  /** 重命名 tab。 */
  rename: (workspaceId: string, tabId: string, title: string) =>
    invoke<TerminalTabMeta>(CHANNELS.terminalRename, { workspaceId, tabId, title }),

  /** 订阅终端输出 / 退出推送（PiEnvelope<TerminalEventPayload>），返回退订闭包。 */
  onEvent: (cb: (e: PiEnvelope<TerminalEventPayload>) => void) =>
    subscribe(PUSH_CHANNELS.terminalEvent, cb as (p: unknown) => void),
};
