/**
 * 可视化工作流的契约（common.workflow，可关闭）。
 *
 * ## 这个文件在回答什么
 *
 * 「一张工作流画布由什么构成、跑起来会经历什么」——节点（开始 / 结束 / 输入 /
 * 输出 / Agent / 条件分支）、有向边、一次运行里每个节点的状态与产出。它是一份
 * **可移植的纯数据**：因此工作流定义能被导出成 JSON、在另一台机器上导入、被
 * diff、被校验。ADR-0002 的贯穿性观察在这里同样成立：声明是纯数据，冲突静态
 * 可查；运行期才拼出来的东西只能在崩溃时被发现。
 *
 * ## 为什么是 common tier（可关闭）
 *
 * 可视化工作流是**通用能力**（ADR-0002 四层边界表第二行）：把它关掉，单会话
 * 对话与其它能力照常工作，只是不能再编排 DAG 工作流。因此它是一个 `common`
 * 能力包 `common.workflow`，而不是内核设施。
 *
 * ## Agent 节点如何触发一次 pi run
 *
 * Agent 节点**自己不派生进程**：它只声明「用这段提示词跑一次」。真正的触发在
 * 主进程侧经由既有后台会话池（`agentPool().requestSession` + 后台 runtime host）
 * 完成——与 child Agent 编排复用同一套触发机制，本能力不重造。因此这里的节点
 * 配置里塞不进任何运行时句柄，也表达不出「执行某条命令」，只有一段提示词模板。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS, PUSH_CHANNELS } from "./channels.js";

/** 工作流定义结构自身的代际。改字段语义要 +1 并在宿主侧补迁移分支。 */
export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- 节点

/**
 * 节点种类。
 *
 *   - `start`     —— 起点（无入边）。
 *   - `end`       —— 终点（无出边被消费）。
 *   - `input`     —— 输入：给出一段种子文本，作为下游节点的输入。
 *   - `output`    —— 输出：汇聚上游产出（工作流的对外结果）。
 *   - `agent`     —— 跑一段 pi 提示词；上游产出注入提示词，产出向下游传递。
 *   - `condition` —— 条件分支：对输入判定真假，把执行路由到 true / false 分支。
 */
export const WORKFLOW_NODE_KINDS = [
  "start",
  "end",
  "input",
  "output",
  "agent",
  "condition",
] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

/** 画布坐标。纯展示，不参与执行语义。 */
export const workflowPositionSchema = z.object({ x: z.number(), y: z.number() }).strict();
export type WorkflowPosition = z.infer<typeof workflowPositionSchema>;

/**
 * 条件判定表达式。
 *
 * 刻意不是一段 JS：一段可执行表达式意味着把渲染进程能构造的字符串送进某个
 * `eval` 里跑，那是把「画一张流程图」变成「远程代码执行」。这里只保留三种
 * 可判定、无副作用的比较，对着节点的输入文本判真假。
 */
export const workflowConditionSchema = z
  .object({
    /** contains=输入包含 value；equals=输入等于 value；non-empty=输入非空。 */
    mode: z.enum(["contains", "equals", "non-empty"]),
    value: z.string().default(""),
  })
  .strict();
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;

const nodeBase = {
  /** 节点 id，工作流内唯一（也用作执行时的键）。 */
  id: z.string().min(1),
  title: z.string().default(""),
  position: workflowPositionSchema,
};

export const workflowStartNodeSchema = z.object({ kind: z.literal("start"), ...nodeBase }).strict();
export const workflowEndNodeSchema = z.object({ kind: z.literal("end"), ...nodeBase }).strict();
export const workflowInputNodeSchema = z
  .object({ kind: z.literal("input"), ...nodeBase, value: z.string().default("") })
  .strict();
export const workflowOutputNodeSchema = z
  .object({ kind: z.literal("output"), ...nodeBase })
  .strict();
export const workflowAgentNodeSchema = z
  .object({
    kind: z.literal("agent"),
    ...nodeBase,
    /** 提示词模板；`{{input}}` 会被替换为上游产出。 */
    prompt: z.string().default(""),
  })
  .strict();
