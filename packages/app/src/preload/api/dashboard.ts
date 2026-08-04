/**
 * `window.piBuddy.dashboard`（home.dashboard / 智能家居监控面板）。
 *
 * 三个方法、三条窄通道，外加一条增量推送订阅。渲染进程能表达的极限是
 * 「登记/释放当前工作区的面板消费者、读只读实体快照」——**没有**任何控制
 * 设备的入口：控制走会话对话（基座的 pi 回路内工具，经 tool bridge 三道关），
 * 面板是纯只读视图。
 *
 * `onEvent` 收到的是完整 `PiEnvelope<DashboardEventPayload>`：preload 不剥壳，
 * generation/sequence 只有送到渲染进程才用得上（与 terminal 同口径，配合
 * subscribe 返回的代际丢弃上一次订阅的迟到增量）。
 *
 * CHANNELS / PUSH_CHANNELS 只能从 `@pibuddy/contract/channels` 引（不依赖 zod）。
 */
import { CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract/channels";
import type {
  DashboardEventPayload,
  DashboardSnapshot,
  DashboardSubscribeResult,
  DashboardUnsubscribeResult,
  PiEnvelope,
} from "@pibuddy/contract";
import { invoke, subscribe } from "./bridge.js";

export const dashboard = {
  /** 登记面板消费者（按 workspaceId 幂等）并取当前快照 + 推送代际。 */
  subscribe: (workspaceId: string, limit = 500) =>
    invoke<DashboardSubscribeResult>(CHANNELS.dashboardSubscribe, { workspaceId, limit }),

  /** 释放面板消费者（重复释放幂等）。 */
  unsubscribe: (workspaceId: string) =>
    invoke<DashboardUnsubscribeResult>(CHANNELS.dashboardUnsubscribe, { workspaceId }),

  /** 只读快照（不登记消费者；resync 后重拉全量用）。 */
  snapshot: (workspaceId: string, limit = 500) =>
    invoke<DashboardSnapshot>(CHANNELS.dashboardSnapshot, { workspaceId, limit }),

  /** 订阅增量推送（PiEnvelope<DashboardEventPayload>），返回退订闭包。 */
  onEvent: (cb: (e: PiEnvelope<DashboardEventPayload>) => void) =>
    subscribe(PUSH_CHANNELS.dashboardEvent, cb as (p: unknown) => void),
};
