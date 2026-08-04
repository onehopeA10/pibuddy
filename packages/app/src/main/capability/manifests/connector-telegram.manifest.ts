/**
 * 能力清单：Telegram 连接器（connector.telegram）。
 *
 * 通用 webhook 基座之上的真实渠道适配器，`dependencies` 基座，只额外提供两条平台
 * 专属通道（telegram:send / telegram:receive）与一条 Telegram 专属网络上界
 * （network:api.telegram.org）。出站走 Bot API sendMessage（chat_id 随凭证 URL 落、
 * 体 `{text}`、成功看 ok），入站走 Update 对象（按 from.is_bot 防回环、update_id 去重）。
 *
 * 纯数据文件：不 import electron / handler，drift test 直接 import 做对账。
 */
import {
  defineCapability,
  CHANNELS,
  TELEGRAM_CAPABILITY_ID,
  TELEGRAM_DOMAIN,
  connectorNetworkPermission,
} from "@pibuddy/contract";

export const connectorTelegramCapability = defineCapability({
  manifestVersion: 1,
  id: TELEGRAM_CAPABILITY_ID,
  version: "1.0.0",
  tier: "connector",
  displayName: "Telegram 连接器",
  description:
    "把 Agent 接到 Telegram：Bot API sendMessage 主动推送（chat_id 随凭证 URL、成功看 ok），入站 Update 经共享守卫去重（update_id）/ 防回环（from.is_bot）/ 限速。凭证加密留在本机，出站经权限授权、经安全守卫防 SSRF。",
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: ["connector.webhook"],
  permissions: [connectorNetworkPermission(TELEGRAM_DOMAIN)],
  channels: [CHANNELS.telegramSend, CHANNELS.telegramReceive],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "connector.telegram.panel",
      title: "Telegram",
      module: "renderer/src/components/ConnectorChannelsPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: { loading: "inline", heavyDependencies: [], teardown: [] },
  exposure: {
    module: "main/connector/telegram-ipc.ts",
    register: "registerTelegramIpc",
  },
});
