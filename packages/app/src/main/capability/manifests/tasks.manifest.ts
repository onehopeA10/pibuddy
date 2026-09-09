/**
 * 能力清单：持久定时任务（common / Durable Tasks，AUT-101 第一批）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler / scheduler。
 * drift test 要能直接 import 它做对账，而对账的另一端是磁盘上的源码文本——
 * 一旦清单反过来依赖实现，「声明与实现是否一致」就退化成恒真。
 *
 * ## 为什么只申请 tasks.manage
 *
 * tasks 能力**自己的代码**不 readFile 用户文件、不 spawn、不出站。
 * `tasks.manage` 只挡住渲染层改调度表（创建 / 立即跑 / 删除）。
 * 无人值守 run 需要的能力权限仍在每个任务的 `requiredPermissions` 里，
 * 由 `task-permission` 按 workspace 预授权判定。
 *
 * **注意这与「任务需要哪些权限」是两个轴**：每个任务在 `requiredPermissions`
 * 里声明它触发的那次 run 可能需要的能力权限，那由主进程的 `task-permission`
 * 按 workspace 预授权判定（只认 allow-workspace，绝不继承交互会话的 allow-once）。
 * 那不是 tasks 能力自己申请的权限。
 *
 * ## teardown 声明的是调度器的常驻资源
 *
 * scheduler 持一个 setInterval 定时器 + 一个 sqlite 句柄。禁用能力时两者都要
 * 收（`disposeTasksResources`），**tasks.db 里的任务与 run 一条都不动**（D4
 * 规则 5：卸载与删数据是两个动作）。用「listener」这一类是因为定时器与句柄
 * 都不是子进程 / worker / watcher，没有反向源码特征，只需正向声明 + 一个真实的
 * dispose 导出（drift 4）。
 */
import { defineCapability, CHANNELS } from "@pibuddy/contract";

export const TASKS_CAPABILITY_ID = "common.tasks";

export const tasksCapability = defineCapability({
  manifestVersion: 1,
  id: TASKS_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "定时任务",
  description:
    "按计划（一次 / 每天 / 每周 / cron / 事件）持续触发 Agent run，带时区、错过运行策略、并发策略、失败重试、预算与超时；即使关掉窗口也照跑。",
  // appMin "0.0.0"：内置能力不可能比宿主更老。真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  permissions: ["tasks.manage"],
  channels: [
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
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.tasks.panel",
      title: "定时任务",
      module: "renderer/src/components/TasksPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    teardown: ["listener"],
  },
  exposure: {
    module: "main/tasks/tasks-ipc.ts",
    register: "registerTasksIpc",
    dispose: "disposeTasksResources",
  },
});
