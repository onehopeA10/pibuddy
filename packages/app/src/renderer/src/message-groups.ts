import type { AgentMessage, AssistantMessage } from "@sdk";
import type { ChatItem } from "./stores/app";

export interface VisualMessageItem {
  key: number | string;
  sourceKeys: number[];
  message: AgentMessage;
  streaming: boolean;
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

/** 将协议级 assistant 消息折叠成用户看到的一轮回复。 */
export function groupVisualMessages(
  items: readonly ChatItem[],
  liveAssistant: AssistantMessage | null
): VisualMessageItem[] {
  const grouped: VisualMessageItem[] = [];

  for (const item of items) {
    const previous = grouped[grouped.length - 1];
    if (isAssistantMessage(item.message) && previous && isAssistantMessage(previous.message)) {
      previous.message = mergeAssistant(previous.message, item.message);
      previous.sourceKeys.push(item.key);
      continue;
    }
    grouped.push({
      key: item.key,
      sourceKeys: [item.key],
      message: isAssistantMessage(item.message)
        ? { ...item.message, content: [...item.message.content] }
        : item.message,
      streaming: false,
    });
  }

  if (liveAssistant) {
    const previous = grouped[grouped.length - 1];
    if (previous && isAssistantMessage(previous.message)) {
      previous.message = mergeAssistant(previous.message, liveAssistant);
      previous.streaming = true;
    } else {
      grouped.push({
        key: "live-assistant",
        sourceKeys: [],
        message: liveAssistant,
        streaming: true,
      });
    }
  }

  return grouped;
}
