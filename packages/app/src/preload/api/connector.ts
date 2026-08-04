/**
 * `window.piBuddy.connector`（connector.webhook / CON-101）。
 *
 * 七个方法、七条窄通道。渲染进程能表达的极限是「列举 / 建 / 改 / 删 / 启停 /
 * 自检 / 推送一段文本」——**没有**任何能承载「往任意地址发」的形参，也没有
 * `invoke(channel, args)` 那种无约束入口（D4 规则 1）。凭证（完整 webhook URL）
 * 只进不出：create / update 把它送进去，但没有任何方法能把它取回来，list 返回
 * 的只有 {domain, configured, last4}。真正的出站在主进程，且只走 safeFetch、
 * 逐域名经权限引擎授权。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS, type InvokeChannel } from "@pibuddy/contract/channels";
import type {
  ConnectorInboundResult,
  ConnectorKind,
  ConnectorResult,
  ConnectorView,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

/** kind → 该渠道的 send / receive 通道名（基座 webhook 无平台通道，走 connector:send）。 */
const CHANNEL_SEND: Record<ConnectorKind, InvokeChannel> = {
  webhook: CHANNELS.connectorSend,
  feishu: CHANNELS.feishuSend,
  slack: CHANNELS.slackSend,
  telegram: CHANNELS.telegramSend,
};
const CHANNEL_RECEIVE: Record<Exclude<ConnectorKind, "webhook">, InvokeChannel> = {
  feishu: CHANNELS.feishuReceive,
  slack: CHANNELS.slackReceive,
  telegram: CHANNELS.telegramReceive,
};

export const connector = {
  /** 全部连接器实例（无凭证）。 */
  list: () => invoke<ConnectorView[]>(CHANNELS.connectorList),

  /**
   * 新建一个连接器。url 是密令承载体，只进不出。
   * kind 省略 = 通用 webhook；给 feishu / slack / telegram 建对应渠道（域名上界按渠道判）。
   */
  create: (displayName: string, url: string, kind: ConnectorKind = "webhook") =>
    invoke<ConnectorView[]>(CHANNELS.connectorCreate, { kind, displayName, url }),

  /** 改名与 / 或轮换凭证。url 省略 = 只改名，保留原凭证。 */
  update: (connectorId: string, patch: { displayName?: string; url?: string }) =>
    invoke<ConnectorView[]>(CHANNELS.connectorUpdate, { connectorId, ...patch }),

  /** 删除一个连接器（连同凭证与入站状态）。 */
  remove: (connectorId: string) =>
    invoke<ConnectorView[]>(CHANNELS.connectorRemove, { connectorId }),

  /** 启停一个连接器。 */
  setEnabled: (connectorId: string, enabled: boolean) =>
    invoke<ConnectorView[]>(CHANNELS.connectorSetEnabled, { connectorId, enabled }),

  /** 连接自检：向配置的 webhook 发一次最小请求（需该域名已被 workspace 授权）。 */
  test: (connectorId: string, workspaceId: string) =>
    invoke<ConnectorResult>(CHANNELS.connectorTest, { connectorId, workspaceId }),

  /** Agent 主动推送一段文本（基座通道，按连接器自身 kind 的适配器出站）。 */
  send: (connectorId: string, workspaceId: string, text: string) =>
    invoke<ConnectorResult>(CHANNELS.connectorSend, { connectorId, workspaceId, text }),

  /**
   * 经**指定渠道的平台通道**推送一段文本（feishu:send / slack:send / telegram:send，
   * webhook 回落到基座 connector:send）。消息体按平台文档拼、授权按平台 capabilityId 判。
   */
  sendVia: (kind: ConnectorKind, connectorId: string, workspaceId: string, text: string) =>
    invoke<ConnectorResult>(CHANNEL_SEND[kind], { connectorId, workspaceId, text }),

  /**
   * 把一条平台入站事件喂给共享入站守卫（feishu / slack / telegram:receive）：解析 →
   * 防回环 / 去重 / 限速 / 尺寸，或应答 url_verification 握手。用于框架自检 / 真机取证；
   * v1 不开常驻入站端口，故入站由此显式喂入而非平台主动 POST。
   */
  receive: (
    kind: Exclude<ConnectorKind, "webhook">,
    connectorId: string,
    workspaceId: string,
    event: unknown
  ) => invoke<ConnectorInboundResult>(CHANNEL_RECEIVE[kind], { connectorId, workspaceId, event }),
};
