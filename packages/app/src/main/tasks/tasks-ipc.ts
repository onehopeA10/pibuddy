/**
 * 持久定时任务的 IPC handler（Durable Tasks，AUT-101）——**恰 11 条通道**。
 *
 * 入参一律是不透明 workspaceId + taskId / runId：任务按 workspaceId 分区，
 * 触发的是某条已落盘任务里冻结的配置，渲染进程一个字节都改不了。每个动作的
 * 返回都是权威快照（列表或任务详情），与 providers / update 同一口径。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 * 也不 import 任何 renderer / Vue —— 调度器是 headless 的。
 */
import {
  CHANNELS,
  runIdRequestSchema,
  taskCreateRequestSchema,
  taskIdRequestSchema,
  taskListRequestSchema,
  taskUpdateRequestSchema,
  type CapabilityGrant,
  type InvokeChannel,
  type TaskCreateRequest,
  type TaskDetail,
  type TaskIdRequest,
  type TaskListRequest,
  type TaskListResult,
  type TaskUpdateRequest,
  type RunIdRequest,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { createLogger, type Logger } from "../logger.js";
import { workspaceStore } from "../workspace/workspace-store.js";
import { systemClock } from "./clock.js";
import { createPoolRunTrigger } from "./pool-run-trigger.js";
import { nextRunAfter, Scheduler } from "./scheduler.js";
import { evaluateScheduledPermissions } from "./task-permission.js";
import { setAgentRunTrigger } from "./task-trigger.js";
import { closeTaskStore, taskStore, type TaskStore } from "./task-store.js";

/** 本域注册的全部通道。单测据它断言逐一出现在 ipc-guard 的注册表里。 */
export const TASKS_CHANNELS: InvokeChannel[] = [
  CHANNELS.tasksList,
  CHANNELS.tasksGet,
  CHANNELS.tasksCreate,
  CHANNELS.tasksUpdate,
  CHANNELS.tasksDelete,
  CHANNELS.tasksPause,
  CHANNELS.tasksResume,
  CHANNELS.tasksRunNow,
  CHANNELS.tasksCancelRun,
  CHANNELS.tasksRetryRun,
  CHANNELS.tasksDuplicate,
];

let logger: Logger | null = null;
function log(): Logger {
  if (!logger) logger = createLogger("tasks");
  return logger;
}

/** 某工作区落盘的能力授权表——scheduler 与列表判定「缺哪些预授权」的只读数据源。 */
function workspaceGrants(workspaceId: string): readonly CapabilityGrant[] {
  return workspaceStore().get(workspaceId)?.capabilityGrants ?? [];
}

let sched: Scheduler | null = null;
function scheduler(): Scheduler {
  if (!sched) {
    sched = new Scheduler({
      store: taskStore(),
      clock: systemClock,
      workspaceGrants,
      log: (event, fields) => log().info(event, fields),
    });
  }
  return sched;
}

// ---------------------------------------------------------------- 快照拼装

function detailOf(store: TaskStore, id: string): TaskDetail | null {
  const task = store.getTask(id);
  if (!task) return null;
  return { task, runs: store.listRuns(id) };
}

function listResult(store: TaskStore, workspaceId: string): TaskListResult {
  const items = store.listTasks(workspaceId).map((task) => {
    const perm = evaluateScheduledPermissions(
      task.requiredPermissions,
      task.workspaceId,
      workspaceGrants(task.workspaceId)
    );
    const recent = store.listRuns(task.id, 1);
    return {
      task,
      missingPermissions: perm.missing,
      lastRunStatus: recent[0]?.status ?? null,
    };
  });
  return { items };
}

// ---------------------------------------------------------------- 注册

export function registerTasksIpc(): void {
  registerHandler<TaskListRequest, TaskListResult>(
    CHANNELS.tasksList,
    taskListRequestSchema,
    (req) => listResult(taskStore(), req.workspaceId)
  );

  registerHandler<TaskIdRequest, TaskDetail | null>(
    CHANNELS.tasksGet,
    taskIdRequestSchema,
    (req) => detailOf(taskStore(), req.id)
  );

  registerHandler<TaskCreateRequest, TaskDetail>(
    CHANNELS.tasksCreate,
    taskCreateRequestSchema,
    (req) => {
      const store = taskStore();
      const now = systemClock.now();
      const nextRunAt = nextRunAfter({ schedule: req.schedule, timezone: req.timezone }, now);
      const task = store.createTask(
        {
          workspaceId: req.workspaceId,
          name: req.name,
          schedule: req.schedule,
          timezone: req.timezone,
          agent: req.agent,
          requiredPermissions: req.requiredPermissions,
          budgetUsd: req.budgetUsd,
          timeoutMs: req.timeoutMs,
          misfirePolicy: req.misfirePolicy,
          concurrencyPolicy: req.concurrencyPolicy,
          failurePolicy: req.failurePolicy,
        },
        now,
        nextRunAt
      );
      log().info("tasks_created", { taskId: task.id, kind: req.schedule.kind, nextRunAt });
      return { task, runs: [] };
    }
  );

  registerHandler<TaskUpdateRequest, TaskDetail | null>(
    CHANNELS.tasksUpdate,
    taskUpdateRequestSchema,
    (req) => {
      const store = taskStore();
      const current = store.getTask(req.id);
      if (!current || current.workspaceId !== req.workspaceId) return null;
      const now = systemClock.now();
      const schedule = req.schedule ?? current.schedule;
      const timezone = req.timezone ?? current.timezone;
      const patch: Parameters<TaskStore["updateTask"]>[1] = {
        name: req.name ?? current.name,
        schedule,
        timezone,
        agent: req.agent ?? current.agent,
        requiredPermissions: req.requiredPermissions ?? current.requiredPermissions,
        budgetUsd: req.budgetUsd !== undefined ? req.budgetUsd : current.budgetUsd,
        timeoutMs: req.timeoutMs !== undefined ? req.timeoutMs : current.timeoutMs,
        misfirePolicy: req.misfirePolicy ?? current.misfirePolicy,
        concurrencyPolicy: req.concurrencyPolicy ?? current.concurrencyPolicy,
        failurePolicy: req.failurePolicy ?? current.failurePolicy,
      };
      // 计划或时区变了就重算下一次；active 才有下一次，paused 保持 null。
      if ((req.schedule || req.timezone) && current.status === "active") {
        patch.nextRunAt = nextRunAfter({ schedule, timezone }, now);
      }
      store.updateTask(req.id, patch, now);
      return detailOf(store, req.id);
    }
  );

  registerHandler<TaskIdRequest, TaskListResult>(
    CHANNELS.tasksDelete,
    taskIdRequestSchema,
    (req) => {
      const store = taskStore();
      const task = store.getTask(req.id);
      if (task && task.workspaceId === req.workspaceId) store.deleteTask(req.id);
      return listResult(store, req.workspaceId);
    }
  );

  registerHandler<TaskIdRequest, TaskDetail | null>(
    CHANNELS.tasksPause,
    taskIdRequestSchema,
    (req) => {
      const store = taskStore();
      const task = store.getTask(req.id);
      if (!task || task.workspaceId !== req.workspaceId) return null;
      store.updateTask(req.id, { status: "paused", nextRunAt: null }, systemClock.now());
      return detailOf(store, req.id);
    }
  );

  registerHandler<TaskIdRequest, TaskDetail | null>(
    CHANNELS.tasksResume,
    taskIdRequestSchema,
    (req) => {
      const store = taskStore();
      const task = store.getTask(req.id);
      if (!task || task.workspaceId !== req.workspaceId) return null;
      const now = systemClock.now();
      // resume 从**现在**起算下一次——错过的运行是否补，由 misfire 策略在 tick
      // 里处理，而不是 resume 时回溯到 pause 之前。
      store.updateTask(
        req.id,
        { status: "active", nextRunAt: nextRunAfter(task, now) },
        now
      );
      return detailOf(store, req.id);
    }
  );

  registerHandler<TaskIdRequest, TaskDetail | null>(
    CHANNELS.tasksRunNow,
    taskIdRequestSchema,
    async (req) => {
      const store = taskStore();
      const task = store.getTask(req.id);
      if (!task || task.workspaceId !== req.workspaceId) return null;
      await scheduler().runNow(task);
      return detailOf(store, req.id);
    }
  );

  registerHandler<RunIdRequest, TaskDetail | null>(
    CHANNELS.tasksCancelRun,
    runIdRequestSchema,
    (req) => {
      const store = taskStore();
      const run = store.getRun(req.runId);
      if (!run || run.taskId !== req.taskId || run.workspaceId !== req.workspaceId) return null;
      scheduler().cancelRun(req.runId);
      return detailOf(store, req.taskId);
    }
  );

  registerHandler<RunIdRequest, TaskDetail | null>(
    CHANNELS.tasksRetryRun,
    runIdRequestSchema,
    async (req) => {
      const store = taskStore();
      const run = store.getRun(req.runId);
      if (!run || run.taskId !== req.taskId || run.workspaceId !== req.workspaceId) return null;
      await scheduler().retryRun(req.runId);
      return detailOf(store, req.taskId);
    }
  );

  registerHandler<TaskIdRequest, TaskDetail | null>(
    CHANNELS.tasksDuplicate,
    taskIdRequestSchema,
    (req) => {
      const store = taskStore();
      const src = store.getTask(req.id);
      if (!src || src.workspaceId !== req.workspaceId) return null;
      const now = systemClock.now();
      const copy = store.createTask(
        {
          workspaceId: src.workspaceId,
          name: `${src.name} 副本`,
          schedule: src.schedule,
          timezone: src.timezone,
          agent: src.agent,
          requiredPermissions: [...src.requiredPermissions],
          budgetUsd: src.budgetUsd,
          timeoutMs: src.timeoutMs,
          misfirePolicy: src.misfirePolicy,
          concurrencyPolicy: src.concurrencyPolicy,
          failurePolicy: src.failurePolicy,
        },
        now,
        nextRunAfter(src, now)
      );
      return detailOf(store, copy.id);
    }
  );

  // 真实触发接线（ISS-002）：把 task-trigger 的默认 stub 换成池化真实派生——
  // scheduler 一行不动，只换这一个注入实现（task-trigger.ts 的设计承诺兑现）。
  setAgentRunTrigger(createPoolRunTrigger());

  // 调度器：注册 handler 之后启动。它是 headless 常驻设施——用户关掉窗口，
  // tick 仍在主进程里推进。**测试进程里不起真实定时器**（VITEST 置位时跳过），
  // 单测直接构造自己的 Scheduler + ManualClock 调 tick，不依赖这个 interval。
  if (!process.env.VITEST) {
    scheduler().start();
  }
}

/**
 * 拆卸本能力的运行期资源（ADR-0002 D4 规则 4）：停调度器定时器 + 关 sqlite 句柄。
 * **tasks.db 里的任务与 run 一个都不动**（规则 5：卸载与删数据是两个动作）。
 */
export function disposeTasksResources(): void {
  sched?.stop();
  sched = null;
  closeTaskStore();
}
