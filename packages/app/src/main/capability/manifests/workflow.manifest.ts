/**
 * 能力清单：可视化工作流（common / workflow）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler / runner。
 * drift test 要能直接 import 它做对账，一旦清单反过来依赖实现，对账就退化成恒真。
 *
 * ## 为什么是 common tier（可关闭）
 *
 * 可视化工作流是**通用能力**（ADR-0002 四层边界表第二行）：把它关掉，单会话
 * 对话与其它能力照常工作，只是不能再编排 DAG 工作流。装卸它不影响单会话。
 *
 * ## 为什么 permissions 为空
 *
 * 工作流的**自身代码**（main/workflow/**）只做两件事：把定义 / 运行历史存进
 * 应用数据目录（sqlite，不碰用户工作区），以及把 Agent 节点的执行**委托**给
 * 后台会话池（`agentPool().requestSession`，池是内核设施）。真正的进程派生、
 * 文件读写、git 都发生在它调用的池 host（main/agent-pool/**）里，不在本能力域内。
 * 因此本能力一条权限都不申请，drift 的双向权限对账两个方向都成立。Agent 子会话
 * 各自运行时的权限请求，由池的统一 inbox 经既有权限引擎收口。
 *
 * ## teardown 声明的是 sqlite 句柄 + 广播接线这一层运行期资源
 *
 * 禁用能力时关掉 workflows.db 的句柄、摘掉 runner 的窗口广播接线
 * （`disposeWorkflowResources`），**磁盘上的定义与运行历史一个字节都不动**
 * （D4 规则 5：卸载与删数据是两个动作）。
 */
import { defineCapability, CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract";

export const WORKFLOW_CAPABILITY_ID = "common.workflow";

export const workflowCapability = defineCapability({
  manifestVersion: 1,
  id: WORKFLOW_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "可视化工作流",
  description:
    "在画布上编排 DAG 工作流：开始 / 结束 / 输入 / 输出 / Agent / 条件分支节点，有向边连线；按依赖顺序执行、节点间传数据、条件分支路由、循环依赖检测；运行历史、停止 / 重跑；工作流定义可导出 / 导入为可移植 JSON，按工作区隔离持久化。",
  // appMin "0.0.0"：内置能力不可能比宿主更老。真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 本能力自身不触达任何 workspace 副作用（存 userData sqlite，派生走内核池），
  // 因此一条权限都不申请。
  permissions: [],
  channels: [
    CHANNELS.workflowList,
    CHANNELS.workflowSave,
    CHANNELS.workflowDelete,
    CHANNELS.workflowExport,
    CHANNELS.workflowImport,
    CHANNELS.workflowRun,
    CHANNELS.workflowStop,
    CHANNELS.workflowRuns,
  ],
  pushChannels: [PUSH_CHANNELS.workflowEvent],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.workflow.panel",
      title: "工作流",
      module: "renderer/src/components/WorkflowPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  // 定义与运行历史落 sqlite（跨版本要迁移），因此 1。
  dataSchemaVersion: 1,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    // workflows.db 的 sqlite 句柄 + runner 的窗口广播接线，禁用时都要摘。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/workflow/workflow-ipc.ts",
    register: "registerWorkflowIpc",
    dispose: "disposeWorkflowResources",
  },
});
