/**
 * Slack 适配器（connector.slack）。
 *
 * ## 出站：Incoming Webhook（文档：api.slack.com/messaging/webhooks）
 *
 * `POST https://hooks.slack.com/services/T.../B.../<secret>`，体 `{ "text": "..." }`。
 * 整条 URL 是凭证，走 secret-store。成功回 HTTP 200 + 纯文本 `ok`；失败回非 2xx +
 * 错误串（如 `invalid_payload` / `channel_not_found`），故响应判读以 HTTP 状态为准。
 *
 * ## 入站：Events API（文档：docs.slack.dev/apis/events-api）
 *
 *   - 首次配置 Request URL 时平台发 `{type:"url_verification", challenge}`，回声
 *     challenge 即可（注意它**不**包在 event_callback 外层里，是裸的三字段对象）。
 *   - 真实消息包在 `{type:"event_callback", event:{type:"message", ...}}` 里。
 *     **防回环**：`event.bot_id` 存在或 `subtype==="bot_message"` 即机器人消息
 *     （含我们自己发出去的），一律不回灌给 Agent——这正是 Slack 官方避免机器人
 *     自触发的推荐做法。去重键取 `client_msg_id`，缺失时回落到 `ts`。
 */
import { SLACK_CAPABILITY_ID, SLACK_DOMAIN } from "@pibuddy/contract";

import {
  asRecord,
  readString,
  type ChannelAdapter,
  type InboundParse,
} from "./adapter.js";

function parseSlackInbound(event: unknown): InboundParse {
  const root = asRecord(event);
  if (root === null) return { type: "malformed", detail: "事件不是对象" };

  if (root["type"] === "url_verification") {
    const challenge = readString(root, "challenge");
    if (challenge === null) return { type: "malformed", detail: "url_verification 缺少 challenge" };
    return { type: "challenge", challenge };
  }

  if (root["type"] !== "event_callback") {
    return { type: "malformed", detail: "非 event_callback" };
  }
  const ev = asRecord(root["event"]);
  if (!ev || ev["type"] !== "message") {
    return { type: "malformed", detail: "非 message 事件" };
  }
  const text = readString(ev, "text");
  const messageId = readString(ev, "client_msg_id") ?? readString(ev, "ts");
  if (text === null || messageId === null) {
    return { type: "malformed", detail: "message 缺少 text / 去重键" };
  }
  // 防回环：带 bot_id 或 subtype=bot_message 的都是机器人消息（含我们自己）。
  const fromSelf = readString(ev, "bot_id") !== null || ev["subtype"] === "bot_message";

  return { type: "message", messageId, text, fromSelf, attachmentCount: 0, attachmentBytes: 0 };
}

export const slackAdapter: ChannelAdapter = {
  kind: "slack",
  capabilityId: SLACK_CAPABILITY_ID,
  domains: [SLACK_DOMAIN],
  formatBody: (text) => ({ text }),
  checkResponse: (resp) => ({
    ok: resp.ok,
    detail: resp.ok ? null : `HTTP ${resp.status} ${resp.bodyText.slice(0, 80)}`,
  }),
  parseInbound: parseSlackInbound,
};
