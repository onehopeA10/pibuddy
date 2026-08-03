/**
 * 能力清单：child Agent 编排（common / child-agent，AGT-102）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler / orchestrator。
 * drift test 要能直接 import 它做对账，一旦清单反过来依赖实现，对账就退化成恒真。
 *
 * ## 为什么是 common tier（可关闭），而不是内核
 *
 * child 编排是**通用能力**（ADR-0002 四层边界表第二行）：把它关掉，单会话对话
 * 照常工作，只是不能再派生子 Agent。后台会话池本身是内核（不可关闭），但「父派
 * 生子、监督子树、裁决合并」这一层是一个可选的编排能力，装卸它不影响单会话。
 *
 * ## 为什么 permissions 为空
 *
 * child 编排**自己的代码**（main/child-agent/**）只做编排：维护父子拓扑、汇聚
 * 结构化消息、下发目标 / 取消 / 裁决。真正的进程派生、文件读写、git 都发生在它
 * **调用**的后台池 host（main/agent-pool/**，池是内核设施）里，不在本能力域内。
 * 因此本能力一条权限都不申请，drift 的双向权限对账（声明↔源码调用）两个方向都
 * 成立。子 Agent 各自运行时的权限请求，由池的统一 inbox 经既有权限引擎收口。
 *
 * ## teardown 声明的是维护节拍这一条常驻 listener
 *
 * orchestrator 持一个 setInterval（超时收口节拍）+ 池上两个已注册的事件汇聚回调。
 * 禁用能力时三者都要摘（`disposeChildAgentResources`），**核心里的编排数据一条
 * 不动**（D4 规则 5：卸载与删数据是两个动作；且编排数据本就只活在内存）。
 */
import { defineCapability, CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract";

export const CHILD_AGENT_CAPABILITY_ID = "common.child-agent";

export const childAgentCapability = defineCapability({
  manifestVersion: 1,
  id: CHILD_AGENT_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "子 Agent 编排",
  description:
    "父 Agent 派生子 Agent：给出目标 / 输入 / 工作区 / 模型 / 预算 / 权限继承 / 超时 / 交付物，展示父子拓扑、状态、成本、证据、结果；cancel 向子树传播，子结构化上报进展 / 提问 / 证据 / 结果，coding 子独立 worktree、合并前展示 diff。",
  // appMin "0.0.0"：内置能力不可能比宿主更老。真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 本能力自身不触达任何副作用（派生 / 读写 / git 都在它调用的内核池里），
  // 因此一条权限都不申请。
  permissions: [],
  channels: [
    CHANNELS.childAgentDescribe,
    CHANNELS.childAgentCreate,
    CHANNELS.childAgentCancel,
    CHANNELS.childAgentAnswer,
    CHANNELS.childAgentResolveMerge,
  ],
  pushChannels: [PUSH_CHANNELS.childAgentEvent],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.child-agent.panel",
      title: "子 Agent",
      module: "renderer/src/components/ChildAgentPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  // 编排数据是活动会话的运行时状态（不落盘），因此 0：没有跨版本迁移的数据代际。
  dataSchemaVersion: 0,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    // 维护节拍（setInterval）+ 池上两个事件汇聚回调，禁用时都要摘。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/child-agent/child-agent-ipc.ts",
    register: "registerChildAgentIpc",
    dispose: "disposeChildAgentResources",
  },
});
