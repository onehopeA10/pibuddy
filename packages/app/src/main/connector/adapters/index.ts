/**
 * 适配器装配点：把四个适配器注册进 kind → adapter 的表，供出站 / 入站按
 * `connector.kind` 路由。注册在模块加载期完成（重复 kind 抛错），任何 import 到
 * 本模块的代码看到的都是一张已装好的表。
 */
import { registerAdapter, resolveAdapter } from "./adapter.js";
import { feishuAdapter } from "./feishu.js";
import { slackAdapter } from "./slack.js";
import { telegramAdapter } from "./telegram.js";
import { webhookAdapter } from "./webhook.js";

registerAdapter(webhookAdapter);
registerAdapter(feishuAdapter);
registerAdapter(slackAdapter);
registerAdapter(telegramAdapter);

export {
  resolveAdapter,
  registerAdapter,
  type ChannelAdapter,
  type InboundParse,
  type OutboundVerdict,
} from "./adapter.js";
export { feishuAdapter, slackAdapter, telegramAdapter, webhookAdapter };
