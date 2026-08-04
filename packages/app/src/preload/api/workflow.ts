/**
 * `window.piBuddy.workflow`（common.workflow，第 24 个命名空间）。
 *
 * 渲染进程能表达的极限：列出 / 保存 / 删除 / 导出 / 导入工作流定义、运行 / 停止 /
 * 取运行历史，外加订阅运行快照推送。一律以 workspaceId（数据按工作区分区）+
 * 不透明 definitionId / runId + 可移植 JSON 文本为入参——既塞不进一个运行时句柄，
 * 也表达不出「让某进程跑什么命令」（Agent 节点的真实进程派生在主进程的后台池侧）。
 *
 * 运行快照推送 `onSnapshot` 收到的是完整 `PiEnvelope<WorkflowRunSnapshot>`：preload
 * 不剥壳，generation/sequence 只有送到渲染进程才用得上（与 agentPool / childAgent
 * 同口径）。
 *
 * CHANNELS / PUSH_CHANNELS 只能从 `@pibuddy/contract/channels` 引（不依赖 zod）。
 */
import { CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract/channels";
import type {
  PiEnvelope,
  WorkflowDefinition,
  WorkflowDefinitionsResponse,
  WorkflowExportResponse,
  WorkflowImportResponse,
  WorkflowRunSnapshot,
} from "@pibuddy/contract";
import { invoke, subscribe } from "./bridge.js";

export const workflow = {
  /** 列出一个工作区的全部工作流定义。 */
  list: (workspaceId: string) =>
    invoke<WorkflowDefinitionsResponse>(CHANNELS.workflowList, { workspaceId }),

  /** 新建或更新一个定义（upsert）。 */
  save: (workspaceId: string, definition: WorkflowDefinition) =>
    invoke<WorkflowDefinitionsResponse>(CHANNELS.workflowSave, { workspaceId, definition }),

  /** 删除一个定义。 */
  remove: (workspaceId: string, definitionId: string) =>
    invoke<WorkflowDefinitionsResponse>(CHANNELS.workflowDelete, { workspaceId, definitionId }),

  /** 导出一个定义为可移植 JSON 文本。 */
  exportJson: (workspaceId: string, definitionId: string) =>
    invoke<WorkflowExportResponse>(CHANNELS.workflowExport, { workspaceId, definitionId }),

  /** 从可移植 JSON 导入一个定义（校验后入库，分配新 id）。 */
  importJson: (workspaceId: string, json: string) =>
    invoke<WorkflowImportResponse>(CHANNELS.workflowImport, { workspaceId, json }),

  /** 运行一个定义（再次调用即重跑）。 */
  run: (workspaceId: string, definitionId: string) =>
    invoke<WorkflowRunSnapshot>(CHANNELS.workflowRun, { workspaceId, definitionId }),

  /** 停止一次运行。 */
  stop: (workspaceId: string, runId: string) =>
    invoke<WorkflowRunSnapshot>(CHANNELS.workflowStop, { workspaceId, runId }),

  /** 取当前活跃运行 + 近期历史快照。 */
  runs: (workspaceId: string) =>
    invoke<WorkflowRunSnapshot>(CHANNELS.workflowRuns, { workspaceId }),

  /** 订阅运行快照推送（PiEnvelope<WorkflowRunSnapshot>），返回退订闭包。 */
  onSnapshot: (cb: (e: PiEnvelope<WorkflowRunSnapshot>) => void) =>
    subscribe(PUSH_CHANNELS.workflowEvent, cb as (p: unknown) => void),
};
