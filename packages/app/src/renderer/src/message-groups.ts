import type { AgentMessage, AssistantMessage } from "@sdk";
import type { ChatItem } from "./stores/app";

export interface VisualMessageItem {
  key: number | string;
  sourceKeys: number[];
  /** 原始消息引用供渲染缓存比较，合并后的 message 每次计算都会新建。 */
  sourceMessages: AgentMessage[];
  message: AgentMessage;
  streaming: boolean;
  /**
   * 这一轮回复的起止（仅 assistant 组有）。
   *
   * 起点取触发它的那条 user 消息的 timestamp（没有就退回首条 assistant 的）；
   * 终点取组内**最后一条** assistant 协议消息的 timestamp —— pi 给 assistant
   * 消息打的时间戳是该消息**开始流式**的时刻，而最后一条正是承载最终回答的
   * 那条，所以它恰好就是「思考 / 工具调用结束、开始作答」的时间。仍在流式且
   * 还没开始作答时，界面侧用当前时间代替终点。
   */
  startedAt?: number;
  endedAt?: number;
}

function mergeAssistant(previous: AssistantMessage, next: AssistantMessage): AssistantMessage {
  return {
    ...previous,
    ...next,
    role: "assistant",
    content: [...previous.content, ...next.content],
  };
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray((message as AssistantMessage).content);
}

function timestampOf(message: AgentMessage): number | undefined {
  return (message as { timestamp?: number }).timestamp;
}

/** 将协议级 assistant 消息折叠成用户看到的一轮回复。 */
export function groupVisualMessages(
  items: readonly ChatItem[],
  liveAssistant: AssistantMessage | null
): VisualMessageItem[] {
  const grouped: VisualMessageItem[] = [];
  let lastUserAt: number | undefined;

  for (const item of items) {
    const previous = grouped[grouped.length - 1];
    if (isAssistantMessage(item.message) && previous && isAssistantMessage(previous.message)) {
      previous.message = mergeAssistant(previous.message, item.message);
      previous.sourceKeys.push(item.key);
      previous.sourceMessages.push(item.message);
      previous.endedAt = timestampOf(item.message) ?? previous.endedAt;
      continue;
    }
    if (item.message.role === "user") lastUserAt = timestampOf(item.message);
    if (isAssistantMessage(item.message)) {
      const at = timestampOf(item.message);
      grouped.push({
        key: item.key,
        sourceKeys: [item.key],
        sourceMessages: [item.message],
        message: item.message,
        streaming: false,
        startedAt: lastUserAt ?? at,
        endedAt: at,
      });
      continue;
    }
    grouped.push({
      key: item.key,
      sourceKeys: [item.key],
      sourceMessages: [item.message],
      message: item.message,
      streaming: false,
    });
  }

  if (liveAssistant) {
    const previous = grouped[grouped.length - 1];
    const at = timestampOf(liveAssistant);
    if (previous && isAssistantMessage(previous.message)) {
      previous.message = mergeAssistant(previous.message, liveAssistant);
      previous.sourceMessages.push(liveAssistant);
      previous.streaming = true;
      previous.endedAt = at ?? previous.endedAt;
    } else {
      grouped.push({
        key: "live-assistant",
        sourceKeys: [],
        sourceMessages: [liveAssistant],
        message: liveAssistant,
        streaming: true,
        startedAt: lastUserAt ?? at,
        endedAt: at,
      });
    }
  }

  return grouped;
}
