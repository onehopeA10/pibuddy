/**
 * delta 拼帧与**跨会话缓冲泄漏**（TASK-010 c[13]）。
 *
 * 残留的 streamBuffer 会把上一会话的尾字符渗进新会话的首条消息里 ——
 * typecheck、构建、lint 全绿，只有肉眼能看出来。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AgentEvent, AssistantMessage, TextContent } from "@sdk";
import { PROTOCOL_VERSION } from "@contract";
import { __streamState, resetSessionScopedState, useAppStore } from "./app";

function envelope(sequence: number, payload: AgentEvent): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: "/ws",
    sessionId: "sess-1",
    runtimeId: "rt-1",
    generation: 1,
    sequence,
    occurredAt: Date.now(),
    payload,
  };
}

function textDelta(delta: string, contentIndex = 0): AgentEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] } as unknown as AssistantMessage,
    assistantMessageEvent: { type: "text_delta", contentIndex, delta },
  } as AgentEvent;
}

function liveText(msg: AssistantMessage | null): string {
  return ((msg?.content ?? []) as TextContent[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("流式 delta 缓冲", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (globalThis as unknown as { window: unknown }).window = {
      piBuddy: { pi: {}, sessions: { getDraft: vi.fn(async () => null) } },
    };
  });

  it("delta 逐帧拼接后 flush，一个字符都不丢", () => {
    const store = useAppStore();
    store.handleEventEnvelope(
      envelope(0, {
        type: "message_start",
        message: { role: "assistant", content: [] } as unknown as AssistantMessage,
      } as AgentEvent)
    );
    const chars = "长回复里的每一个字都不能丢".split("");
    chars.forEach((c, i) => store.handleEventEnvelope(envelope(i + 1, textDelta(c))));
    store.flushStream();
    expect(liveText(store.liveAssistant)).toBe(chars.join(""));
  });

  it("切会话后 rafId 为 null、streamBuffer 为空，新会话不含上一会话的字符", () => {
    const store = useAppStore();
    store.handleEventEnvelope(
      envelope(0, {
        type: "message_start",
        message: { role: "assistant", content: [] } as unknown as AssistantMessage,
      } as AgentEvent)
    );
    // 流式进行中（rAF 尚未回调），缓冲里躺着字符
    store.handleEventEnvelope(envelope(1, textDelta("旧")));
    store.handleEventEnvelope(envelope(2, textDelta("会")));
    store.handleEventEnvelope(envelope(3, textDelta("话")));
    expect(__streamState().streamBuffer).toBe("旧会话");
    expect(__streamState().rafId).not.toBe(null);

    // 切会话
    resetSessionScopedState();
    expect(__streamState().rafId).toBe(null);
    expect(__streamState().streamBuffer).toBe("");
    expect(store.liveAssistant).toBe(null);

    // 新会话的首条消息
    store.handleEventEnvelope(
      envelope(4, {
        type: "message_start",
        message: { role: "assistant", content: [] } as unknown as AssistantMessage,
      } as AgentEvent)
    );
    store.handleEventEnvelope(envelope(5, textDelta("新")));
    store.flushStream();
    const text = liveText(store.liveAssistant);
    expect(text).toBe("新");
    for (const c of "旧会话") expect(text).not.toContain(c);
  });

  it("跨 contentIndex 的 delta 落到不同的内容块，不会串行", () => {
    const store = useAppStore();
    store.handleEventEnvelope(
      envelope(0, {
        type: "message_start",
        message: { role: "assistant", content: [] } as unknown as AssistantMessage,
      } as AgentEvent)
    );
    store.handleEventEnvelope(envelope(1, textDelta("甲", 0)));
    store.handleEventEnvelope(envelope(2, textDelta("乙", 1)));
    store.flushStream();
    const content = (store.liveAssistant?.content ?? []) as TextContent[];
    expect(content[0].text).toBe("甲");
    expect(content[1].text).toBe("乙");
  });
});
