/**
 * 持久定时任务（Durable Tasks，AUT-101 第一批）的决策契约。
 *
 * ## 这个文件在回答什么
 *
 * 「一个定时任务对外声明了什么」——它的计划（once/daily/weekly/cron/event）、
 * 时区、要触发的 Agent run、它**需要**哪些能力权限、预算 / 超时 / 失败与错过
 * 策略；以及一次 run 的完整状态（独立 id、输入快照、attempt、费用、会话、
 * 产物、日志）。声明是一份纯数据，因此它可以被校验、被 diff、被 grep。
 *
 * ## 时间是这块唯一真正的难点，因此时区是一等公民
 *
 * 定时任务的全部已知坑都在时间处理：DST 切换、时钟回拨、错过的运行、
 * sleep/wake。`daily` / `weekly` / `cron` 存的是**墙钟时间 + IANA 时区**，
 * 而不是一个绝对 epoch —— 因为「每天 9:00」在 DST 边界上对应的 epoch 每年
 * 变两次，把它冻成一个 epoch 就等于在切换那天错点。绝对时刻由主进程侧的
 * `computeNextRun`（可注入时钟）在每次调度时按时区重新解出来。
 *
 * ## 为什么 requiredPermissions 与能力 manifest 的 permissions 是两个轴
 *
 * manifest.permissions 说的是「tasks 这个能力自己的代码用到哪类权限」（几乎
 * 为空——它只调度，不直接执行危险动作）。本文件的 `requiredPermissions` 是
 * **每个任务**声明「我触发的那次 run 可能需要哪些能力权限」。无人值守的定时
 * run **只认 workspace（预授权、落盘）授权**，绝不继承交互会话的 allow-once /
 * allow-session（那等于绕开人工确认）。这条判定在主进程侧的 `task-permission`
 * 里做，本文件只定义数据形态。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

/** 任务 / run 数据自有的代际（迁移时按它决定要不要动老数据）。 */
export const TASKS_DATA_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- 计划

/** `HH:MM`（24 小时制墙钟时间）。 */
export const WALL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * 计划类型。
 *
 * `once` 存绝对 epoch（一次性，没有「下一次」的墙钟语义）；`daily` / `weekly`
 * / `cron` 存墙钟 + 时区；`event` 不由时钟驱动，等外部事件投递（本批把触发
 * 做成清晰的待接线点）。
 */
export const taskScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("daily"), time: z.string().regex(WALL_TIME_RE) }).strict(),
  z
    .object({
      kind: z.literal("weekly"),
      /** 0=周日 … 6=周六，至少一个 */
      weekdays: z.array(z.number().int().min(0).max(6)).min(1),
      time: z.string().regex(WALL_TIME_RE),
    })
    .strict(),
  z.object({ kind: z.literal("cron"), expression: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("event"), event: z.string().min(1) }).strict(),
]);
export type TaskSchedule = z.infer<typeof taskScheduleSchema>;

// ---------------------------------------------------------------- 策略

/**
 * 错过运行（missed run）的处理策略。
 *
 * App 关闭、系统 sleep、时钟被拨过、DST 落回——都会让某些原定运行「错过」。
 * 这三档由**用户**在建任务时选，而不是系统替他决定：
 *   - `skip`     —— 跳过错过的，只从现在起算下一次（幂等性未知时最安全）；
 *   - `run-once` —— 错过再多次，也只补跑一次（去重的补偿）；
 *   - `catch-up` —— 逐个补跑错过的每一次（只有幂等 action 才该选）。
 *
 * **绝不能重复执行非幂等 action**：因此 catch-up 的每一次补跑都带独立的
 * idempotency key（taskId + 那一次的墙钟槽位），scheduler 侧据它去重。
 */
export const MISFIRE_POLICIES = ["skip", "run-once", "catch-up"] as const;
export type MisfirePolicy = (typeof MISFIRE_POLICIES)[number];
export const misfirePolicySchema = z.enum(MISFIRE_POLICIES);

/**
 * 并发策略：上一次还没跑完，又到点了怎么办。
 *   - `allow`  —— 允许并发（多个 run 同时在跑）；
 *   - `forbid` —— 跳过这一次（上一次没结束就不开新的）；
 *   - `queue`  —— 排队，等上一次结束再依次跑。
 */
export const CONCURRENCY_POLICIES = ["allow", "forbid", "queue"] as const;
export type ConcurrencyPolicy = (typeof CONCURRENCY_POLICIES)[number];
export const concurrencyPolicySchema = z.enum(CONCURRENCY_POLICIES);

