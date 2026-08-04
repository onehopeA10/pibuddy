/**
 * 智能家居监控面板包的 IPC handler 与运行期装配（home.dashboard，恰 3 条通道）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler，
 * 四道闸（主 frame → zod → 尺寸 → 限流）写死在那里。
 *
 * ## 三条通道就是全部的主进程面
 *
 * subscribe（登记面板消费者 + 快照）/ unsubscribe（释放）/ snapshot（只读）。
 * 设备**控制**不在 IPC 面上——控制走会话对话（pi 回路内工具，经基座 tool
 * bridge 三道关），面板拿到的只是只读快照与增量。本目录因此一个权限特征都
 * 没有（permissions: []）：数据全部经基座的 HomeAssistantService 取得，出站
 * 与落盘的权限归属基座（drift 3 的双向对账据此闭合）。
 *
 * ## activate / deactivate
 *
 * registerHomeDashboardIpc（activate）：注册 3 条通道。装配期不动点保证基座
 * （manifest.dependencies: ["home.assistant"]）未启用时本函数一次都不被调用。
 * disposeHomeDashboardResources（deactivate / runtime.teardown:["listener"]）：
 * 释放全部面板消费者 + 摘缓存变更监听——不释放的话基座的引用计数永不归零，
 * WS 长连接就成了「面板关了还连着」的死角。本包无自有持久化数据。
 */
import {
  CHANNELS,
  PUSH_CHANNELS,
  dashboardSnapshotRequestSchema,
  dashboardSubscribeRequestSchema,
  dashboardUnsubscribeRequestSchema,
  type DashboardEventPayload,
  type PiEnvelope,
} from "@pibuddy/contract";
import { BrowserWindow } from "electron";

import { registerHandler } from "../ipc-guard.js";
import { homeAssistantService } from "../home/home-ipc.js";
import { HomeDashboardService } from "./dashboard-service.js";

/** 本能力注册的全部通道。导出成常量供对账「恰 3 条」。 */
export const HOME_DASHBOARD_CHANNELS = [
  CHANNELS.dashboardSubscribe,
  CHANNELS.dashboardUnsubscribe,
  CHANNELS.dashboardSnapshot,
] as const;

/** 把一个增量信封广播到所有窗口（与 terminal:event 同一手法）。 */
function broadcast(envelope: PiEnvelope<DashboardEventPayload>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(PUSH_CHANNELS.dashboardEvent, envelope);
  }
}

let serviceInstance: HomeDashboardService | null = null;

function service(): HomeDashboardService {
  if (!serviceInstance) {
    serviceInstance = new HomeDashboardService({
      // 必须落在基座**同一个**服务实例的缓存上，计数才是同一本账。
      cache: (workspaceId) => homeAssistantService().cache(workspaceId),
      broadcast,
    });
  }
  return serviceInstance;
}

/** 禁用 / 退出时的拆卸（runtime.teardown:["listener"]）。 */
export function disposeHomeDashboardResources(): void {
  if (serviceInstance) {
    serviceInstance.dispose();
    serviceInstance = null;
  }
}

export function registerHomeDashboardIpc(): void {
  registerHandler(CHANNELS.dashboardSubscribe, dashboardSubscribeRequestSchema, async (payload) =>
    service().subscribe(payload.workspaceId, payload.limit)
  );

  registerHandler(
    CHANNELS.dashboardUnsubscribe,
    dashboardUnsubscribeRequestSchema,
    async (payload) => service().unsubscribe(payload.workspaceId)
  );

  registerHandler(CHANNELS.dashboardSnapshot, dashboardSnapshotRequestSchema, async (payload) =>
    service().snapshot(payload.workspaceId, payload.limit)
  );
}
