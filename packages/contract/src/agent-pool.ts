/**
 * 后台多会话池的契约（AGT-101 第一批）。
 *
 * ## 这个文件在回答什么
 *
 * `pi/ports.ts` 的 `PiRuntimeSupervisor` 回答「一个 pi 子进程怎么起、怎么停」，
 * 是**单个** runtime 的生命周期。本文件回答的是上一层：**同时存在多个会话进程
 * 时，谁在跑、谁在后台、谁该被回收、谁崩了、并发与资源的上界是多少**。
 *
 * 池是**平台内核**设施（ADR-0002 四层边界表第一行「会话 / runtime」），因此它的
 * 通道恒注册、不受任何能力开关影响——把能力全关掉不该连带关掉会话监督面。
 *
 * ## 为什么复用 PiEnvelope 而不是新造推送格式
 *
 * 快照推送（`agent-pool:event`）走的是与 `pi:event` 同一套 `PiEnvelope`
 * 信封：渲染侧因此能复用现成的 generation（全局判）+ sequence（按通道单调判）
 * 丢弃规则（envelope.ts 的 `shouldAcceptEnvelope`），不必再写第二份序号比较。
 * 快照的 sequence 单调递增，任一窗口拿到一份快照后即可对齐，晚到的旧快照被
 * 序号闸门丢弃。这正是「snapshot + sequence 订阅」的落点。
 *
 * ## child Agent 本批不做
 *
 * 本文件只定义「池」的形态，不含任何 parent/child 编排字段。child 编排的预留
 * 接口在 main 侧（`agent-pool/pool-core.ts` 的 `PoolRuntimeHost` 与
 * `requestSession` 的 `origin` 入参），契约层这里刻意保持中立。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

// ---------------------------------------------------------------- 进程生命周期态

/**
 * 一个池内会话的**进程**生命周期态。
 *
 *   - `focused`     —— 用户当前正看着的会话，前台活跃；同一时刻至多一个。
 *   - `background`  —— 进程活跃、任务在跑或刚跑过，只是不在前台。
 *   - `warm`        —— 空闲被回收成「热备」：进程还在，但已被标记为可停候选，
 *                      保留它是为了避免冷启动（switch_session 读大 JSONL 很慢）。
 *   - `stopped`     —— 进程已终止（空闲回收到底 / 用户主动停 / 应用退出）。
 *                      **窗口关闭不会走到这里**——窗口关闭 ≠ 任务停止。
 *   - `crashed`     —— 进程意外退出且崩溃预算已耗尽，放弃自动恢复，等用户重启。
 */
export const POOL_RUN_STATES = ["focused", "background", "warm", "stopped", "crashed"] as const;
export type PoolRunState = (typeof POOL_RUN_STATES)[number];
export const poolRunStateSchema = z.enum(POOL_RUN_STATES);

/** 进程是否占着一个真实 runtime（用于并发/内存计数）。 */
export function isLiveRunState(state: PoolRunState): boolean {
  return state === "focused" || state === "background" || state === "warm";
}

// ---------------------------------------------------------------- 列表任务态

/**
 * 会话在列表里的**任务**态（与进程态正交）。
 *
 * 一个 `background` 进程可以是 `running`（正在干活）也可以是 `done`（干完了
 * 等在那儿）。列表态驱动系统通知与未读标记。
 *
 *   - `idle`               —— 没有进行中的任务。
 *   - `running`            —— agent 正在处理。
 *   - `waiting_permission` —— 卡在一条待裁决的权限上（见 inbox）。
 *   - `failed`             —— 上一轮以错误收场（或崩溃放弃）。
 *   - `done`              —— 上一轮正常结束。
 */
export const POOL_LIST_STATES = ["idle", "running", "waiting_permission", "failed", "done"] as const;
export type PoolListState = (typeof POOL_LIST_STATES)[number];
export const poolListStateSchema = z.enum(POOL_LIST_STATES);

// ---------------------------------------------------------------- 资源上界

/**
 * 池的资源上界（防止一个用户开 100 个会话打爆机器）。
 *
 * 全局并发、每 workspace 并发、内存与成本各有独立上界。超过上界的新会话进入
 * 公平排队（FIFO），而不是被直接拒绝——被拒绝会让「我明明点了新建」变成一个
 * 说不清的现象。
 */
export const poolCapsSchema = z
  .object({
    /** 全局同时活跃（focused+background+warm）会话进程数上界。 */
    maxConcurrent: z.number().int().positive(),
    /** 单个 workspace 内同时活跃会话进程数上界。 */
    maxPerWorkspace: z.number().int().positive(),
    /** 估算总内存上界（MB）。超过后新会话不被准入，直到有会话被回收。 */
    memoryCeilingMb: z.number().nonnegative(),
    /** 累计成本上界（USD）。超过后新会话不被准入。 */
    costCeilingUsd: z.number().nonnegative(),
  })
  .strict();
export type PoolCaps = z.infer<typeof poolCapsSchema>;

/**
 * 默认上界。取值刻意保守：一个普通用户不会同时盯着 4 个以上会话，而每个
 * pi 子进程 + node runtime 常驻在 150~250MB 量级，1600MB 给约 6~8 个留了余量。
 */
export const DEFAULT_POOL_CAPS: PoolCaps = {
  maxConcurrent: 4,
  maxPerWorkspace: 3,
  memoryCeilingMb: 1600,
  costCeilingUsd: 20,
};

// ---------------------------------------------------------------- 单会话视图

