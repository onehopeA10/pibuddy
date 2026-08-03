/**
 * child Agent 编排的契约（AGT-102）。
 *
 * ## 这个文件在回答什么
 *
 * `agent-pool.ts` 回答「同时存在多个会话进程时谁在跑、谁该回收」——它是一张
 * **扁平**的会话表，刻意不含任何 parent/child 字段（见其文件头）。本文件回答
 * 上一层：**一个父 Agent 派生了哪些子 Agent、它们组成什么拓扑、各自的目标 /
 * 预算 / 权限继承 / 超时 / 交付物是什么、进展 / 阻塞 / 证据 / 最终结果如何**。
 *
 * child 编排是**通用能力**（ADR-0002 四层边界表第二行，可关闭）：把它关掉，
 * 单会话对话仍然照常工作，只是不能再派生子 Agent。因此它是一个 `common`
 * tier 的能力包 `common.child-agent`，而不是内核设施。
 *
 * ## 结构化消息，不靠解析自然语言日志
 *
 * 子 Agent 的 progress / question / evidence / result 都是**结构化**的
 * （`ChildMessage`），由子运行时经一个约定的结构化上报点产生，而不是让父进程
 * 去正则匹配子进程的自然语言输出。这条是硬约束：一旦退化成解析日志文本，
 * 「子 Agent 说它完成了」与「子 Agent 输出里恰好出现了『完成』二字」就再也
 * 分不开。
 *
 * ## 与后台池的关系
 *
 * 每个子 Agent 是池里的一个 `origin:"child"` 会话：它照样受池的并发 / 内存 /
 * 成本闸与崩溃预算管辖（child 子进程独立 runtime 要有资源上界）。本文件的
 * 拓扑快照与池快照**并列**：池管「进程态 / 资源」，本文件管「父子关系 /
 * 目标 / 证据 / 结果」。两者按 sessionId 关联。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

// ---------------------------------------------------------------- 节点状态

/**
 * 一个子 Agent 节点的编排状态（与池的进程态 / 列表态正交）。
 *
 *   - `pending`        —— 已登记，等待池准入 / 运行时就绪。
 *   - `running`        —— 子 Agent 正在处理目标。
 *   - `waiting_answer` —— 卡在一条向父发出的结构化提问上（见 `question`）。
 *   - `blocked`        —— 被挡住且非它自己能解（如非幂等工具断线后需人工重放、
 *                          或等待父的合并裁决）。
 *   - `succeeded`      —— 收敛：交付物齐备、result.ok。
 *   - `failed`         —— 以错误收场（且重试预算耗尽）。
 *   - `cancelled`      —— 被取消（父取消传播 / 用户主动取消）。
 *   - `timed_out`      —— 超过 deadline 被收口（随即取消其子树）。
 */
