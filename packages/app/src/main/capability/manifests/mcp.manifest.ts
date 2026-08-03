/**
 * 能力清单：MCP 服务器管理（common / EXT-102 的 MCP 部分）。
 *
 * 本文件是**纯数据**：不 import electron，也不 import 本域的 handler。
 * 与其它域的 `*.capability.ts` 同一条纪律，只是按 FEAT-mcp 的要求放在
 * 独立的 manifests/ 目录下。drift test 对账读的是 `exposure.module`
 * （main/mcp/mcp-ipc.ts）与各宿主源码，与本文件的位置无关。
 *
 * ## tier 为什么是 common
 *
 * MCP 是 Agent 的**通用基础设施**——一套「把外部工具接进对话」的协议，
 * 不绑定任何垂直领域（编码 / 财务都可能用），也不是连接某个具体外部服务的
 * 连接器。因此归 common（通用能力，可关闭），与文件 / 预览 / 产物库并列。
 * 不放 vertical（它不属于某个领域包），也不放 connector（它是通用协议，
 * 不是「飞书 / Slack」这类单一服务接入）。
 *
 * ## 权限为什么是这三条
 *
 *  - `workspace.read` / `workspace.write`：读写 MCP 配置文件
 *    （`~/.pi/agent/mcp.json` 与 `<workspace>/.pi/mcp.json`）。drift test 的
 *    权限对账是**双向**的：源码里出现 `readFile(` / `writeJsonAtomic(` 就必须
 *    在这里申请，反之亦然。
 *  - `process.shell`：stdio 连接测试 / 启动要 `spawn` MCP 服务器进程。
 *
 * **没有** `network:<domain>`：本轮 stdio 连接测试不发任何网络请求（换行分隔
 * 的 JSON-RPC 跑在子进程管道上），源码里一处 `safeFetch(` 都没有；http / 远程
 * 连接测试与 OAuth 流程本轮未实现，原因记在 FEAT-mcp.md risks —— safeFetch
 * 阻断私网且仅放行 HTTPS，而任意用户主机无法用 `network:<domain>` 表达
 * （`network:*` 通配被禁）。等那一半落地、真的调 safeFetch 时再申请，
 * 否则会撞上「声明了却没用到」的正向对账。
 */
import { defineCapability, CHANNELS } from "@pibuddy/contract";

export const MCP_CAPABILITY_ID = "common.mcp";

export const mcpCapability = defineCapability({
  manifestVersion: 1,
  id: MCP_CAPABILITY_ID,
  version: "1.0.0",
  tier: "common",
  displayName: "MCP 服务器",
  description: "枚举、增删改、启停与连接测试 MCP（Model Context Protocol）服务器。",
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  permissions: ["workspace.read", "workspace.write", "process.shell"],
  channels: [
    CHANNELS.mcpList,
    CHANNELS.mcpSave,
    CHANNELS.mcpRemove,
    CHANNELS.mcpTest,
    CHANNELS.mcpStart,
    CHANNELS.mcpStop,
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "settings.section",
      id: "common.mcp.panel",
      title: "MCP 服务器",
      module: "renderer/src/components/McpPanel.vue",
      host: "renderer/src/components/PiResourcesPanel.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    // 现阶段随内核 bundle 一起装（ADR-0002 D1：第一阶段全部内置）。
    loading: "inline",
    heavyDependencies: [],
    // start 后 main 侧持有活着的 stdio 子进程；禁用 / 退出时 disposeMcpResources
    // 逐个 kill。child_process 的 import 是 drift 4 反查的源码特征。
    teardown: ["child-process"],
  },
  exposure: {
    module: "main/mcp/mcp-ipc.ts",
    register: "registerMcpIpc",
    dispose: "disposeMcpResources",
  },
});
