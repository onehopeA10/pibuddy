/**
 * MCP 服务器管理的 IPC handler（能力包 common.mcp，恰 6 条通道）。
 *
 * 与 pi-resources-ipc.ts 同构：本文件不出现 ipcMain.handle，注册一律经
 * ipc-guard 的 registerHandler（四道闸写死在那里）。
 *
 * ## 边界
 *
 *  - 启停 / 连接测试收的是不透明服务器 `id`：main 侧按 id 从磁盘配置查出
 *    command/args 再 spawn（shell:false），渲染进程给不出命令行。
 *  - save 由渲染进程给出配置（与 pi-resources 的 install 同构）：那是用户在
 *    界面上填的自己的服务器，写盘前经 mcpServerInputSchema + main 侧再校验；
 *    回读时 env / header 的值被脱敏（`toDescriptor` 只留键名）。
 *
 * `disposeMcpResources` 是本能力的拆卸入口（manifest.exposure.dispose）：
 * 它就是 mcp-service 的 kill-all 的一层壳——drift test 要求 dispose 必须是
 * exposure.module（本文件）的真实导出，因此在这里落一个具名导出，而不是
 * 从别处 re-export（re-export 不带 `export function` 特征，对账扫不到）。
 */
import {
  CHANNELS,
  mcpIdRequestSchema,
  mcpListRequestSchema,
  mcpRemoveRequestSchema,
  mcpSaveRequestSchema,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import {
  currentProjectTrust,
  onProjectTrustChange,
} from "../pi-resources/project-trust.js";
import { removeServer, saveServer } from "./mcp-config.js";
import { registerMcpPermissionRequirements } from "./mcp-permission.js";
import {
  disposeMcpResources as killAllMcpProcesses,
  listServers,
  startServer,
  stopProjectServers,
  stopServer,
  stopServersByRef,
  testServer,
} from "./mcp-service.js";

let removeTrustListener: (() => void) | null = null;

/** 本能力注册的全部通道。单测据它断言注册面。 */
export const MCP_CHANNELS: InvokeChannel[] = [
  CHANNELS.mcpList,
  CHANNELS.mcpSave,
  CHANNELS.mcpRemove,
  CHANNELS.mcpTest,
  CHANNELS.mcpStart,
  CHANNELS.mcpStop,
];

export function registerMcpIpc(): void {
  registerMcpPermissionRequirements();
  removeTrustListener?.();
  removeTrustListener = onProjectTrustChange(async (workspaceId, state) => {
    if (state.effective !== "allow") await stopProjectServers(workspaceId);
  });

  registerHandler(CHANNELS.mcpList, mcpListRequestSchema, (payload) =>
    listServers(payload.workspaceId)
  );

  registerHandler(CHANNELS.mcpSave, mcpSaveRequestSchema, async (payload) => {
    if (payload.scope === "project") {
      const trust = await currentProjectTrust(payload.workspaceId);
      if (trust.effective !== "allow") {
        throw new Error("MCP_PROJECT_NOT_TRUSTED: 项目 MCP 配置尚未受信，未保存");
      }
    }
    await stopServersByRef(payload.workspaceId, payload.scope, payload.config.name);
    await saveServer(payload.workspaceId, payload.scope, payload.config);
    return listServers(payload.workspaceId);
  });

  registerHandler(CHANNELS.mcpRemove, mcpRemoveRequestSchema, async (payload) => {
    await stopServersByRef(payload.workspaceId, payload.scope, payload.name);
    await removeServer(payload.workspaceId, payload.scope, payload.name);
    return listServers(payload.workspaceId);
  });

  registerHandler(CHANNELS.mcpTest, mcpIdRequestSchema, (payload) =>
    testServer(payload.workspaceId, payload.id)
  );

  registerHandler(CHANNELS.mcpStart, mcpIdRequestSchema, (payload) =>
    startServer(payload.workspaceId, payload.id)
  );

  registerHandler(CHANNELS.mcpStop, mcpIdRequestSchema, (payload) =>
    stopServer(payload.workspaceId, payload.id)
  );
}

/** 禁用 / 退出时 kill 全部活进程（manifest.runtime.teardown = ["child-process"]）。 */
export function disposeMcpResources(): void {
  removeTrustListener?.();
  removeTrustListener = null;
  killAllMcpProcesses();
}
