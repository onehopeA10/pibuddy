/**
 * 能力清单：会话树 / 分叉可视化（common / session-tree）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 * drift test 要能直接 import 它做对账，而对账的另一端是磁盘上的源码文本——
 * 一旦清单反过来依赖实现，「声明与实现是否一致」就退化成「实现与自己是否
 * 一致」，恒真。
 *
 * ## 这是被裁剪的「分叉」能力的补齐
 *
 * 数据面（fork / clone / get_tree / get_fork_messages / get_entries 的 pi RPC
 * 与 IPC 通道）在 TASK-009 已完整接入，当时明确「可视化分支图不在本轮交付
 * 范围内」（pi-ipc.ts 的注释）。本能力补上那块可视化 UI——M3 出口门禁明列
 * 却被裁剪的「分叉」能力。
 *
 * ## 为什么只申请 workspace.read
 *
 * 树的真相源是会话 JSONL（append-only、每条 entry 带 parentId）。本能力据
 * (workspaceId, sessionId) 反查出 sourcePath，**读**那个文件重建树——只读，
 * 不写、不开外部程序、不发出站请求、不碰密钥。刻意不走 pi 的 get_tree：那要
 * 持有 pi client，会把一个 common 能力钉死在 pi 域上（kernel-boundary 的允许表
 * 只减不增）。读 JSONL 只需 workspace.read，且天然按 workspaceId 分区。
 */
import { defineCapability, CHANNELS } from "@pibuddy/contract";

export const SESSION_TREE_CAPABILITY_ID = "common.session-tree";

export const sessionTreeCapability = defineCapability({
  manifestVersion: 1,
  id: SESSION_TREE_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "会话树",
  description: "把会话的分叉 / 分支 / 压缩 / 模型变化画成一棵可导航的树，并能从任一历史消息分叉。",
  // 内置能力不可能比宿主更老（同一份构建一起出厂），appMin 恒 "0.0.0"；对内置
  // 真正生效的是 contractMin/contractMax（宿主契约代际一旦 +1 就当场拒绝）。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 读会话 JSONL 重建树；只读，不写、不开外部程序、不出站、不碰密钥。
  permissions: ["workspace.read"],
  // 只有归一化视图这一条；fork / clone / get_fork_messages 是 pi runtime 的内核
  // 通道，恒可用，本能力不重复声明它们（否则会与 pi runtime 抢通道所有权）。
  channels: [CHANNELS.sessionTreeGraph],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.session-tree.panel",
      title: "会话树",
      module: "renderer/src/components/SessionTreePanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  // 不持有任何自有的持久化数据（树是活动会话的运行时状态），因此 0：没有需要
  // 跨版本迁移的数据代际。
  dataSchemaVersion: 0,
  runtime: {
    // 随内核 bundle 一起装（ADR-0002 D1 第一阶段全部内置）。面板是纯 SVG + Vue，
    // 没有重依赖，因此 inline 且无 teardown——它不开 watcher / worker / 子进程，
    // 唯一的运行期资源是渲染进程里的组件，随面板关闭自然回收。
    loading: "inline",
    heavyDependencies: [],
    teardown: [],
  },
  exposure: {
    module: "main/session-tree/session-tree-ipc.ts",
    register: "registerSessionTreeIpc",
  },
});