/** 快照里的一条会话视图（下发给渲染进程，一律不含磁盘路径）。 */
export const poolSessionViewSchema = z
  .object({
    sessionId: z.string().min(1),
    /** 工作区不透明标识；尚未握手到会话时可能为 null。 */
    workspaceId: z.string().min(1).nullable(),
    runtimeId: z.string(),
    generation: z.number().int().nonnegative(),
    runState: poolRunStateSchema,
    listState: poolListStateSchema,
    /** 后台会话有新进展但用户没看过。focused 会话恒 false。 */
    unread: z.boolean(),
    /** 估算内存占用（MB）。stopped/crashed 为 0。 */
    memoryMb: z.number().nonnegative(),
    /** 会话累计成本（USD）。 */
    costUsd: z.number().nonnegative(),
    /** 崩溃计数（用于崩溃预算展示）。 */
    crashCount: z.number().int().nonnegative(),
    /** 最近一次活动的 Unix 毫秒（用于空闲回收判定）。 */
    lastActivityAt: z.number().int().nonnegative(),
    /** 因触及上界而在准入队列里等待（尚未拿到进程）。 */
    queued: z.boolean(),
  })
  .strict();
export type PoolSessionView = z.infer<typeof poolSessionViewSchema>;

// ---------------------------------------------------------------- 统一权限 inbox

/**
 * 统一权限 inbox 的一条待办。
 *
 * 后台会话的权限请求不弹前台模态框（用户可能正看着别的会话），而是进这张
 * 统一表。**无人响应默认等待，超时拒绝，绝不自动允许**——超时的 deadline
 * 到点后由池 tick 自动记为 deny 并移除。裁决走既有权限引擎（decidePermission），
 * 池只负责「把待办排进来、超时清掉」。
 */
export const poolInboxItemSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    workspaceId: z.string().min(1).nullable(),
    capabilityId: z.string().min(1),
    permission: z.string().min(1),
    resource: z.string().min(1).nullable(),
    requestedAt: z.number().int().nonnegative(),
    /** 超时 deadline（Unix 毫秒）。到点未响应 → 拒绝。 */
    deadlineAt: z.number().int().nonnegative(),
  })
  .strict();
export type PoolInboxItem = z.infer<typeof poolInboxItemSchema>;

// ---------------------------------------------------------------- 池快照

/**
 * 整池快照。
 *
 * `sequence` 单调递增，是「snapshot + sequence 订阅」的对齐点：任一窗口拿到
 * 一份快照即代表当时的全量真相，晚到的旧快照被序号闸门丢弃。
 */
export const poolSnapshotSchema = z
  .object({
    /** 单调递增的快照序号（每次变更 +1）。 */
    sequence: z.number().int().nonnegative(),
    caps: poolCapsSchema,
    sessions: z.array(poolSessionViewSchema),
    /** 占用真实进程的会话数（focused+background+warm）。 */
    activeCount: z.number().int().nonnegative(),
    /** 在准入队列里等待的会话数。 */
    queuedCount: z.number().int().nonnegative(),
    totalMemoryMb: z.number().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    inbox: z.array(poolInboxItemSchema),
  })
  .strict();
export type PoolSnapshot = z.infer<typeof poolSnapshotSchema>;

/** 池快照信封里填的固定上下文（快照不属于任何单个会话/runtime）。 */
export const POOL_ENVELOPE_ID = "__agent-pool__";
/** 池信封的固定代际（池活在整个应用运行期，不换代）。 */
export const POOL_ENVELOPE_GENERATION = 1;

// ---------------------------------------------------------------- 通道入参

export const poolFocusRequestSchema = z
  .object({ sessionId: z.string().min(1).nullable().default(null) })
  .strict();
export type PoolFocusRequest = z.infer<typeof poolFocusRequestSchema>;

export const poolStopRequestSchema = z
  .object({ sessionId: z.string().min(1) })
  .strict();
export type PoolStopRequest = z.infer<typeof poolStopRequestSchema>;

/**
 * 设置资源上界。四项全给，避免「只改一项时另外三项被 undefined 覆盖」这类
 * 半更新歧义——渲染侧读现值、改一项、整份回传。
 */
export const poolSetCapsRequestSchema = poolCapsSchema;
export type PoolSetCapsRequest = z.infer<typeof poolSetCapsRequestSchema>;

export const poolDescribeRequestSchema = z.object({}).strict();
export type PoolDescribeRequest = z.infer<typeof poolDescribeRequestSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * 后台会话池的四条内核通道 + 一条快照推送。
 *
 * 池是平台内核设施（不可关闭），四条恒注册。渲染进程能表达的极限是「给我
 * 当前快照」「聚焦到某个会话」「停掉某个会话」「设资源上界」——一律以不透明
 * sessionId 为入参，既指定不了别的进程该跑什么，也塞不进一个新会话规格
 * （新建会话仍走既有 `pi:start` 的产品路径，池只是观测与调度）。
 */
export const agentPoolContractShard = defineContractShard("kernel-agent-pool", {
  [CHANNELS.agentPoolDescribe]: {
    request: poolDescribeRequestSchema,
    response: poolSnapshotSchema,
  },
  [CHANNELS.agentPoolFocus]: {
    request: poolFocusRequestSchema,
    response: poolSnapshotSchema,
  },
  [CHANNELS.agentPoolStop]: {
    request: poolStopRequestSchema,
    response: poolSnapshotSchema,
  },
  [CHANNELS.agentPoolSetCaps]: {
    request: poolSetCapsRequestSchema,
    response: poolSnapshotSchema,
  },
});