/** 失败重试策略。maxAttempts 含首次尝试。 */
export const failurePolicySchema = z
  .object({
    retry: z.boolean(),
    /** 含首次；retry=false 时恒为 1 */
    maxAttempts: z.number().int().min(1).max(10),
    /** 每次重试前的退避（ms） */
    backoffMs: z.number().int().nonnegative(),
  })
  .strict();
export type FailurePolicy = z.infer<typeof failurePolicySchema>;

/** 要触发的 Agent run 的配置（输入侧）。 */
export const taskAgentSchema = z
  .object({
    /** Provider（如 openai / anthropic）；空串表示用工作区默认 */
    provider: z.string(),
    /** 模型 id；空串表示用工作区默认 */
    model: z.string(),
    /** 要发给 Agent 的提示词 */
    prompt: z.string().min(1),
  })
  .strict();
export type TaskAgent = z.infer<typeof taskAgentSchema>;

// ---------------------------------------------------------------- 任务

export const TASK_STATUSES = ["active", "paused"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * 一条定时任务的完整记录（下发给渲染进程的形态）。
 *
 * `timezone` / `nextRunAt` / `workspaceId` / `agent` / `requiredPermissions` /
 * `budgetUsd` / `timeoutMs` / `failurePolicy` 全部外发——「保存时显示时区、
 * 下一次运行、workspace、Agent、Provider、权限、预算、超时、失败策略」这条
 * 需求就是它们。
 */
export const taskRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    schedule: taskScheduleSchema,
    /** IANA 时区（如 "Asia/Shanghai"）；once/event 也存，仅用于显示 */
    timezone: z.string().min(1),
    agent: taskAgentSchema,
    /** 这次 run 可能用到的能力权限（决定它是否需要预授权） */
    requiredPermissions: z.array(z.string()).readonly(),
    /** 预算上限（美元）；null 表示不限 */
    budgetUsd: z.number().nonnegative().nullable(),
    /** 单次 run 超时（ms）；null 表示不限 */
    timeoutMs: z.number().int().positive().nullable(),
    misfirePolicy: misfirePolicySchema,
    concurrencyPolicy: concurrencyPolicySchema,
    failurePolicy: failurePolicySchema,
    status: z.enum(TASK_STATUSES),
    /** 下一次绝对运行时刻（epoch ms）；paused / event / 无更多运行时为 null */
    nextRunAt: z.number().int().nonnegative().nullable(),
    /** 上一次实际触发时刻；从未跑过为 null */
    lastRunAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type TaskRecord = z.infer<typeof taskRecordSchema>;

// ---------------------------------------------------------------- run

export const RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 触发时冻结的输入快照——run 跑的是这一份，之后改任务不影响在途 run。 */
export const runInputSnapshotSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    prompt: z.string(),
  })
  .strict();
export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;

/**
 * 一次 run 的记录。
 *
 * `idempotencyKey` 是去重的键（taskId + 那一次的墙钟槽位）：时钟回拨、双重
 * 触发、catch-up 补跑都可能对同一个槽位产生第二次尝试，scheduler 据它保证
 * **非幂等 action 不被重复执行**。
 */
export const runRecordSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    workspaceId: z.string().min(1),
    status: z.enum(RUN_STATUSES),
    /** 这次 run 对应的原定时刻（墙钟槽位解出的 epoch）；run-now 为触发时刻 */
    scheduledFor: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1),
    /** 第几次尝试（含首次，从 1 起） */
    attempt: z.number().int().min(1),
    startedAt: z.number().int().nonnegative().nullable(),
    finishedAt: z.number().int().nonnegative().nullable(),
    input: runInputSnapshotSchema,
    /** Agent 会话 id（触发成功后回填）；未接线时为 null */
    sessionId: z.string().nullable(),
    /** 产物 id 列表 */
    artifactIds: z.array(z.string()).readonly(),
    /** 本次费用（美元）；未知为 null */
    costUsd: z.number().nonnegative().nullable(),
    /** 失败 / 跳过 / 拦截原因；成功为 null */
    error: z.string().nullable(),
    /** 供人读的日志行 */
    log: z.array(z.string()).readonly(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type RunRecord = z.infer<typeof runRecordSchema>;

/** 任务详情：任务本体 + 它最近的 run 列表。 */
export const taskDetailSchema = z
  .object({
    task: taskRecordSchema,
    runs: z.array(runRecordSchema),
  })
  .strict();
export type TaskDetail = z.infer<typeof taskDetailSchema>;

// ---------------------------------------------------------------- 通道入参

/** 建任务的入参（无 id / 无派生字段：id、nextRunAt 由主进程算）。 */
export const taskCreateRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    schedule: taskScheduleSchema,
    timezone: z.string().min(1),
    agent: taskAgentSchema,
    requiredPermissions: z.array(z.string()).default([]),
    budgetUsd: z.number().nonnegative().nullable().default(null),
    timeoutMs: z.number().int().positive().nullable().default(null),
    misfirePolicy: misfirePolicySchema.default("skip"),
    concurrencyPolicy: concurrencyPolicySchema.default("forbid"),
    failurePolicy: failurePolicySchema.default({ retry: false, maxAttempts: 1, backoffMs: 0 }),
  })
  .strict();
