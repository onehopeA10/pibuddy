/**
 * 能力清单：Slack 连接器（connector.slack）。
 *
 * 通用 webhook 基座之上的真实渠道适配器，`dependencies` 基座，只额外提供两条平台
 * 专属通道（slack:send / slack:receive）与一条 Slack 专属网络上界
 * （network:hooks.slack.com）。出站走 incoming webhook（体 `{text}`），入站走 Events
 * API（按 bot_id 防回环、识别 url_verification 握手）。
 *
 * 纯数据文件：不 import electron / handler，drift test 直接 import 做对账。
 */
import {
  defineCapability,
  CHANNELS,
  SLACK_CAPABILITY_ID,
  SLACK_DOMAIN,
  connectorNetworkPermission,
} from "@pibuddy/contract";

export const connectorSlackCapability = defineCapability({
  manifestVersion: 1,
  id: SLACK_CAPABILITY_ID,
  version: "1.0.0",
  tier: "connector",
  displayName: "Slack 连接器",
  description:
    "把 Agent 接到 Slack：incoming webhook 主动推送，入站 Events API 经共享守卫去重 / 防回环（bot_id）/ 限速。凭证加密留在本机，出站经权限授权、经安全守卫防 SSRF。",
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: ["connector.webhook"],
  permissions: [connectorNetworkPermission(SLACK_DOMAIN)],
  channels: [CHANNELS.slackSend, CHANNELS.slackReceive],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "connector.slack.panel",
      title: "Slack",
      module: "renderer/src/components/ConnectorChannelsPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: { loading: "inline", heavyDependencies: [], teardown: [] },
  exposure: {
    module: "main/connector/slack-ipc.ts",
    register: "registerSlackIpc",
  },
});
