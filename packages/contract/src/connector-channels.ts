/**
 * 三个真实渠道适配器的契约（connector.feishu / connector.slack / connector.telegram）。
 *
 * ## 为什么单独一个文件，而不是塞进 connector.ts
 *
 * `connector.ts` 是通用 webhook **基座**的契约（七条 CRUD + 出站通道）。三个真实
 * 渠道是在基座之上各加一层平台适配，它们共享基座的实例模型（ConnectorView /
 * ConnectorResult）与凭证/出站/入站三套机制，只在**消息体拼装**与**入站事件解析**
 * 上各不相同。把这层平台差异收在本文件，基座契约保持只讲 webhook 一件事。
 *
 * ## 每个渠道恰两条窄通道
 *
 *   - `<平台>:send`：主动推送一段文本。入参与基座 `connector:send` 同形
 *     （connectorId + workspaceId + text），出站真正穿过三关（域名上界 → workspace
 *     授权 → safeFetch），只是消息体按平台文档拼。**渲染进程表达不出「往任意
 *     地址发」**，也永远拿不到凭证——与基座同一口径。
 *   - `<平台>:receive`：把一条平台**入站事件**喂给共享入站守卫。它先由适配器
 *     按平台结构解析（并识别「这是不是我们自己发的」以**防回环**），再走去重 /
 *     限速 / 尺寸判定；若事件是平台的 url_verification 握手，则回声 challenge。
 *     这条通道**不开常驻监听端口**（连接器 v1 刻意不引入常驻入站攻击面），它让
 *     入站解析 + 守卫这条纯逻辑链路可被渲染层 / 真机取证直接喂事件跑通。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";
import { connectorResultSchema, connectorSendRequestSchema } from "./connector.js";

/**
 * 一条平台入站事件的准入请求。
 *
 * `event` 是平台原样投递的 JSON（飞书事件 v2 / Slack Events API / Telegram
 * Update），结构因平台而异，故此处不约束其内部形状——由各适配器的 `parseInbound`
 * 负责解析。workspaceId 是这条连接器绑定的工作区（隔离键），随事件一起交给守卫。
 */
export const connectorInboundRequestSchema = z
  .object({
    connectorId: z.string().min(1),
    workspaceId: z.string().min(1),
    event: z.unknown(),
  })
  .strict();
export type ConnectorInboundRequest = z.infer<typeof connectorInboundRequestSchema>;

/** 入站被拒 / 忽略的原因分类。 */
export const connectorInboundReasonSchema = z.enum([
  "loop", // 我们自己发出去的消息（防回环）
  "duplicate", // 平台重投的同一条（去重）
  "rate", // 超过单连接器窗口限速
  "oversize", // 正文 / 附件超上限
  "malformed", // 事件结构解析不出一条可交给 Agent 的消息
]);
export type ConnectorInboundReason = z.infer<typeof connectorInboundReasonSchema>;

/**
 * 一条入站事件的处理结果。
 *
 *   - `challenge`：事件是平台的 url_verification 握手，`challenge` 字段是要原样
 *     回声给平台的值（飞书 / Slack 首次配置回调 URL 时的校验）。
 *   - `accepted`：通过四道关，会交给 Agent。
 *   - `rejected`：被某一道关挡下，`reason` 指出是哪一类。
 */
export const connectorInboundResultSchema = z
  .object({
    outcome: z.enum(["challenge", "accepted", "rejected"]),
    /** url_verification 的回声值；非握手时为 null */
    challenge: z.string().nullable(),
    /** 被拒时的原因分类；challenge / accepted 时为 null */
    reason: connectorInboundReasonSchema.nullable(),
    detail: z.string(),
  })
  .strict();
export type ConnectorInboundResult = z.infer<typeof connectorInboundResultSchema>;

/** 一个渠道的两条通道契约（send + receive）。分片 id = capabilityId 的第二段。 */
function channelShard(id: "feishu" | "slack" | "telegram", send: string, receive: string) {
  return defineContractShard(id, {
    [send]: { request: connectorSendRequestSchema, response: connectorResultSchema },
    [receive]: {
      request: connectorInboundRequestSchema,
      response: connectorInboundResultSchema,
    },
  });
}

export const feishuContractShard = channelShard(
  "feishu",
  CHANNELS.feishuSend,
  CHANNELS.feishuReceive
);
export const slackContractShard = channelShard("slack", CHANNELS.slackSend, CHANNELS.slackReceive);
export const telegramContractShard = channelShard(
  "telegram",
  CHANNELS.telegramSend,
  CHANNELS.telegramReceive
);
