import { describe, expect, it, vi } from "vitest";
import {
  BATCH_INTERVAL_MS,
  collapseEnvelopes,
  createForwarder,
  type ForwarderTarget,
} from "../src/main/pi/event-forwarder.js";
import { wrapEnvelope, type EnvelopeContext, type PiEnvelope } from "@contract";
import type { AgentEvent } from "@sdk";

const CTX: EnvelopeContext = {
  workspaceId: "/ws",
  sessionId: "sess-1",
  runtimeId: "rt-1",
  generation: 1,
};

function env(sequence: number, payload: AgentEvent): PiEnvelope<AgentEvent> {
  return wrapEnvelope(CTX, sequence, payload);
}

function fakeTarget(): ForwarderTarget & { sent: unknown[]; send: ReturnType<typeof vi.fn> } {
  const sent: unknown[] = [];
  const send = vi.fn((_channel: string, payload: unknown) => {
    sent.push(payload);
  });
  return { sent, send, isDestroyed: () => false };
}

function fakeSource(): { removeAllListeners: ReturnType<typeof vi.fn> } {
  return { removeAllListeners: vi.fn() };
}

describe("collapseEnvelopes", () => {
  it("按 sequence 保序", () => {
    const out = collapseEnvelopes([
      env(2, { type: "agent_settled" }),
      env(0, { type: "agent_start" }),
      env(1, { type: "tool_execution_start", toolCallId: "a" } as AgentEvent),
    ]);
    expect(out.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("折叠判据读的是信封的 payload，而不是裸事件", () => {
    // 这三条 message_update 携带累积快照，只保留最后一条不丢信息。
    const out = collapseEnvelopes([
      env(0, { type: "message_update", message: { text: "你" } } as AgentEvent),
      env(1, { type: "message_update", message: { text: "你好" } } as AgentEvent),
      env(2, { type: "message_update", message: { text: "你好世界" } } as AgentEvent),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sequence).toBe(2);
  });

  it("不同 toolCallId 的 tool_execution_update 不会被折叠到一起", () => {
    const out = collapseEnvelopes([
      env(0, { type: "tool_execution_update", toolCallId: "a" } as AgentEvent),
      env(1, { type: "tool_execution_update", toolCallId: "a" } as AgentEvent),
      env(2, { type: "tool_execution_update", toolCallId: "b" } as AgentEvent),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.sequence)).toEqual([1, 2]);
  });
});

describe("createForwarder", () => {
  it(`在 ${BATCH_INTERVAL_MS}ms 窗口内合批后一次性发出`, async () => {
    const target = fakeTarget();
    const forwarder = createForwarder(target, fakeSource());

    forwarder.push(env(0, { type: "agent_start" }));
    forwarder.push(env(1, { type: "message_update" } as AgentEvent));
    forwarder.push(env(2, { type: "message_update" } as AgentEvent));
    // 窗口未到期，一条都不该出去。
    expect(target.send).toHaveBeenCalledTimes(0);

    await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS + 30));
    // agent_start + 折叠后的一条 message_update
    expect(target.send).toHaveBeenCalledTimes(2);
    forwarder.dispose();
  });

  it("dispose 之后再投递事件，target.send 调用次数为 0", async () => {
    const target = fakeTarget();
    const source = fakeSource();
    const forwarder = createForwarder(target, source);

    forwarder.dispose();
    forwarder.push(env(0, { type: "agent_start" }));
    forwarder.push(env(1, { type: "message_update" } as AgentEvent));
    await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS + 30));

    expect(target.send).toHaveBeenCalledTimes(0);
    expect(source.removeAllListeners).toHaveBeenCalledTimes(1);
  });

  it("dispose 取消了尚未到期的 batch timer（不会晚到一批）", async () => {
    const target = fakeTarget();
    const forwarder = createForwarder(target, fakeSource());

    forwarder.push(env(0, { type: "agent_start" }));
    forwarder.dispose();
    await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS + 30));

    expect(target.send).toHaveBeenCalledTimes(0);
  });

  it("窗口已销毁时不抛异常，队列被清空", async () => {
    const target = { ...fakeTarget(), isDestroyed: () => true };
    const forwarder = createForwarder(target, fakeSource());
    forwarder.push(env(0, { type: "agent_start" }));
    await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS + 30));
    expect(target.send).toHaveBeenCalledTimes(0);
    forwarder.dispose();
  });
});
