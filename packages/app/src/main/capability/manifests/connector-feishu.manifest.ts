/**
 * 能力清单：飞书（Lark）连接器（connector.feishu）。
 *
 * 通用 webhook 基座（connector.webhook）之上的第一个**真实渠道适配器**。它
 * `dependencies` 基座——增删改启停、凭证保管、出站三关、入站守卫全复用基座那套，
 * 本能力只额外提供两条平台专属通道（feishu:send / feishu:receive）与一条飞书专属的
 * 网络上界（network:open.feishu.cn）。
 *
 * ## 为什么权限恰是一条 network:open.feishu.cn
 *
 * 飞书连接器只往飞书自定义机器人 webhook 发，越不过 open.feishu.cn。它不碰用户
 * 文件、不起子进程、不开外部程序——多申请一条权限，drift 权限对账（声明 == 实际
 * 用到）会当场变红。出站 safeFetch 在 connector-outbound.ts（exposure.module 同目录），
 * 权限对账据此对本能力成立。
 *
 * ## 为什么本文件是纯数据
 *
 * 不 import electron，也不 import handler。drift test 要能直接 import 它做对账。
 */
import {
  defineCapability,
  CHANNELS,
  FEISHU_CAPABILITY_ID,
  FEISHU_DOMAIN,
  connectorNetworkPermission,
} from "@pibuddy/contract";

export const connectorFeishuCapability = defineCapability({
  manifestVersion: 1,
  id: FEISHU_CAPABILITY_ID,
  version: "1.0.0",
  tier: "connector",
  displayName: "飞书连接器",
  description:
    "把 Agent 接到飞书（Lark）：自定义机器人 webhook 主动推送（msg_type/content 按官方文档拼、成功看 code），入站事件 v2 经共享守卫去重 / 防回环（sender_type）/ 限速。凭证加密留在本机，出站经权限授权、经安全守卫防 SSRF。",
  compatibility: { appMin: "0.0.0", contractMin: 1, contractMax: 1 },
  // 依赖通用 webhook 基座：增删改启停、库、入站守卫、出站原语全在基座那侧，
  // 本能力只加平台适配。基座未启用时本能力被引擎判为依赖未满足而不启用。
  dependencies: ["connector.webhook"],
  permissions: [connectorNetworkPermission(FEISHU_DOMAIN)],
  channels: [CHANNELS.feishuSend, CHANNELS.feishuReceive],
  pushChannels: [],
  tools: [],
  uiContributions: [
    {
      slot: "drawer.tab",
      id: "connector.feishu.panel",
      title: "飞书",
      module: "renderer/src/components/ConnectorChannelsPanel.vue",
      host: "renderer/src/components/AppShell.vue",
    },
  ],
  settingsSchema: [],
  dataSchemaVersion: 1,
  // 无自有运行期资源：库与入站守卫由基座持有、由基座的 disposeConnectorResources
  // 一并收（本能力 dependencies 基座，二者同启同停）。teardown 为空 → 无需 dispose。
  runtime: { loading: "inline", heavyDependencies: [], teardown: [] },
  exposure: {
    module: "main/connector/feishu-ipc.ts",
    register: "registerFeishuIpc",
  },
});
