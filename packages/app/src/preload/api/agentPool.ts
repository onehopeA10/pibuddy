/**
 * `window.piBuddy.agentPool`（AGT-101，第 19 个命名空间）。
 *
 * 渲染进程能表达的极限：取当前快照、聚焦某会话、停某会话、设资源上界，外加
 * 订阅快照推送。一律以不透明 sessionId 或一份资源上界为入参——既指定不了
 * 「让某进程跑什么」，也塞不进一个新会话规格（新建会话仍走 pi 命名空间）。
 *
 * 快照推送 `onSnapshot` 收到的是完整 `PiEnvelope<PoolSnapshot>`：preload 不剥壳，
 * generation/sequence 只有送到渲染进程才用得上（与 pi.events 同口径）。
 *
 * CHANNELS / PUSH_CHANNELS 只能从 `@pibuddy/contract/channels` 引（不依赖 zod）。
 */
import { CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract/channels";
import type { PiEnvelope, PoolCaps, PoolSnapshot } from "@pibuddy/contract";
import { invoke, subscribe } from "./bridge.js";

export const agentPool = {
  /** 取整池快照（会话列表、进程态、列表态、资源占用、统一权限 inbox）。 */
  describe: () => invoke<PoolSnapshot>(CHANNELS.agentPoolDescribe, {}),

  /** 聚焦某会话（null 表示无前台）。 */
  focus: (sessionId: string | null) =>
    invoke<PoolSnapshot>(CHANNELS.agentPoolFocus, { sessionId }),

  /** 用户主动停某会话进程（窗口关闭不走这里）。 */
  stop: (sessionId: string) => invoke<PoolSnapshot>(CHANNELS.agentPoolStop, { sessionId }),

  /** 设置资源上界。 */
  setCaps: (caps: PoolCaps) => invoke<PoolSnapshot>(CHANNELS.agentPoolSetCaps, caps),

  /** 订阅池快照推送（PiEnvelope<PoolSnapshot>），返回退订闭包。 */
  onSnapshot: (cb: (e: PiEnvelope<PoolSnapshot>) => void) =>
    subscribe(PUSH_CHANNELS.agentPoolEvent, cb as (p: unknown) => void),
};
