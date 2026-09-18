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

  it("起点取触发的 user 消息时间，终点取组内最后一条 assistant 的时间", () => {
    const at = (msg: AssistantMessage | UserMessage, timestamp: number) => ({ ...msg, timestamp });
    const user: UserMessage = { role: "user", content: "问" };
    const items: ChatItem[] = [
      { key: 1, message: at(user, 1_000) },
      { key: 2, message: at(assistant("查一下"), 2_000) },
      { key: 3, message: at(assistant("再查"), 60_000) },
      { key: 4, message: at(assistant("回答"), 153_000) },
    ];
    const grouped = groupVisualMessages(items, null);
    expect(grouped).toHaveLength(2);
    expect(grouped[1].startedAt).toBe(1_000);
    expect(grouped[1].endedAt).toBe(153_000);
    // user 消息自己不带起止
    expect(grouped[0].startedAt).toBeUndefined();
  });

  it("没有 user 前文时起点退回首条 assistant；live 消息更新终点", () => {
    const at = (msg: AssistantMessage, timestamp: number) => ({ ...msg, timestamp });
    const grouped = groupVisualMessages(
      [{ key: 1, message: at(assistant("查"), 5_000) }],
      at(assistant("续"), 9_000)
    );
    expect(grouped[0].startedAt).toBe(5_000);
    expect(grouped[0].endedAt).toBe(9_000);
  });
});
