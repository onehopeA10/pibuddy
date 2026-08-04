/**
 * Telegram 渠道的 IPC handler（connector.telegram）——manifest 的 exposure.module。
 *
 * 只两条平台专属通道：`telegram:send`（Bot API sendMessage 主动推送，chat_id 随
 * 凭证 URL 落、体 `{text}`、响应看 ok）与 `telegram:receive`（把一条 Update 对象喂给
 * 共享入站守卫，按 from.is_bot 防回环、update_id 去重）。增删改启停复用基座
 * connector:* 七条。
 *
 * 出站真正的 safeFetch 在 connector-outbound.ts（同目录）——drift 权限对账
 * （network:api.telegram.org → 一次 safeFetch 调用）据此对本能力成立。
 */
import {
  CHANNELS,
  connectorInboundRequestSchema,
  connectorSendRequestSchema,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { deliverThrough, receiveThrough } from "./channel-delivery.js";

export const TELEGRAM_CHANNELS: InvokeChannel[] = [
  CHANNELS.telegramSend,
  CHANNELS.telegramReceive,
];

export function registerTelegramIpc(): void {
  registerHandler(CHANNELS.telegramSend, connectorSendRequestSchema, (payload) =>
    deliverThrough(payload.connectorId, payload.workspaceId, payload.text, "send")
  );
  registerHandler(CHANNELS.telegramReceive, connectorInboundRequestSchema, (payload) =>
    receiveThrough(payload.connectorId, payload.workspaceId, payload.event)
  );
}