export const CHILD_STATUSES = [
  "pending",
  "running",
  "waiting_answer",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type ChildStatus = (typeof CHILD_STATUSES)[number];
export const childStatusSchema = z.enum(CHILD_STATUSES);

/** 终态：不再有后续状态转移，也不再消耗进程 / 预算。 */
export function isTerminalChildStatus(status: ChildStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}

// ---------------------------------------------------------------- 模型 / 预算

/** 子 Agent 使用的模型（父可为子指定与自己不同的模型/预算档）。 */
export const childModelSchema = z
  .object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict();
export type ChildModel = z.infer<typeof childModelSchema>;

// ---------------------------------------------------------------- 子 Agent 规格

/**
 * 父 Agent 创建子 Agent 时给出的完整规格。
 *
 * 这份规格刻意把「父给子交代清楚的每一件事」都做成显式字段，而不是塞进一段
 * 自由文本：目标、输入、工作区、模型/预算、权限继承、超时、预期交付物。任何
 * 一项缺失都会让「子到底该干成什么样」变成一件只能事后争论的事。
 */
export const childSpecSchema = z
  .object({
    /** 目标：子 Agent 要达成什么（一句可判定的话）。 */
    goal: z.string().min(1),
    /** 输入 / 上下文：父交给子的材料（提示词正文）。 */
    input: z.string().default(""),
    /** 子 Agent 的工作区；null 表示继承父的工作区。 */
    workspaceId: z.string().min(1).nullable().default(null),
    /** 指定模型；null 表示继承父的当前模型。 */
    model: childModelSchema.nullable().default(null),
    /** 成本预算（USD）。超过即收口（failed / blocked），绝不无声超支。 */
    budgetUsd: z.number().nonnegative().default(0),
    /** 超时（ms）。到 deadline 未收敛 → timed_out 并取消其子树。 */
    timeoutMs: z.number().int().nonnegative().default(0),
    /**
     * 权限继承：true = 子继承父在本工作区已获得的能力授权；
     * false = 子从零开始，自己的权限请求单独进统一 inbox。
     */
    inheritPermissions: z.boolean().default(true),
    /** 预期交付物清单（供收敛判定与 UI 展示）。 */
    deliverables: z.array(z.string().min(1)).default([]),
    /**
     * coding 子 Agent 默认独立 worktree（可复用 Git 包能力）：true 时子在一个
     * 独立工作树里改动，合并前展示 diff / 测试 / 冲突。
     */
    isolatedWorktree: z.boolean().default(false),
    /**
     * 任务是否幂等。**非幂等工具不因断线自动重放**：idempotent=false 的子在
     * 运行时崩溃 / 断线后**不**自动重启，而是置 blocked 等人工确认；只有
     * idempotent=true 的子才在重试预算内自动恢复。
     */
    idempotent: z.boolean().default(false),
    /** 有限重试预算。失败后仅在预算内且幂等时自动重试。 */
    retryBudget: z.number().int().nonnegative().default(1),
  })
  .strict();
export type ChildSpec = z.infer<typeof childSpecSchema>;

// ---------------------------------------------------------------- 结构化消息

/** 证据的种类（patch / commit / 测试结果 / 一般笔记）。 */
export const CHILD_EVIDENCE_KINDS = ["patch", "commit", "test", "note"] as const;
export type ChildEvidenceKind = (typeof CHILD_EVIDENCE_KINDS)[number];

/**
 * 一条证据。
 *
 * `detail` 承载 patch 文本 / commit hash / 测试输出 / 笔记正文。它是子 Agent
 * **结构化**上报的产物，不是从日志里刮出来的。
 */
export const childEvidenceSchema = z
  .object({
    kind: z.enum(CHILD_EVIDENCE_KINDS),
    title: z.string().min(1),
    detail: z.string().default(""),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type ChildEvidence = z.infer<typeof childEvidenceSchema>;

/** 一条待父回答的提问（结构化，不是自然语言里夹带的问号）。 */
export const childQuestionSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    /** 可选项；为空表示自由作答。 */
    options: z.array(z.string().min(1)).default([]),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type ChildQuestion = z.infer<typeof childQuestionSchema>;

/** 进展（note + 可选完成度）。 */
export const childProgressSchema = z
  .object({
    note: z.string().default(""),
    fraction: z.number().min(0).max(1).nullable().default(null),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type ChildProgress = z.infer<typeof childProgressSchema>;

/** 最终结果。 */
export const childResultSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string().default(""),
    /** 交付物 → 内容/路径的键值对（结构化交付，不是一段结语）。 */
    deliverables: z.record(z.string(), z.string()).default({}),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type ChildResult = z.infer<typeof childResultSchema>;

/**
 * 子 Agent 向父发出的**结构化**消息判别联合。
 *
 * 这是「不靠解析自然语言日志」的落点：子运行时经一个约定的结构化上报点产生
 * 这些消息（生产上是子运行时对一个专用工具的调用，其**类型化参数**即为
 * payload），父进程按 `type` 分派，绝不去正则匹配子进程的散文输出。
 */
export const childMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), progress: childProgressSchema }).strict(),
  z.object({ type: z.literal("question"), question: childQuestionSchema }).strict(),
  z.object({ type: z.literal("evidence"), evidence: childEvidenceSchema }).strict(),
  z.object({ type: z.literal("result"), result: childResultSchema }).strict(),
]);
export type ChildMessage = z.infer<typeof childMessageSchema>;

// ---------------------------------------------------------------- 节点视图

/** 快照里的一个子 Agent 节点（下发渲染进程，不含磁盘路径）。 */
export const childNodeViewSchema = z
  .object({
    /** 编排层的稳定节点 id（也用作池的 sessionId 键）。 */
    nodeId: z.string().min(1),
    /** 父节点 id；根（用户直接创建的顶层子 Agent）为 null。 */
    parentId: z.string().min(1).nullable(),
    goal: z.string(),
    workspaceId: z.string().min(1).nullable(),
    model: childModelSchema.nullable(),
    status: childStatusSchema,
    costUsd: z.number().nonnegative(),
    budgetUsd: z.number().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    lastActivityAt: z.number().int().nonnegative(),
    /** 超时 deadline（Unix ms）；0 表示无超时。 */
    deadlineAt: z.number().int().nonnegative(),
    /** 阻塞原因（blocked 时非空）。 */
    blockedReason: z.string().nullable(),
    retryCount: z.number().int().nonnegative(),
    retryBudget: z.number().int().nonnegative(),
    idempotent: z.boolean(),
    inheritPermissions: z.boolean(),
    isolatedWorktree: z.boolean(),
    deliverables: z.array(z.string()),
    evidence: z.array(childEvidenceSchema),
    /** 当前待回答的提问；无则 null。 */
    question: childQuestionSchema.nullable(),
    /** 最近一条进展；无则 null。 */
    progress: childProgressSchema.nullable(),
    /** 最终结果；未收敛则 null。 */
    result: childResultSchema.nullable(),
    /**
     * 待父裁决的合并（coding 子的 worktree 改动）。有值时子处于 blocked，
     * 等父 accept / reject。
     */
    pendingMerge: z
      .object({ patchTitle: z.string(), hasConflict: z.boolean() })
      .strict()
      .nullable(),
  })
  .strict();
