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
  // 权限有二：
  //   workspace.read —— 读来源会话原文作为「原始证据」/ 抽取候选事实
  //     （memory-evidence.ts / memory-extract.ts 的 createReadStream）。
  //   network:<域名> —— 语义检索的 Provider 嵌入（memory-embed.ts 走 safeFetch 到
  //     Provider 的 /embeddings 端点）。**只申报确有 OpenAI 兼容嵌入端点、且在
  //     Provider 目录里的域名**——权限预览里写的域名就是真会连的域名。`network:*`
  //     通配被禁；自定义端点（任意域名）的嵌入留待权限引擎能表达「按工作区放行
  //     某域名」之后再做（与 mcp 缓上 http 连接同源）。默认后端是本地哈希嵌入，
  //     不连任何网络，因此不配 key 也能用语义检索。
  // 记忆 / 知识 / 向量本体都存在自己的 sqlite 库里（node:sqlite，不算
  // workspace.write），导出只返回文本、不经主进程写盘，因此不申请 workspace.write。
  permissions: ["workspace.read", "network:api.openai.com", "network:api.mistral.ai"],
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
    // v2：语义检索 + 知识库 + 有限抽取
    CHANNELS.memorySearch,
    CHANNELS.memoryEmbedStatus,
    CHANNELS.memoryReembed,
    CHANNELS.memoryExtract,
    CHANNELS.memoryKnowledgeAdd,
    CHANNELS.memoryKnowledgeSearch,
    CHANNELS.memoryKnowledgeList,
    CHANNELS.memoryKnowledgeGet,
    CHANNELS.memoryKnowledgeDelete,
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
  // v2：新增 embeddings / knowledge / knowledge_fts 表（migrate 只加表、不动 v1 数据）。
  dataSchemaVersion: 2,
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
