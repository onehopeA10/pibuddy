/**
 * 飞书（Lark）适配器（connector.feishu）。
 *
 * ## 出站：自定义机器人 webhook（文档：open.feishu.cn/document）
 *
 * `POST https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，文本消息体：
 *
 * ```json
 * { "msg_type": "text", "content": { "text": "..." } }
 * ```
 *
 * 整条 hook URL（含 `<token>`）就是凭证，走 secret-store，出站层从那里取出直接喂
 * safeFetch。**飞书成功时回 `{code:0}`（旧字段 `StatusCode:0`），`code≠0` 即业务
 * 失败**——即便 HTTP 200 也不算送达，故响应判读看 code 而不是只看 HTTP 状态。
 * 启用签名校验的自定义机器人还需体内带 `timestamp`+`sign`；v1 走不签名路径（如实
 * 标注：签名推送属后续）。
 *
 * ## 入站：事件订阅 v2（im.message.receive_v1）
 *
 *   - 首次配置回调 URL 时平台发 `{type:"url_verification", challenge}`，回声
 *     challenge 即可。
 *   - 消息事件形如 `{schema:"2.0", header:{event_id,event_type}, event:{sender:{
 *     sender_type}, message:{message_id, message_type, content}}}`，其中文本消息的
 *     `content` 是一段 JSON 字符串 `{"text":"..."}`。**防回环**：`sender_type` 不是
 *     `"user"`（即 app / 机器人发的）一律判为「我们自己这侧」，不回灌给 Agent。
 */
import { FEISHU_CAPABILITY_ID, FEISHU_DOMAIN } from "@pibuddy/contract";

import {
  asRecord,
  readString,
  verdictFromJsonField,
  type ChannelAdapter,
  type InboundParse,
} from "./adapter.js";

/** 飞书文本消息的 `content` 是一段 JSON 字符串，取其 `text`。 */
function textFromContent(content: string): string | null {
  try {
    const parsed = asRecord(JSON.parse(content));
    return readString(parsed, "text");
  } catch {
    return null;
  }
}

function parseFeishuInbound(event: unknown): InboundParse {
  const root = asRecord(event);
  if (root === null) return { type: "malformed", detail: "事件不是对象" };

  // 握手：url_verification。
  if (root["type"] === "url_verification") {
    const challenge = readString(root, "challenge");
    if (challenge === null) return { type: "malformed", detail: "url_verification 缺少 challenge" };
    return { type: "challenge", challenge };
  }

  // 消息事件 v2：event.message.{message_id, content} + event.sender.sender_type。
  const ev = asRecord(root["event"]);
  const message = asRecord(ev?.["message"] ?? null);
  const messageId = readString(message, "message_id");
  const rawContent = readString(message, "content");
  if (!ev || messageId === null || rawContent === null) {
    return { type: "malformed", detail: "非 im.message.receive_v1 文本事件" };
  }
  const text = textFromContent(rawContent);
  if (text === null) return { type: "malformed", detail: "content 不是文本消息" };

  const sender = asRecord(ev["sender"] ?? null);
  const senderType = readString(sender, "sender_type");
  // sender_type 只有 "user" 才是真人；缺失时保守当作「非用户」以防回环。
  const fromSelf = senderType !== "user";

  return { type: "message", messageId, text, fromSelf, attachmentCount: 0, attachmentBytes: 0 };
}

export const feishuAdapter: ChannelAdapter = {
  kind: "feishu",
  capabilityId: FEISHU_CAPABILITY_ID,
  domains: [FEISHU_DOMAIN],
  formatBody: (text) => ({ msg_type: "text", content: { text } }),
  checkResponse: (resp) =>
    verdictFromJsonField(
      resp,
      (body) => body["code"] === 0 || body["StatusCode"] === 0,
      (body) => `飞书 code=${String(body["code"] ?? body["StatusCode"])} ${String(body["msg"] ?? "")}`
    ),
  parseInbound: parseFeishuInbound,
};
