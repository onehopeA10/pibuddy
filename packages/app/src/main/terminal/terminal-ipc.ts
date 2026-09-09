/**
 * 终端能力包的 IPC handler（coding.terminal / PTY-101 + R5.1 WSL）——**恰 11 条通道**。
 *
 * 全部以不透明 workspaceId + 不透明 tabId + 用户键入的字节为入参：真正 spawn
 * shell 的地方在 pty-manager（node-pty），cwd 是 workspace 的 canonical root
 * （本文件用 requireWorkspaceRoot 解析），渲染进程在结构上表达不出「用这个目录
 * 跑这条命令」。十条全部登记在 main/permission 的需求表里、需要 process.shell，
 * 未授权时被 ipc-guard 第五道闸挡在 handler 之外——连只读的 list/profiles/snapshot
 * 也不例外。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。它是
 * manifest 的 exposure.module，drift test 据 registerHandler 的通道集合与
 * manifest.channels 逐条对账。
 *
 * PTY 输出经 pty-manager 的 emitter 抛上来，这里包成复用 pi 那套的 PiEnvelope
 * （sessionId=tabId、generation=tab 代际、sequence=chunk 序号）广播到所有窗口的
 * `terminal:event`——渲染侧因此能用现成的 shouldAcceptEnvelope 丢弃上一代 PTY
 * 的迟到输出，reload 后再由 terminal:snapshot 重连。
 */
import {
  CHANNELS,
  PUSH_CHANNELS,
  terminalInputRequestSchema,
  terminalOpenRequestSchema,
  terminalRenameRequestSchema,
  terminalResizeRequestSchema,
  terminalTabRequestSchema,
  terminalWorkspaceRequestSchema,
  wrapEnvelope,
  type InvokeChannel,
  type TerminalTabMeta,
} from "@pibuddy/contract";
import { registerHandler } from "../ipc-guard.js";
import { fanoutToSubscribed } from "../window-fanout.js";
import { requireWorkspaceRoot } from "../workspace-registry.js";
import { ptyManager, type TerminalEmit } from "./pty-manager.js";
import { listWslDistros, wslTerminalProfiles } from "./wsl.js";

/** 本域注册的全部通道。drift test / 单测据它逐条对账。 */
export const TERMINAL_CHANNELS: InvokeChannel[] = [
  CHANNELS.terminalList,
  CHANNELS.terminalProfiles,
  CHANNELS.terminalOpen,
  CHANNELS.terminalInput,
  CHANNELS.terminalResize,
  CHANNELS.terminalSnapshot,
  CHANNELS.terminalClear,
  CHANNELS.terminalKill,
  CHANNELS.terminalRestart,
  CHANNELS.terminalRename,
  CHANNELS.terminalWslDistros,
];

/** 把 pty-manager 抛上来的一段输出 / 退出，包成 PiEnvelope 广播到所有窗口。 */
function broadcast(msg: TerminalEmit): void {
  const envelope = wrapEnvelope(
    {
      workspaceId: msg.workspaceId,
      // 信封的 sessionId / runtimeId 都用不透明 tabId：终端不是 pi 会话，这里
      // 借用信封的形状（代际 + 序号丢弃规则），字段语义就地映射成「哪个 tab」。
      sessionId: msg.tabId,
      runtimeId: msg.tabId,
      generation: msg.generation,
    },
    msg.sequence,
    msg.payload
  );
  fanoutToSubscribed(PUSH_CHANNELS.terminalEvent, envelope);
}

export function registerTerminalIpc(): void {
  ptyManager.setEmitter(broadcast);

  registerHandler(CHANNELS.terminalList, terminalWorkspaceRequestSchema, (payload) => ({
    tabs: ptyManager.list(payload.workspaceId),
  }));

  registerHandler(CHANNELS.terminalProfiles, terminalWorkspaceRequestSchema, async () => {
    // 本机 shell（同步）+ WSL 发行版（懒枚举 + 缓存，R5.1）。非 Windows / 无
    // WSL 时后者恒为空数组，返回形状与原先完全一致。默认 id 仍取本机第一个
    // shell：进 WSL 是显式选择，不做隐式默认。
    const base = ptyManager.listProfiles();
    const wsl = await wslTerminalProfiles();
    return { profiles: [...base.profiles, ...wsl], defaultId: base.defaultId };
  });

  // WSL 发行版查询（R5.1）。懒检测：只有这条通道 / profiles 被调用时才 spawn
  // `wsl.exe -l -v`；无 WSL 机器返回 {available:false} 而不抛错。
  registerHandler(CHANNELS.terminalWslDistros, terminalWorkspaceRequestSchema, () =>
    listWslDistros()
  );

  registerHandler(CHANNELS.terminalOpen, terminalOpenRequestSchema, (payload) => {
    // cwd 只由主进程从不透明 workspaceId 解析——渲染进程给不了路径。
    const cwd = requireWorkspaceRoot(payload.workspaceId);
    return ptyManager.open({
      workspaceId: payload.workspaceId,
      cwd,
      profileId: payload.profileId,
      cols: payload.cols,
      rows: payload.rows,
    });
  });

  registerHandler(CHANNELS.terminalInput, terminalInputRequestSchema, (payload) => {
    const ok = ptyManager.input(payload.workspaceId, payload.tabId, payload.data);
    return { ok, message: ok ? null : "终端不存在或已退出" };
  });

  registerHandler(CHANNELS.terminalResize, terminalResizeRequestSchema, (payload) => {
    const ok = ptyManager.resize(payload.workspaceId, payload.tabId, payload.cols, payload.rows);
    return { ok, message: ok ? null : "终端不存在" };
  });

  registerHandler(CHANNELS.terminalSnapshot, terminalTabRequestSchema, (payload) => {
    const snap = ptyManager.snapshot(payload.workspaceId, payload.tabId);
    return { tabId: payload.tabId, ...snap };
  });

  registerHandler(CHANNELS.terminalClear, terminalTabRequestSchema, (payload) => {
    const ok = ptyManager.clear(payload.workspaceId, payload.tabId);
    return { ok, message: ok ? null : "终端不存在" };
  });

  registerHandler(CHANNELS.terminalKill, terminalTabRequestSchema, (payload) => {
    const ok = ptyManager.kill(payload.workspaceId, payload.tabId);
    return { ok, message: ok ? null : "终端不存在" };
  });

  registerHandler(CHANNELS.terminalRestart, terminalTabRequestSchema, (payload): TerminalTabMeta => {
    const meta = ptyManager.restart(payload.workspaceId, payload.tabId);
    if (!meta) throw new Error(`TERMINAL_TAB_UNKNOWN: ${payload.tabId}`);
    return meta;
  });

  registerHandler(CHANNELS.terminalRename, terminalRenameRequestSchema, (payload): TerminalTabMeta => {
    const meta = ptyManager.rename(payload.workspaceId, payload.tabId, payload.title);
    if (!meta) throw new Error(`TERMINAL_TAB_UNKNOWN: ${payload.tabId}`);
    return meta;
  });
}

/**
 * 拆卸本能力的运行期资源（ADR-0002 D4 规则 4）。
 *
 * 摘掉广播、杀掉全部在册 PTY 及其进程树（不留孤儿终端进程）。**磁盘上一个
 * 字节不动**——终端本就不持有用户数据，这里只收「还在跑的 shell 子进程」。
 */
export function disposeTerminalResources(): void {
  ptyManager.setEmitter(null);
  ptyManager.disposeAll();
}
