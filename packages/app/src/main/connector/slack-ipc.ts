/**
 * Slack 渠道的 IPC handler（connector.slack）——manifest 的 exposure.module。
 *
 * 只两条平台专属通道：`slack:send`（incoming webhook 主动推送，体 `{text}`）与
 * `slack:receive`（把一条 Slack Events API 事件喂给共享入站守卫，识别
 * url_verification 握手、按 bot_id 防回环）。增删改启停复用基座 connector:* 七条。
 *
 * 出站真正的 safeFetch 在 connector-outbound.ts（同目录）——drift 权限对账
 * （network:hooks.slack.com → 一次 safeFetch 调用）据此对本能力成立。
 */
import {
  CHANNELS,
  connectorInboundRequestSchema,
  connectorSendRequestSchema,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import { deliverThrough, receiveThrough } from "./channel-delivery.js";

export const SLACK_CHANNELS: InvokeChannel[] = [CHANNELS.slackSend, CHANNELS.slackReceive];

export function registerSlackIpc(): void {
  registerHandler(CHANNELS.slackSend, connectorSendRequestSchema, (payload) =>
    deliverThrough(payload.connectorId, payload.workspaceId, payload.text, "send")
  );
  registerHandler(CHANNELS.slackReceive, connectorInboundRequestSchema, (payload) =>
    receiveThrough(payload.connectorId, payload.workspaceId, payload.event)
  );
}
