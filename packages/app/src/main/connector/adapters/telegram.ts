/**
 * Telegram 适配器（connector.telegram）。
 *
 * ## 出站：Bot API sendMessage（文档：core.telegram.org/bots/api#sendmessage）
 *
 * `POST https://api.telegram.org/bot<token>/sendMessage`，体 `{ "chat_id":…, "text":… }`。
 * sendMessage 的参数可来自 query 或 body，二者合并——因此本适配器把 **chat_id 随
 * 凭证 URL 的 query 一起落 secret-store**（`…/sendMessage?chat_id=<id>`），出站体
 * 只带 `{text}`，从而与「整条 URL 即凭证、只进不出」的基座模型保持一致（token 与
 * chat_id 都不进渲染进程、不进日志）。成功回 `{ "ok": true, ... }`，`ok:false` 即
 * 业务失败（如 `chat not found`），故响应判读看 `ok` 而不是只看 HTTP 状态。
 *
 * ## 入站：Update 对象（getUpdates / setWebhook 同一形状）
 *
 * `{ update_id, message:{ message_id, from:{ is_bot }, chat:{ id }, text } }`。Telegram
 * 用 `secret_token` 头 / setWebhook 校验回调，**没有 url_verification 握手**。
 * **防回环**：`message.from.is_bot === true` 即机器人消息（含我们自己），不回灌。
 * 去重键取 `update_id`（平台保证单调、重投同值）。
 */
import { TELEGRAM_CAPABILITY_ID, TELEGRAM_DOMAIN } from "@pibuddy/contract";

import {
  asRecord,
  readString,
  verdictFromJsonField,
  type ChannelAdapter,
  type InboundParse,
} from "./adapter.js";

function parseTelegramInbound(event: unknown): InboundParse {
  const root = asRecord(event);
  if (root === null) return { type: "malformed", detail: "事件不是对象" };

  const updateId = root["update_id"];
  const message = asRecord(root["message"] ?? root["edited_message"] ?? null);
  const text = readString(message, "text");
  if (typeof updateId !== "number" || !message || text === null) {
    return { type: "malformed", detail: "非文本 Update" };
  }
  const from = asRecord(message["from"] ?? null);
  const fromSelf = from?.["is_bot"] === true;

  return {
    type: "message",
    messageId: String(updateId),
    text,
    fromSelf,
    attachmentCount: 0,
    attachmentBytes: 0,
  };
}

export const telegramAdapter: ChannelAdapter = {
  kind: "telegram",
  capabilityId: TELEGRAM_CAPABILITY_ID,
  domains: [TELEGRAM_DOMAIN],
  formatBody: (text) => ({ text }),
  checkResponse: (resp) =>
    verdictFromJsonField(
      resp,
      (body) => body["ok"] === true,
      (body) => `Telegram ${String(body["description"] ?? "ok:false")}`
    ),
  parseInbound: parseTelegramInbound,
};
