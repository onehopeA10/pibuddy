/**
 * 能力清单：长期记忆（common / MEM-101 第一版）。
 *
 * 独立成文件（`manifests/memory.manifest.ts`）而不是塞进 workspace / artifacts
 * 那几个域目录：记忆是一个新的、自成一体的能力域，它的清单没有理由寄居在
 * 别人的目录里。清单是纯数据，被 capability-manifests.ts 聚合、被
 * capability-catalog.ts 装配。
 */
import { defineCapability, CHANNELS } from "@pibuddy/contract";

export const MEMORY_CAPABILITY_ID = "common.memory";

export const memoryCapability = defineCapability({
  manifestVersion: 1,
  id: MEMORY_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "长期记忆",
  description: "记住用户显式保存的事实、偏好与指令，在相关对话里注入参考；可查看、编辑、合并、排除、删除、导出。",
  // appMin 是 "0.0.0"：内置能力不可能比宿主更老。真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 唯一真正的权限是 workspace.read：读来源会话的原文作为「原始证据」
  // （memory-evidence.ts 的 createReadStream）。记忆本体存在自己的 sqlite 库里
  // （node:sqlite，不算 workspace.write），导出只返回文本、不经主进程写盘，
  // 因此不申请 workspace.write —— 申请了却没有对应的写调用，drift test 会变红，
  // 而那正是「声明与实现漂移」要防的事。
  permissions: ["workspace.read"],
  channels: [
    CHANNELS.memoryQuery,
    CHANNELS.memorySave,
    CHANNELS.memoryUpdate,
    CHANNELS.memoryMerge,
    CHANNELS.memoryDelete,
    CHANNELS.memoryExport,
    CHANNELS.memoryEvidence,
    CHANNELS.memoryHits,
    CHANNELS.memorySetInjection,
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "common.memory.panel",
      title: "记忆",
      module: "renderer/src/components/MemoryPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    // memory-store 持一个 sqlite 句柄，memory-inject 持一张命中 cache。禁用时
    // 两者都收（disposeMemoryResources），**memory.db 里的记忆一条不动**
    // （D4 规则 5：卸载与删数据是两个动作）。用「listener」这一类是因为命中
    // cache 与 sqlite 句柄都不是子进程 / worker / watcher，没有反向源码特征，
    // 只需正向声明 + 一个真实的 dispose 导出（drift 4）。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/memory/memory-ipc.ts",
    register: "registerMemoryIpc",
    dispose: "disposeMemoryResources",
  },
});
