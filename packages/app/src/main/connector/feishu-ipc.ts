/**
 * 飞书渠道的 IPC handler（connector.feishu）——manifest 的 exposure.module。
 *
 * 只两条平台专属通道：`feishu:send`（主动推送，出站穿三关、体按飞书 msg_type/content
 * 拼、响应看 code）与 `feishu:receive`（把一条飞书事件 v2 喂给共享入站守卫，识别
 * url_verification 握手、按 sender_type 防回环）。增删改启停复用基座 connector:* 七条。
 *
 * 出站真正的 safeFetch 在 connector-outbound.ts（同目录）——drift 权限对账
 * （network:open.feishu.cn → 一次 safeFetch 调用）据此对本能力成立。
 */
import {
  CHANNELS,
  connectorInboundRequestSchema,
  connectorSendRequestSchema,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { deliverThrough, receiveThrough } from "./channel-delivery.js";

export const FEISHU_CHANNELS: InvokeChannel[] = [CHANNELS.feishuSend, CHANNELS.feishuReceive];

export function registerFeishuIpc(): void {
  registerHandler(CHANNELS.feishuSend, connectorSendRequestSchema, (payload) =>
    deliverThrough(payload.connectorId, payload.workspaceId, payload.text, "send")
  );
  registerHandler(CHANNELS.feishuReceive, connectorInboundRequestSchema, (payload) =>
    receiveThrough(payload.connectorId, payload.workspaceId, payload.event)
  );
}
