/**
 * `window.piBuddy.home`（home.assistant / 智能家居 Phase B）。
 *
 * 五个方法、五条窄通道。渲染进程能表达的极限是「读/写当前工作区的 HA 端点
 * 配置、测一次连接、读只读实体快照与运行状态」——token 只进不出（能看到的
 * 极限是 {configured, last4}），**没有**任何「调服务 / 控制设备」入口：控制
 * 是 pi 回路内工具（home.assistant.call_service），经主进程 tool bridge 在
 * 会话里由 agent 调用。授权走既有的 window.piBuddy.permission.decide
 * （network.local 属危险权限，持久化过主进程原生确认框），不在本命名空间。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（不依赖 zod）。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  HaConfigState,
  HaEntitiesResult,
  HaStatusResult,
  HaTestConnectionResult,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const home = {
  /** 读当前工作区的端点配置 + token 配置态 + 授权态。 */
  configGet: (workspaceId: string) =>
    invoke<HaConfigState>(CHANNELS.haConfigGet, { workspaceId }),

  /** 写 host/port；token 空串 = 不改动既有 token（明文只进不出）。 */
  configSet: (workspaceId: string, host: string, port: number, token = "") =>
    invoke<HaConfigState>(CHANNELS.haConfigSet, { workspaceId, host, port, token }),

  /** 测试连接：三道关 → GET /api/（HA 返回 "API running."）。 */
  testConnection: (workspaceId: string) =>
    invoke<HaTestConnectionResult>(CHANNELS.haTestConnection, { workspaceId }),

  /** 实体只读快照（面板用；断线 / 冷启动快照会如实标 stale）。 */
  entities: (workspaceId: string, limit = 200) =>
    invoke<HaEntitiesResult>(CHANNELS.haEntities, { workspaceId, limit }),

  /** 运行状态：配置/授权/WS 会话/消费者计数/实体数。 */
  status: (workspaceId: string) => invoke<HaStatusResult>(CHANNELS.haStatus, { workspaceId }),
};
