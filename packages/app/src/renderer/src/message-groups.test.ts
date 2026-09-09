import { describe, expect, it } from "vitest";
import type { AssistantMessage, UserMessage } from "@sdk";
import type { ChatItem } from "./stores/app";
import { groupVisualMessages } from "./message-groups";

const assistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("groupVisualMessages", () => {
  it("连续 assistant 协议消息合成一个视觉回复", () => {
    const items: ChatItem[] = [
      { key: 1, message: assistant("调用工具前") },
      { key: 2, message: assistant("最终回答") },
    ];
    const grouped = groupVisualMessages(items, null);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].sourceKeys).toEqual([1, 2]);
    expect((grouped[0].message as AssistantMessage).content).toHaveLength(2);
  });

  it("user 消息切断 assistant 分组", () => {
    const user: UserMessage = { role: "user", content: "下一问" };
    const items: ChatItem[] = [
      { key: 1, message: assistant("第一轮") },
      { key: 2, message: user },
      { key: 3, message: assistant("第二轮") },
    ];
    expect(groupVisualMessages(items, null).map((item) => item.message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("live assistant 并入上一条工具调用消息并保持 streaming", () => {
    const grouped = groupVisualMessages([{ key: 1, message: assistant("工具调用") }], assistant("续答"));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].streaming).toBe(true);
  });
});