export type ChildNodeView = z.infer<typeof childNodeViewSchema>;

// ---------------------------------------------------------------- 拓扑快照

/**
 * 整棵编排拓扑的快照。
 *
 * `sequence` 单调递增（对齐点，同池快照）。`providerInFlight` 暴露 Provider
 * 限流协调的当前在飞数：supervisor 用一道按 provider 的并发闸避免一批子 Agent
 * 同时打爆同一个 Provider 的速率限制。
 */
export const childTopologySnapshotSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    nodes: z.array(childNodeViewSchema),
    /** provider → 当前在飞（running）子 Agent 数（限流协调视图）。 */
    providerInFlight: z.record(z.string(), z.number().int().nonnegative()),
    /** 每个 provider 允许的最大在飞数（限流闸）。 */
    providerConcurrencyCap: z.number().int().positive(),
  })
  .strict();
export type ChildTopologySnapshot = z.infer<typeof childTopologySnapshotSchema>;

/** 拓扑快照信封的固定上下文（不属于任何单个会话/runtime）。 */
export const CHILD_ENVELOPE_ID = "__child-agent__";
export const CHILD_ENVELOPE_GENERATION = 1;

// ---------------------------------------------------------------- 通道入参

/** child-agent:create 的入参：父节点 id（null=顶层）+ 子规格。 */
export const childCreateRequestSchema = z
  .object({
    parentId: z.string().min(1).nullable().default(null),
    spec: childSpecSchema,
  })
  .strict();
export type ChildCreateRequest = z.infer<typeof childCreateRequestSchema>;

/** child-agent:cancel 的入参：取消某节点（向其整棵子树传播）。 */
export const childCancelRequestSchema = z.object({ nodeId: z.string().min(1) }).strict();
export type ChildCancelRequest = z.infer<typeof childCancelRequestSchema>;

/** child-agent:answer 的入参：回答某子 Agent 的一条提问。 */
export const childAnswerRequestSchema = z
  .object({
    nodeId: z.string().min(1),
    questionId: z.string().min(1),
    answer: z.string(),
  })
  .strict();
export type ChildAnswerRequest = z.infer<typeof childAnswerRequestSchema>;

/** child-agent:resolve-merge 的入参：父对子 worktree 改动的合并裁决。 */
export const childResolveMergeRequestSchema = z
  .object({
    nodeId: z.string().min(1),
    accept: z.boolean(),
  })
  .strict();
export type ChildResolveMergeRequest = z.infer<typeof childResolveMergeRequestSchema>;

export const childDescribeRequestSchema = z.object({}).strict();
export type ChildDescribeRequest = z.infer<typeof childDescribeRequestSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * child Agent 编排的五条通道 + 一条快照推送。
 *
 * 通道分片 id 取 capabilityId 的第二段 `child-agent`（drift test 据此对账）。
 * 渲染进程能表达的极限：取拓扑、创建子、取消（传播）、回答提问、裁决合并——
 * 一律以不透明 nodeId 为入参，塞不进一个运行时句柄，也指定不了「让某进程跑
 * 什么命令」（子的目标是结构化 spec，真正的进程派生在主进程池侧）。
 */
export const childAgentContractShard = defineContractShard("child-agent", {
  [CHANNELS.childAgentDescribe]: {
    request: childDescribeRequestSchema,
    response: childTopologySnapshotSchema,
  },
  [CHANNELS.childAgentCreate]: {
    request: childCreateRequestSchema,
    response: childTopologySnapshotSchema,
  },
  [CHANNELS.childAgentCancel]: {
    request: childCancelRequestSchema,
    response: childTopologySnapshotSchema,
  },
  [CHANNELS.childAgentAnswer]: {
    request: childAnswerRequestSchema,
    response: childTopologySnapshotSchema,
  },
  [CHANNELS.childAgentResolveMerge]: {
    request: childResolveMergeRequestSchema,
    response: childTopologySnapshotSchema,
  },
});
