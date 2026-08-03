/**
 * 能力清单：通用 Webhook 连接器（connector / connector.webhook / CON-101）。
 *
 * **第一个 connector tier 能力包**，用来验证 ADR-0002 的连接器链路：
 * 连接器声明 `network:<domain>` → 经核心 PermissionEngine 授权 → 可随 Profile
 * 装卸。这也是连接器层第一次有了可验证的实体（在此之前四层边界的第四行是空的）。
 *
 * ## 为什么权限是一串 `network:<domain>` 而不是一条通配
 *
 * ADR-0002 D3 拒绝 `network:*`：一条通配等于「任意出站」。因此连接器能达到的
 * 域名是一张固定白名单（`CONNECTOR_NETWORK_PERMISSIONS` 由
 * `CONNECTOR_SUPPORTED_DOMAINS` 派生），配置白名单之外的域名会在这条上界当场
 * 被拒。真正跑出站的地方在 `main/connector/connector-outbound.ts`，且只走
 * `net/outbound-guard.ts` 的 safeFetch——连内网 / 环回 / 元数据地址（SSRF）都
 * 由守卫挡下。
 *
 * ## 为什么本文件是纯数据
 *
 * 不 import electron，也不 import 本域的 handler。drift test 要能直接 import
 * 它做对账，一旦反过来依赖实现，「声明与实现是否一致」就退化成恒真。
 *
 * ## 本批范围
 *
 * v1 做**主动推送**（Agent → 外部平台）的完整出站链路 + 入站准入守卫
 * （去重 / 防回环 / 限速 / 附件上限，见 connector-ingest.ts）。真实的入站 HTTP
 * 回调服务器、多平台消息体格式化、图片 / 附件推送属后续（在本机不开监听端口，
 * 避免在 v1 就引入一个常驻入站端口的攻击面）。
 */
import {
  defineCapability,
  CHANNELS,
  CONNECTOR_CAPABILITY_ID,
  CONNECTOR_NETWORK_PERMISSIONS,
} from "@pibuddy/contract";

export const connectorWebhookCapability = defineCapability({
  manifestVersion: 1,
  id: CONNECTOR_CAPABILITY_ID,
  version: "1.0.0",
  tier: "connector",
  displayName: "Webhook 连接器",
  description:
    "把 Agent 接到外部协作平台（飞书 / 钉钉 / 企业微信 / Slack / Discord 的自定义机器人 webhook）：主动推送消息，凭证加密留在本机，出站域名经权限授权、经安全守卫防 SSRF。",
  // appMin "0.0.0"：内置能力不可能比宿主更老。真正生效的是 contractMin/Max。
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  dependencies: [],
  // 唯一权限是一串 network:<domain>（白名单，无通配）。出站时逐条经 PermissionEngine
  // 按 workspace 授权；未授权域名被拒。不申请 workspace.* / process.* / external.open：
  // 连接器只往外发消息，不碰用户文件、不起子进程、不开外部程序——申请了却没有对应
  // 调用，drift 权限对账会当场变红。
  permissions: [...CONNECTOR_NETWORK_PERMISSIONS],
  channels: [
    CHANNELS.connectorList,
    CHANNELS.connectorCreate,
    CHANNELS.connectorUpdate,
    CHANNELS.connectorRemove,
    CHANNELS.connectorSetEnabled,
    CHANNELS.connectorTest,
    CHANNELS.connectorSend,
  ],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "connector.webhook.panel",
      title: "连接器",
      module: "renderer/src/components/ConnectorPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  runtime: {
    loading: "inline",
    heavyDependencies: [],
    // connector-store 持一个 sqlite 句柄，ingest 守卫持去重环 / 限速窗口。禁用时
    // 两者都收（disposeConnectorResources），**connectors.db 与 secret-store 里的
    // 凭证一条不动**（D4 规则 5）。用「listener」这一类是因为 sqlite 句柄与内存
    // 状态都不是子进程 / worker / watcher，没有反向源码特征，只需正向声明 + 一个
    // 真实的 dispose 导出（drift 4）。
    teardown: ["listener"],
  },
  exposure: {
    module: "main/connector/connector-ipc.ts",
    register: "registerConnectorIpc",
    dispose: "disposeConnectorResources",
  },
});
