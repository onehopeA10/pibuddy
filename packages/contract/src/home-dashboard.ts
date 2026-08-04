/**
 * 智能家居监控面板包的契约（home.dashboard / vertical tier）。
 *
 * ## 这个文件在回答什么
 *
 * `home.dashboard` 对外声明的三条窄通道 + 一条推送通道。它是 home.assistant
 * 基座之上的第一个消费者信令方（基座诚实遗留 #7）：**面板打开 = 向实体缓存
 * 登记一个引用计数消费者**（计数 > 0 期间基座维持 WS 实时订阅），关闭 = 释放
 * （归零后基座按 linger 拆线）。面板因此拿到的是活数据，而基座在没人看的
 * 时候不持有任何常驻连接。
 *
 * ## 为什么面板是只读的（v1 刻意不做控制按钮）
 *
 * 设备控制**不在** IPC 面上：控制走会话对话（pi 回路内工具
 * `home.assistant.call_service`，经主进程 tool bridge → safeLocalFetch 三道
 * 关）。面板做控制按钮意味着渲染进程多出一条「直接调 HA 服务」的通道——那
 * 正是基座刻意收掉的攻击面。v1 面板只有快照 + 增量，一条控制通道都没有。
 *
 * ## subscribe 的幂等语义（每 workspace 至多一个面板消费者）
 *
 * 窗口 reload 后渲染进程内存全没，而主进程侧的消费者登记还在。若 subscribe
 * 每次都新开一个消费者，一次 reload 就泄漏一个计数、WS 永不拆线。因此
 * subscribe 按 workspaceId 幂等：已登记时只刷新快照并沿用当前推送代际；
 * unsubscribe 释放该 workspace 的面板消费者。代价是「两个窗口开同一工作区
 * 面板、一个关掉」会让另一个也退回 REST TTL 轮询口径——数据仍然正确，只是
 * 不再实时，可接受且如实。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";
import { haEntityRowSchema } from "./home-assistant.js";

export const HOME_DASHBOARD_CAPABILITY_ID = "home.dashboard";

// ---------------------------------------------------------------- 快照

/** 面板一次能要到的实体上限（与 ha:entities 同口径：响应必须有界）。 */
export const DASHBOARD_SNAPSHOT_MAX = 500;

/**
 * 面板快照：实体行复用基座的 haEntityRow（id/name/domain/state/area）——
 * 面板按 area 分组、按 domain 归类图标，用的就是这五个字段，不另造形状。
 */
export const dashboardSnapshotSchema = z
  .object({
    entities: z.array(haEntityRowSchema),
    /** 缓存里的实体总数（entities 只是其中一段） */
    total: z.number().int().nonnegative(),
    /** true = 断线未 resync / 冷启动快照（面板据此显示 stale 横幅） */
    stale: z.boolean(),
    /** live = REST/WS 活数据；snapshot = sqlite 冷启动快照（无状态值） */
    source: z.enum(["live", "snapshot"]),
  })
  .strict();
export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;

export const dashboardSnapshotRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    limit: z.number().int().positive().max(DASHBOARD_SNAPSHOT_MAX).default(DASHBOARD_SNAPSHOT_MAX),
  })
  .strict();
export type DashboardSnapshotRequest = z.infer<typeof dashboardSnapshotRequestSchema>;

// ---------------------------------------------------------------- 订阅

/** subscribe：登记面板消费者并原地返回当前快照（少一次往返，少一段空窗）。 */
export const dashboardSubscribeRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    limit: z.number().int().positive().max(DASHBOARD_SNAPSHOT_MAX).default(DASHBOARD_SNAPSHOT_MAX),
  })
  .strict();
export type DashboardSubscribeRequest = z.infer<typeof dashboardSubscribeRequestSchema>;

export const dashboardSubscribeResultSchema = z
  .object({
    /**
     * 本次订阅的推送代际：每建立一次面板消费者 +1。渲染侧用它喂
     * shouldAcceptEnvelope（代际优先 + 同代际序号严格递增），丢弃上一次
     * 订阅的迟到增量。
     */
    generation: z.number().int().nonnegative(),
    snapshot: dashboardSnapshotSchema,
  })
  .strict();
export type DashboardSubscribeResult = z.infer<typeof dashboardSubscribeResultSchema>;

export const dashboardUnsubscribeRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();
export type DashboardUnsubscribeRequest = z.infer<typeof dashboardUnsubscribeRequestSchema>;

/** released=false 表示该 workspace 本来就没有面板消费者（重复释放是幂等的）。 */
export const dashboardUnsubscribeResultSchema = z.object({ released: z.boolean() }).strict();
export type DashboardUnsubscribeResult = z.infer<typeof dashboardUnsubscribeResultSchema>;

// ---------------------------------------------------------------- 推送

/**
 * `dashboard:event` 的信封 payload（信封本身是 PiEnvelope，与 terminal:event
 * 同一套单向广播：sessionId 填 workspaceId、generation 填订阅代际、sequence
 * 按订阅单调递增）。
 *
 *   - state-changed：一条实体状态增量（state=null 表示实体被移除）；
 *   - link：链路状态翻转。stale=true 面板挂横幅；stale=false（重连 resync
 *     完成）时断线窗口内丢失的增量只能靠全量补——面板收到后应重拉一次快照。
 */
export const dashboardEventPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("state-changed"),
      entityId: z.string().min(1),
      /** 新状态；实体被移除时为 null */
      state: z.string().nullable(),
      /** friendly_name（新状态里带的话）；没有为 null */
      name: z.string().nullable(),
    })
    .strict(),
  z.object({ type: z.literal("link"), stale: z.boolean() }).strict(),
]);
export type DashboardEventPayload = z.infer<typeof dashboardEventPayloadSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `home.dashboard` 的全部三条 invoke 通道。
 *
 * 分片 id 是 capabilityId 的第二段（`home.dashboard` → `dashboard`），drift
 * test 据此把「manifest 声明的通道」与「本分片的键集合」逐条对账。
 */
export const homeDashboardContractShard = defineContractShard("dashboard", {
  [CHANNELS.dashboardSubscribe]: {
    request: dashboardSubscribeRequestSchema,
    response: dashboardSubscribeResultSchema,
  },
  [CHANNELS.dashboardUnsubscribe]: {
    request: dashboardUnsubscribeRequestSchema,
    response: dashboardUnsubscribeResultSchema,
  },
  [CHANNELS.dashboardSnapshot]: {
    request: dashboardSnapshotRequestSchema,
    response: dashboardSnapshotSchema,
  },
});
