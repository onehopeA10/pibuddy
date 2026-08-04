/**
 * 通用 webhook 基座适配器（connector.webhook）。
 *
 * 它是三个真实渠道的对照组：消息体就是 `{text}`，响应只看 HTTP 状态，域名是
 * manifest 声明的那张多平台白名单（飞书 / 钉钉 / 企微 / Slack / Discord 的自定义
 * 机器人 host + postman-echo 自检端点）。把它也做成一个适配器，是为了让出站层
 * 只有「resolveAdapter(kind) 然后照它拼」这一条路径——基座与真实渠道在出站上
 * 同构，没有一条 `if (kind === "webhook")` 的特例。
 */
import { CONNECTOR_CAPABILITY_ID, CONNECTOR_SUPPORTED_DOMAINS } from "@pibuddy/contract";

import {
  asRecord,
  readString,
  type ChannelAdapter,
  type InboundParse,
} from "./adapter.js";

/** 通用入站解析：接受一个已规范化的 `{message_id, text, from_self?}` 事件。 */
function parseGenericInbound(event: unknown): InboundParse {
  const record = asRecord(event);
  const messageId = readString(record, "message_id");
  const text = readString(record, "text");
  if (!record || messageId === null || text === null) {
    return { type: "malformed", detail: "缺少 message_id / text" };
  }
  return {
    type: "message",
    messageId,
    text,
    fromSelf: record["from_self"] === true,
    attachmentCount: 0,
    attachmentBytes: 0,
  };
}

export const webhookAdapter: ChannelAdapter = {
  kind: "webhook",
  capabilityId: CONNECTOR_CAPABILITY_ID,
  domains: CONNECTOR_SUPPORTED_DOMAINS,
  formatBody: (text) => ({ text }),
  checkResponse: (resp) => ({ ok: resp.ok, detail: resp.ok ? null : `HTTP ${resp.status}` }),
  parseInbound: parseGenericInbound,
};
