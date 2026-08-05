/**
 * 工具账本的**生产实例**：路径归属 + 全进程单例 + 一条共享的派发边界。
 *
 * recovery-store.ts 刻意不 import electron（真崩溃对拍要在裸 node 子进程里跑
 * 它），路径由接线方决定 —— 这里就是那个决定：`userData/tool-recovery.db`，
 * 与 tasks.db / automation.db 同一目录、同一口径。
 *
 * ## 为什么只有一个 boundary 实例
 *
 * 账本按 workspaceId 分区，但**协议标记**是「这个工作区的账本第一条」这件事，
 * 判断它需要读同一份账本。两个 boundary 各持一个 store 句柄同时写，第一条是
 * 谁就成了竞态。单例把这件事从「大家记得共用」变成「只有一个」。
 *
 * 循环闸也住在这个实例上：它是进程级的「同一调用连续失败几次」，跨 tasks /
 * automation / bridge 三条路共享是对的 —— 打转就是打转，换条路进来不该重置。
 */
import { app } from "electron";
import path from "node:path";

import { ToolDispatchBoundary } from "./dispatch-guard";
import { ToolRecoveryStore } from "./recovery-store";

let store: ToolRecoveryStore | null = null;
let boundary: ToolDispatchBoundary | null = null;

/** 全进程唯一的工具账本。首次访问时才建库。 */
export function toolRecoveryLedger(): ToolRecoveryStore {
  if (!store) store = new ToolRecoveryStore(path.join(app.getPath("userData"), "tool-recovery.db"));
  return store;
}

/** 全进程唯一的派发边界（T1/T2 + 护栏）。 */
export function toolDispatchBoundary(): ToolDispatchBoundary {
  if (!boundary) boundary = new ToolDispatchBoundary(toolRecoveryLedger());
  return boundary;
}

/**
 * 关句柄（应用退出 / 能力禁用）。**账本数据一个字节都不动**：它是「上次到底
 * 跑没跑」的唯一依据，卸载能力与删证据是两个动作。
 */
export function closeToolRecoveryLedger(): void {
  store?.close();
  store = null;
  boundary = null;
}
