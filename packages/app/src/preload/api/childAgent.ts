/**
 * `window.piBuddy.childAgent`（AGT-102，第 22 个命名空间）。
 *
 * 渲染进程能表达的极限：取拓扑、创建子、取消（向子树传播）、回答子的结构化
 * 提问、裁决子 worktree 改动的合并，外加订阅拓扑推送。一律以不透明 nodeId 或
 * 结构化子规格为入参——既塞不进一个运行时句柄，也表达不出「让某进程跑什么
 * 命令」（子的真实进程派生在主进程的后台池侧）。
 *
 * 拓扑推送 `onSnapshot` 收到的是完整 `PiEnvelope<ChildTopologySnapshot>`：preload
 * 不剥壳，generation/sequence 只有送到渲染进程才用得上（与 agentPool 同口径）。
 *
 * CHANNELS / PUSH_CHANNELS 只能从 `@pibuddy/contract/channels` 引（不依赖 zod）。
 */
import { CHANNELS, PUSH_CHANNELS } from "@pibuddy/contract/channels";
import type {
  ChildSpec,
  ChildTopologySnapshot,
  PiEnvelope,
} from "@pibuddy/contract";
import { invoke, subscribe } from "./bridge.js";

export const childAgent = {
  /** 取整棵编排拓扑（父子关系、状态、成本、证据、结果、限流视图）。 */
  describe: () => invoke<ChildTopologySnapshot>(CHANNELS.childAgentDescribe, {}),

  /** 父创建一个子 Agent（parentId=null 表示用户直接创建的顶层子）。 */
  create: (parentId: string | null, spec: ChildSpec) =>
    invoke<ChildTopologySnapshot>(CHANNELS.childAgentCreate, { parentId, spec }),

  /** 取消某节点：向它的整棵子树传播。 */
  cancel: (nodeId: string) =>
    invoke<ChildTopologySnapshot>(CHANNELS.childAgentCancel, { nodeId }),

  /** 回答某子 Agent 的一条结构化提问。 */
  answer: (nodeId: string, questionId: string, answer: string) =>
    invoke<ChildTopologySnapshot>(CHANNELS.childAgentAnswer, { nodeId, questionId, answer }),

  /** 裁决某子 Agent 的 worktree 改动合并（accept / reject）。 */
  resolveMerge: (nodeId: string, accept: boolean) =>
    invoke<ChildTopologySnapshot>(CHANNELS.childAgentResolveMerge, { nodeId, accept }),

  /** 订阅拓扑推送（PiEnvelope<ChildTopologySnapshot>），返回退订闭包。 */
  onSnapshot: (cb: (e: PiEnvelope<ChildTopologySnapshot>) => void) =>
    subscribe(PUSH_CHANNELS.childAgentEvent, cb as (p: unknown) => void),
};