export const workflowConditionNodeSchema = z
  .object({ kind: z.literal("condition"), ...nodeBase, condition: workflowConditionSchema })
  .strict();

/** 一个节点（按 kind 判别的联合）。 */
export const workflowNodeSchema = z.discriminatedUnion("kind", [
  workflowStartNodeSchema,
  workflowEndNodeSchema,
  workflowInputNodeSchema,
  workflowOutputNodeSchema,
  workflowAgentNodeSchema,
  workflowConditionNodeSchema,
]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

// ---------------------------------------------------------------- 边

/**
 * 一条有向边。
 *
 * `sourceHandle` 只对条件节点有意义：`true` / `false` 表示这条边挂在条件的哪个
 * 分支上。非条件节点的出边为 null（无分支）。
 */
export const workflowEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    sourceHandle: z.enum(["true", "false"]).nullable().default(null),
  })
  .strict();
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

// ---------------------------------------------------------------- 定义

/**
 * 一张完整的工作流定义（可移植）。
 *
 * 导出即这份对象的 JSON；导入即把一份 JSON 校验回这份对象。`schemaVersion`
 * 让跨版本导入能被识别与迁移，而不是把一份旧结构直接当新结构塞进来。
 */
export const workflowDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    nodes: z.array(workflowNodeSchema),
    edges: z.array(workflowEdgeSchema),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

// ---------------------------------------------------------------- 运行状态

/**
 * 一次运行里单个节点的状态。
 *
 *   - `pending`   —— 尚未执行。
 *   - `running`   —— 正在执行（Agent 节点等待 pi run）。
 *   - `succeeded` —— 执行完成。
 *   - `failed`    —— 执行失败（其出边随即失活，下游被跳过）。
 *   - `skipped`   —— 因所有入边失活（条件未命中 / 上游失败）而跳过。
 */
export const WORKFLOW_RUN_NODE_STATES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;
export type WorkflowRunNodeStateKind = (typeof WORKFLOW_RUN_NODE_STATES)[number];

export const workflowRunNodeSchema = z
  .object({
    nodeId: z.string().min(1),
    state: z.enum(WORKFLOW_RUN_NODE_STATES),
    /** 本节点产出（向下游传递的文本）。 */
    output: z.string(),
    /** 失败原因；非失败为 null。 */
    error: z.string().nullable(),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
  })
  .strict();
export type WorkflowRunNode = z.infer<typeof workflowRunNodeSchema>;

/**
 * 整次运行的状态。
 *
 *   - `running`   —— 仍在执行。
 *   - `succeeded` —— 全部收敛，无失败节点。
 *   - `failed`    —— 至少一个节点失败（或定义成环无法执行）。
 *   - `stopped`   —— 被用户主动停止。
 */
export const WORKFLOW_RUN_STATES = ["running", "succeeded", "failed", "stopped"] as const;
export type WorkflowRunStateKind = (typeof WORKFLOW_RUN_STATES)[number];

export const workflowRunSchema = z
  .object({
    id: z.string().min(1),
    definitionId: z.string().min(1),
    definitionName: z.string(),
    workspaceId: z.string().nullable(),
    state: z.enum(WORKFLOW_RUN_STATES),
    nodes: z.array(workflowRunNodeSchema),
    /** 运行级失败原因（如成环）；非失败为 null。 */
    error: z.string().nullable(),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
    /** 单调序号（对齐点，同池 / child 快照）。 */
    sequence: z.number().int().nonnegative(),
  })
  .strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/**
 * 运行快照：当前活跃运行 + 近期历史（下发渲染进程）。
 *
 * `sequence` 单调递增，渲染侧据它丢弃晚到的旧快照（复用 PiEnvelope 的判据）。
 */
export const workflowRunSnapshotSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    runs: z.array(workflowRunSchema),
  })
  .strict();
export type WorkflowRunSnapshot = z.infer<typeof workflowRunSnapshotSchema>;

/** 运行快照信封的固定上下文（不属于任何单个会话 / runtime）。 */
export const WORKFLOW_ENVELOPE_ID = "__workflow__";
export const WORKFLOW_ENVELOPE_GENERATION = 1;

