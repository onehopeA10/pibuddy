/**
 * 折叠正确性单测（TASK-010 最容易静默回归的一处）。
 *
 * 每个 fixture 都经 `wrapEnvelope(...)` 包成信封 —— 不是为了好看：
 * collapseEnvelopes 的入参类型是 `PiEnvelope<AgentEvent>[]`，裸事件对象缺
 * protocolVersion / sequence 等必填字段，编译期就过不去。这条类型约束是
 * 「判据读裸事件、折叠悄悄退化成透传、单测却因为喂的是裸事件而全绿」这个
 * 回归的唯一拦截点。
 */
import { describe, expect, it, vi } from "vitest";
import { wrapEnvelope, type EnvelopeContext, type PiEnvelope } from "@pibuddy/contract";
import type { AgentEvent, AssistantMessage } from "@pibuddy/pi-sdk";
import {
  BATCH_INTERVAL_MS,
  collapseEnvelopes,
  createForwarder,
  type ForwarderTarget,
} from "./event-forwarder.js";

const CTX: EnvelopeContext = {
  workspaceId: "/ws",
  sessionId: "sess-1",
  runtimeId: "rt-1",
  generation: 1,
};

function env(sequence: number, payload: AgentEvent): PiEnvelope<AgentEvent> {
  return wrapEnvelope(CTX, sequence, payload);
}

/** 造一条 text_delta 的 message_update：delta 是增量，两个快照字段是累积全量。 */
function textDelta(
  sequence: number,
  delta: string,
  snapshot: string,
  contentIndex = 0
): PiEnvelope<AgentEvent> {
  const partial = {
    role: "assistant",
    content: [{ type: "text", text: snapshot }],
  } as unknown as AssistantMessage;
  return env(sequence, {
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex, delta, partial },
  } as AgentEvent);
}

function deltaOf(e: PiEnvelope<AgentEvent>): string | undefined {
  return (e.payload as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta;
}

function snapshotOf(e: PiEnvelope<AgentEvent>): string {
  const payload = e.payload as { message: { content: { text: string }[] } };
  return payload.message.content[0].text;
}

function partialOf(e: PiEnvelope<AgentEvent>): string {
  const payload = e.payload as {
    assistantMessageEvent: { partial: { content: { text: string }[] } };
  };
  return payload.assistantMessageEvent.partial.content[0].text;
}

function fakeTarget(destroyed = false): ForwarderTarget & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn((_channel: string, _payload: unknown) => {});
  return { send, isDestroyed: () => destroyed };
}

function fakeSource(): { removeAllListeners: ReturnType<typeof vi.fn> } {
  return { removeAllListeners: vi.fn() };
}

describe("collapseEnvelopes · delta 拼接", () => {
  it("200 条单字符 text_delta 拼接后一个字符都不丢", () => {
    const chars = Array.from({ length: 200 }, (_, i) => String.fromCharCode(0x4e00 + i));
    let acc = "";
    const input = chars.map((c, i) => {
      acc += c;
      return textDelta(i + 1, c, acc);
    });

    const out = collapseEnvelopes(input);

    expect(out).toHaveLength(1);
    expect(deltaOf(out[0])).toBe(chars.join(""));
    // 输出信封的元数据取最后一帧，否则渲染侧的按通道序号闸门会整批丢弃
    expect(out[0].sequence).toBe(200);
  });

  it("跨 contentIndex 与非 delta 事件都不合并，且顺序不变", () => {
    const out = collapseEnvelopes([
      textDelta(1, "a", "a", 0),
      env(2, {
        type: "message_update",
        message: {} as AgentMessageLike,
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "a" },
      } as unknown as AgentEvent),
      textDelta(3, "b", "b", 1),
    ]);

    expect(out).toHaveLength(3);
    expect(out.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("W-4：delta 累加，而全量快照与信封元数据都取最后一帧", () => {
    const out = collapseEnvelopes([
      textDelta(1, "a", "a"),
      textDelta(2, "b", "ab"),
      textDelta(3, "c", "abc"),
    ]);

    expect(out).toHaveLength(1);
    // (a) 增量拼接
    expect(deltaOf(out[0])).toBe("abc");
    // (b) 快照取末帧（取首帧会得到 'a'）
    expect(snapshotOf(out[0])).toBe("abc");
    expect(partialOf(out[0])).toBe("abc");
    // (c) 信封元数据取末帧
    expect(out[0].sequence).toBe(3);
  });

  it("thinking_delta 与 text_delta 不会互相合并", () => {
    const thinking = env(2, {
      type: "message_update",
      message: {} as AgentMessageLike,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "嗯" },
    } as unknown as AgentEvent);
    const out = collapseEnvelopes([textDelta(1, "a", "a"), thinking]);
    expect(out).toHaveLength(2);
  });

  it("按 sequence 保序", () => {
    const out = collapseEnvelopes([
      env(2, { type: "agent_settled" }),
      env(0, { type: "agent_start" }),
      env(1, { type: "tool_execution_start", toolCallId: "a" } as AgentEvent),
    ]);
    expect(out.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("同 toolCallId 的 tool_execution_update 仍是覆盖式折叠（累积快照语义）", () => {
    const out = collapseEnvelopes([
      env(0, { type: "tool_execution_update", toolCallId: "a" } as AgentEvent),
      env(1, { type: "tool_execution_update", toolCallId: "a" } as AgentEvent),
      env(2, { type: "tool_execution_update", toolCallId: "b" } as AgentEvent),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.sequence)).toEqual([1, 2]);
  });
});

describe("createForwarder · 33ms 节拍与窗口销毁", () => {
  it("33ms 窗口内到达的 20 条事件只触发 1 次 send", async () => {
    const target = fakeTarget();
    const forwarder = createForwarder(target, fakeSource());
    let acc = "";
    for (let i = 0; i < 20; i++) {
      acc += "x";
      forwarder.push(textDelta(i + 1, "x", acc));
    }
    expect(target.send).toHaveBeenCalledTimes(0);
    await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS + 30));
    expect(target.send).toHaveBeenCalledTimes(1);
    expect(deltaOf(target.send.mock.calls[0][1] as PiEnvelope<AgentEvent>)).toBe("x".repeat(20));
    forwarder.dispose();
  });

  it("窗口已销毁时 send 调用次数为 0 且不抛异常", async () => {
    const target = fakeTarget(true);
    const forwarder = createForwarder(target, fakeSource());
    expect(() => {
      forwarder.push(textDelta(1, "a", "a"));
      forwarder.flush();
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS + 30));
    expect(target.send).toHaveBeenCalledTimes(0);
    forwarder.dispose();
  });
});

/** 只在 fixture 里用到的宽松形状：这些 case 不关心 message 的内容。 */
type AgentMessageLike = Record<string, never>;
