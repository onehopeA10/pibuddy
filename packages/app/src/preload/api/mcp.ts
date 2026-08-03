/**
 * `window.piBuddy.mcp` —— MCP 服务器管理（能力包 common.mcp）。
 *
 * 与 piResources 同一条纪律：启停 / 连接测试收的是扫描结果里的不透明服务器
 * `id`，不是命令行——真正的 `spawn` 只发生在主进程的 mcp-client.ts，
 * 渲染进程在结构上表达不出「执行这条命令」。save 收的是结构化配置（用户在
 * 界面上填的自己的服务器），env / header 的值在回读（list）时被脱敏。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  McpConnectionResult,
  McpListResult,
  McpScope,
  McpServerInput,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const mcp = {
  /** 枚举 user + project 两来源的全部 MCP 服务器（含活进程状态） */
  list: (workspaceId: string) => invoke<McpListResult>(CHANNELS.mcpList, { workspaceId }),
  /** 新建 / 更新一台服务器（按 name upsert）。返回刷新后的权威列表 */
  save: (workspaceId: string, scope: McpScope, config: McpServerInput) =>
    invoke<McpListResult>(CHANNELS.mcpSave, { workspaceId, scope, config }),
  /** 删除一台服务器 */
  remove: (workspaceId: string, scope: McpScope, name: string) =>
    invoke<McpListResult>(CHANNELS.mcpRemove, { workspaceId, scope, name }),
  /** 连接测试：真的连一次，握手完回收进程。入参是 id，不是命令 */
  test: (workspaceId: string, id: string) =>
    invoke<McpConnectionResult>(CHANNELS.mcpTest, { workspaceId, id }),
  /** 启动：握手成功则保留活进程 */
  start: (workspaceId: string, id: string) =>
    invoke<McpConnectionResult>(CHANNELS.mcpStart, { workspaceId, id }),
  /** 停止活进程，返回刷新后的列表 */
  stop: (workspaceId: string, id: string) =>
    invoke<McpListResult>(CHANNELS.mcpStop, { workspaceId, id }),
};