export type TaskCreateRequest = z.infer<typeof taskCreateRequestSchema>;

/** 改任务：id 必填，其余字段可选（只改传进来的）。 */
export const taskUpdateRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    schedule: taskScheduleSchema.optional(),
    timezone: z.string().min(1).optional(),
    agent: taskAgentSchema.optional(),
    requiredPermissions: z.array(z.string()).optional(),
    budgetUsd: z.number().nonnegative().nullable().optional(),
    timeoutMs: z.number().int().positive().nullable().optional(),
    misfirePolicy: misfirePolicySchema.optional(),
    concurrencyPolicy: concurrencyPolicySchema.optional(),
    failurePolicy: failurePolicySchema.optional(),
  })
  .strict();
export type TaskUpdateRequest = z.infer<typeof taskUpdateRequestSchema>;

/** 只带 workspaceId 的列表入参。 */
export const taskListRequestSchema = z.object({ workspaceId: z.string().min(1) }).strict();
export type TaskListRequest = z.infer<typeof taskListRequestSchema>;

/** 定位一条任务。 */
export const taskIdRequestSchema = z
  .object({ workspaceId: z.string().min(1), id: z.string().min(1) })
  .strict();
export type TaskIdRequest = z.infer<typeof taskIdRequestSchema>;

/** 定位一条 run（取消 / 重试）。 */
export const runIdRequestSchema = z
  .object({ workspaceId: z.string().min(1), taskId: z.string().min(1), runId: z.string().min(1) })
  .strict();
export type RunIdRequest = z.infer<typeof runIdRequestSchema>;

/** 列表结果：每条任务 + 它需要但尚未预授权的权限（供界面提示「等待授权」）。 */
export const taskListItemSchema = z
  .object({
    task: taskRecordSchema,
    /** requiredPermissions 里当前 workspace 尚未落盘授权的那些；空数组=已就绪 */
    missingPermissions: z.array(z.string()).readonly(),
    /** 最近一次 run 的状态（无 run 为 null） */
    lastRunStatus: z.enum(RUN_STATUSES).nullable(),
  })
  .strict();
export type TaskListItem = z.infer<typeof taskListItemSchema>;

export const taskListResultSchema = z.object({ items: z.array(taskListItemSchema) }).strict();
export type TaskListResult = z.infer<typeof taskListResultSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * 定时任务的通道分片（能力 `common.tasks`）。
 *
 * 分片 id 恰是 capabilityId 的第二段（`common.tasks` → `tasks`）：drift test
 * 据它把 manifest.channels 与本分片的键集合逐条对账。
 *
 * 每个动作的 response 都是**权威快照**（list 结果或任务详情）：渲染进程发起
 * 任何一个动作之后立刻拿到全量状态，不必自己推断列表变成了什么样——「点了
 * 没反应」这类问题在结构上就不成立。这与本仓 providers / update 的口径一致。
 */
export const tasksContractShard = defineContractShard("tasks", {
  [CHANNELS.tasksList]: { request: taskListRequestSchema, response: taskListResultSchema },
  [CHANNELS.tasksGet]: { request: taskIdRequestSchema, response: taskDetailSchema.nullable() },
  [CHANNELS.tasksCreate]: { request: taskCreateRequestSchema, response: taskDetailSchema },
  [CHANNELS.tasksUpdate]: { request: taskUpdateRequestSchema, response: taskDetailSchema.nullable() },
  [CHANNELS.tasksDelete]: { request: taskIdRequestSchema, response: taskListResultSchema },
  [CHANNELS.tasksPause]: { request: taskIdRequestSchema, response: taskDetailSchema.nullable() },
  [CHANNELS.tasksResume]: { request: taskIdRequestSchema, response: taskDetailSchema.nullable() },
  [CHANNELS.tasksRunNow]: { request: taskIdRequestSchema, response: taskDetailSchema.nullable() },
  [CHANNELS.tasksCancelRun]: { request: runIdRequestSchema, response: taskDetailSchema.nullable() },
  [CHANNELS.tasksRetryRun]: { request: runIdRequestSchema, response: taskDetailSchema.nullable() },
  [CHANNELS.tasksDuplicate]: { request: taskIdRequestSchema, response: taskDetailSchema.nullable() },
});
