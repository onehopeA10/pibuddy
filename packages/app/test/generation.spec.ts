import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../src/renderer/src/stores/app.js";
import { wrapEnvelope, type EnvelopeContext } from "@contract";

/**
 * RUN-002 代际隔离（渲染进程侧的第二层防御）。
 *
 * 实测故障：旧 pi 进程延迟退出仍 emit("exit")，主进程原样转发，渲染进程
 * 无从辨别代际 → 刚启动成功的新会话被置 started=false 并弹「意外退出」。
 */

function ctx(generation: number, runtimeId = `rt-${generation}`): EnvelopeContext {
  return { workspaceId: "/ws", sessionId: "sess-1", runtimeId, generation };
}

/**
 * agent_settled 会顺手 refreshState / refreshStats / refreshSessions，
 * 它们都要走 window.piBuddy。测试环境没有 preload，给一个最小替身，
 * 否则会以 unhandled rejection 的形式污染整轮测试。
 */
(globalThis as unknown as { window: unknown }).window = {
  piBuddy: {
    // agent_settled 会连带触发 refreshState / refreshStats，它们现在走窄方法
    pi: {
      getState: async () => ({ success: false }),
      getSessionStats: async () => ({ success: false }),
      getAvailableThinkingLevels: async () => ({ success: false }),
    },
    sessions: { query: async () => [] },
  },
};

const textEvent = (text: string) =>
  ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) as unknown as Record<string, unknown>;

describe("代际闸门", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("先 generation:2 再 generation:1 —— 旧代际的 payload 不进 items", () => {
    const s = useAppStore();
    s.started = true;

    s.handleEventEnvelope(wrapEnvelope(ctx(2), 0, textEvent("新代际")));
    s.handleEventEnvelope(wrapEnvelope(ctx(1), 0, textEvent("旧代际")));

    expect(s.started).toBe(true);
    expect(s.currentGeneration).toBe(2);
    const texts = s.items.map((i) =>
      JSON.stringify((i.message as { content: unknown }).content)
    );
    expect(texts.some((t) => t.includes("新代际"))).toBe(true);
    expect(texts.some((t) => t.includes("旧代际"))).toBe(false);
    expect(s.droppedEnvelopes).toBe(1);
  });

  it("sequence 倒退或重复的信封被丢弃", () => {
    const s = useAppStore();
    s.started = true;

    s.handleEventEnvelope(wrapEnvelope(ctx(1), 5, textEvent("A")));
    s.handleEventEnvelope(wrapEnvelope(ctx(1), 4, textEvent("B")));
    s.handleEventEnvelope(wrapEnvelope(ctx(1), 5, textEvent("C")));
    s.handleEventEnvelope(wrapEnvelope(ctx(1), 6, textEvent("D")));

    const texts = s.items.map((i) =>
      JSON.stringify((i.message as { content: unknown }).content)
    );
    expect(texts.filter((t) => t.includes("A")).length).toBe(1);
    expect(texts.some((t) => t.includes("B"))).toBe(false);
    expect(texts.some((t) => t.includes("C"))).toBe(false);
    expect(texts.some((t) => t.includes("D"))).toBe(true);
    expect(s.lastSequence).toBe(6);
    expect(s.droppedEnvelopes).toBe(2);
  });

  it("同代际正常事件被正常接收（agent_start 推进 streaming）", () => {
    const s = useAppStore();
    s.started = true;
    s.handleEventEnvelope(wrapEnvelope(ctx(1), 0, { type: "agent_start" }));
    expect(s.streaming).toBe(true);
    s.handleEventEnvelope(wrapEnvelope(ctx(1), 1, { type: "agent_settled" }));
    expect(s.streaming).toBe(false);
  });

  /**
   * 回归：三条通道共用一个单调计数器，但 pi:event 走 33ms 合批、
   * pi:ui-request 立即发出，于是 ui-request 会带着更大的 sequence 先到。
   * 闸门若按全局判定，紧随其后的一整批事件会被误判为「序号倒退」全部丢弃 ——
   * 实测表现是 agent_start 被吃掉、streaming 恒为 false、插话退化成普通 prompt
   * 并被 pi 以 "Agent is already processing" 拒绝。
   */
  it("ui-request 抢先到达不会吃掉随后合批送达的事件", () => {
    const s = useAppStore();
    s.started = true;

    // 合批中的事件序号是 0..2，但 setStatus 这条 ui-request（序号 3）先送到。
    s.handleUiRequestEnvelope(
      wrapEnvelope(ctx(1), 3, { id: "u1", method: "setStatus", statusKey: "m", statusText: "AUTO" })
    );
    s.handleEventEnvelope(wrapEnvelope(ctx(1), 0, { type: "agent_start" }));
    s.handleEventEnvelope(wrapEnvelope(ctx(1), 1, textEvent("正文")));

    expect(s.streaming).toBe(true);
    expect(s.droppedEnvelopes).toBe(0);
    expect(s.items).toHaveLength(1);
  });

  it("协议版本不符的信封 fail closed", () => {
    const s = useAppStore();
    s.started = true;
    const bad = { ...wrapEnvelope(ctx(1), 0, textEvent("X")), protocolVersion: 999 };
    s.handleEventEnvelope(bad);
    expect(s.items).toHaveLength(0);
    expect(s.droppedEnvelopes).toBe(1);
  });
});

describe("pi:exit 的代际与 reason 判定", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("上一代 runtime 的 exit 不再把新会话打成 started=false", () => {
    const s = useAppStore();
    const notify = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    s.setNotifier(notify);
    s.started = true;

    // 新代际先建立
    s.handleEventEnvelope(wrapEnvelope(ctx(2), 0, { type: "agent_start" }));
    // 上一代进程这时才慢吞吞地退出
    s.handleExitEnvelope(
      wrapEnvelope(ctx(1), 0, { code: 1, reason: "crash" })
    );

    expect(s.started).toBe(true);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("当前代际主动停止不弹错误提示，崩溃才弹并带上真因", () => {
    const s = useAppStore();
    const notify = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    s.setNotifier(notify);
    s.started = true;

    s.handleExitEnvelope(
      wrapEnvelope(ctx(1), 0, { code: 0, reason: "expected-stop" })
    );
    expect(s.started).toBe(false);
    expect(notify.error).not.toHaveBeenCalled();

    s.started = true;
    s.handleExitEnvelope(
      wrapEnvelope(ctx(2), 0, {
        code: -4058,
        reason: "crash",
        error: "spawn pi ENOENT",
      })
    );
    expect(s.started).toBe(false);
    expect(notify.error).toHaveBeenCalledWith(
      expect.stringContaining("ENOENT")
    );
  });
});
