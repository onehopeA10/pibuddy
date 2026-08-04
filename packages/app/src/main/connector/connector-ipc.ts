/**
 * 连接器 v1 基座的 IPC handler（connector.webhook / CON-101）。
 *
 * 本文件不出现 `ipcMain.handle`：注册一律经 ipc-guard 的 registerHandler（四道闸
 * 写死在那里）。它是能力 manifest 的 `exposure.module`——drift test 据它数「注册
 * 函数体里 registerHandler 了哪几条通道」再与 manifest.channels 对账。
 *
 * ## 增删改启停对所有 kind 通用
 *
 * connector:create 收 kind（webhook / feishu / slack / telegram），域名上界按 kind
 * 对应的适配器判。connector:list 返回全部实例（含 kind 字段）。connector:test/send
 * 的出站授权按连接器自身 kind 的适配器 capabilityId 判（见 channel-delivery）。
 * 三个真实渠道**只额外**加 `<平台>:send/receive` 两条平台专属通道，CRUD 不重造。
 *
 * ## 凭证永不出主进程
 *
 * create / update 携带的完整 URL 经 manager 落进 secret-store；test / send 时由出站
 * 层从 secret-store 取出直接喂给 safeFetch。没有任何一条通道能把它送回渲染进程。
 */
import {
  CHANNELS,
  connectorCreateRequestSchema,
  connectorIdRequestSchema,
  connectorSendRequestSchema,
  connectorSetEnabledRequestSchema,
  connectorTestRequestSchema,
  connectorUpdateRequestSchema,
  voidRequestSchema,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { deliverThrough } from "./channel-delivery.js";
import {
  createConnector,
  listConnectors,
  removeConnector,
  setConnectorEnabled,
  updateConnector,
} from "./connector-manager.js";
import { ingestGuard } from "./connector-manager.js";
import { closeConnectorStore } from "./connector-store.js";

/** 本域注册的全部通道（导出供单测断言注册面）。 */
export const CONNECTOR_CHANNELS: InvokeChannel[] = [
  CHANNELS.connectorList,
  CHANNELS.connectorCreate,
  CHANNELS.connectorUpdate,
  CHANNELS.connectorRemove,
  CHANNELS.connectorSetEnabled,
  CHANNELS.connectorTest,
  CHANNELS.connectorSend,
];

export function registerConnectorIpc(): void {
  registerHandler(CHANNELS.connectorList, voidRequestSchema, () => listConnectors());

  registerHandler(CHANNELS.connectorCreate, connectorCreateRequestSchema, (payload) =>
    createConnector({ kind: payload.kind, displayName: payload.displayName, url: payload.url })
  );

  registerHandler(CHANNELS.connectorUpdate, connectorUpdateRequestSchema, (payload) =>
    updateConnector(payload)
  );

  registerHandler(CHANNELS.connectorRemove, connectorIdRequestSchema, (payload) =>
    removeConnector(payload.connectorId)
  );

  registerHandler(CHANNELS.connectorSetEnabled, connectorSetEnabledRequestSchema, (payload) =>
    setConnectorEnabled(payload.connectorId, payload.enabled)
  );

  registerHandler(CHANNELS.connectorTest, connectorTestRequestSchema, (payload) =>
    deliverThrough(payload.connectorId, payload.workspaceId, "PiBuddy 连接自检 ✅", "test")
  );

  registerHandler(CHANNELS.connectorSend, connectorSendRequestSchema, (payload) =>
    deliverThrough(payload.connectorId, payload.workspaceId, payload.text, "send")
  );
}

/**
 * 禁用能力 / 退出时的拆卸（D4 规则 4）。
 *
 * 关掉 sqlite 句柄（Windows 上 WAL 文件在句柄关掉前删不掉）+ 清空入站守卫的
 * 内存状态（去重环 / 限速窗口）。**connectors.db 与 secret-store 里的凭证一个
 * 字节都不动**（D4 规则 5：卸载与删数据是两个动作）。三个真实渠道复用同一份
 * 库与守卫，且依赖 connector.webhook（dependencies），因此它们的运行期资源也在
 * 这一处一并收干净——平台 manifest 无需各自声明拆卸。
 */
export function disposeConnectorResources(): void {
  ingestGuard().reset();
  closeConnectorStore();
}
