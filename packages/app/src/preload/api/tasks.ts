/**
 * `window.piBuddy.tasks` —— 持久定时任务（Durable Tasks，AUT-101）。
 *
 * 每个方法的入参都是不透明 workspaceId + taskId / runId：任务的调度、触发、
 * 落盘全在主进程，渲染进程既指定不了别的工作区的任务，也表达不出「触发一次
 * 任意 Agent run」。每个动作的返回都是权威快照（列表或任务详情）。
 *
 * CHANNELS 走 `@pibuddy/contract/channels` 子入口（不依赖 zod），理由见
 * artifacts.ts / bridge.ts。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  TaskCreateRequest,
  TaskDetail,
  TaskListResult,
  TaskUpdateRequest,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const tasks = {
  /** 列出当前工作区的全部任务（含缺哪些预授权、最近一次 run 状态）。 */
  list: (workspaceId: string) =>
    invoke<TaskListResult>(CHANNELS.tasksList, { workspaceId }),

  /** 取一条任务的详情（任务本体 + 最近的 run 列表）。 */
  get: (workspaceId: string, id: string) =>
    invoke<TaskDetail | null>(CHANNELS.tasksGet, { workspaceId, id }),

  create: (req: TaskCreateRequest) => invoke<TaskDetail>(CHANNELS.tasksCreate, req),

  update: (req: TaskUpdateRequest) =>
    invoke<TaskDetail | null>(CHANNELS.tasksUpdate, req),

  delete: (workspaceId: string, id: string) =>
    invoke<TaskListResult>(CHANNELS.tasksDelete, { workspaceId, id }),

  pause: (workspaceId: string, id: string) =>
    invoke<TaskDetail | null>(CHANNELS.tasksPause, { workspaceId, id }),

  resume: (workspaceId: string, id: string) =>
    invoke<TaskDetail | null>(CHANNELS.tasksResume, { workspaceId, id }),

  /** 立即触发一次（不改计划，独立 run）。 */
  runNow: (workspaceId: string, id: string) =>
    invoke<TaskDetail | null>(CHANNELS.tasksRunNow, { workspaceId, id }),

  cancelRun: (workspaceId: string, taskId: string, runId: string) =>
    invoke<TaskDetail | null>(CHANNELS.tasksCancelRun, { workspaceId, taskId, runId }),

  retryRun: (workspaceId: string, taskId: string, runId: string) =>
    invoke<TaskDetail | null>(CHANNELS.tasksRetryRun, { workspaceId, taskId, runId }),

  duplicate: (workspaceId: string, id: string) =>
    invoke<TaskDetail | null>(CHANNELS.tasksDuplicate, { workspaceId, id }),
};