// ---------------------------------------------------------------- 通道入参 / 出参

/** 一个工作区的所有工作流定义。 */
export const workflowDefinitionsResponseSchema = z
  .object({ definitions: z.array(workflowDefinitionSchema) })
  .strict();
export type WorkflowDefinitionsResponse = z.infer<typeof workflowDefinitionsResponseSchema>;

export const workflowListRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();
export type WorkflowListRequest = z.infer<typeof workflowListRequestSchema>;

export const workflowSaveRequestSchema = z
  .object({ workspaceId: z.string().min(1), definition: workflowDefinitionSchema })
  .strict();
export type WorkflowSaveRequest = z.infer<typeof workflowSaveRequestSchema>;

export const workflowDeleteRequestSchema = z
  .object({ workspaceId: z.string().min(1), definitionId: z.string().min(1) })
  .strict();
export type WorkflowDeleteRequest = z.infer<typeof workflowDeleteRequestSchema>;

export const workflowExportRequestSchema = z
  .object({ workspaceId: z.string().min(1), definitionId: z.string().min(1) })
  .strict();
export type WorkflowExportRequest = z.infer<typeof workflowExportRequestSchema>;

/** 导出的可移植 JSON 文本。 */
export const workflowExportResponseSchema = z.object({ json: z.string() }).strict();
export type WorkflowExportResponse = z.infer<typeof workflowExportResponseSchema>;

export const workflowImportRequestSchema = z
  .object({ workspaceId: z.string().min(1), json: z.string().min(1) })
  .strict();
export type WorkflowImportRequest = z.infer<typeof workflowImportRequestSchema>;

/** 导入结果：新入库的定义 + 更新后的全量列表。 */
export const workflowImportResponseSchema = z
  .object({ definition: workflowDefinitionSchema, definitions: z.array(workflowDefinitionSchema) })
  .strict();
export type WorkflowImportResponse = z.infer<typeof workflowImportResponseSchema>;

export const workflowRunRequestSchema = z
  .object({ workspaceId: z.string().min(1), definitionId: z.string().min(1) })
  .strict();
export type WorkflowRunRequest = z.infer<typeof workflowRunRequestSchema>;

export const workflowStopRequestSchema = z
  .object({ workspaceId: z.string().min(1), runId: z.string().min(1) })
  .strict();
export type WorkflowStopRequest = z.infer<typeof workflowStopRequestSchema>;

export const workflowRunsRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();
export type WorkflowRunsRequest = z.infer<typeof workflowRunsRequestSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * 可视化工作流的八条通道 + 一条快照推送。
 *
 * 分片 id 取 capabilityId 的第二段 `workflow`（drift test 据此对账）。
 * 入参一律带 workspaceId（数据按工作区分区）+ 不透明 definitionId / runId，
 * 塞不进任何运行时句柄。
 */
export const workflowContractShard = defineContractShard("workflow", {
  [CHANNELS.workflowList]: {
    request: workflowListRequestSchema,
    response: workflowDefinitionsResponseSchema,
  },
  [CHANNELS.workflowSave]: {
    request: workflowSaveRequestSchema,
    response: workflowDefinitionsResponseSchema,
  },
  [CHANNELS.workflowDelete]: {
    request: workflowDeleteRequestSchema,
    response: workflowDefinitionsResponseSchema,
  },
  [CHANNELS.workflowExport]: {
    request: workflowExportRequestSchema,
    response: workflowExportResponseSchema,
  },
  [CHANNELS.workflowImport]: {
    request: workflowImportRequestSchema,
    response: workflowImportResponseSchema,
  },
  [CHANNELS.workflowRun]: {
    request: workflowRunRequestSchema,
    response: workflowRunSnapshotSchema,
  },
  [CHANNELS.workflowStop]: {
    request: workflowStopRequestSchema,
    response: workflowRunSnapshotSchema,
  },
  [CHANNELS.workflowRuns]: {
    request: workflowRunsRequestSchema,
    response: workflowRunSnapshotSchema,
  },
});
