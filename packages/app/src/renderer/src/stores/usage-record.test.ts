/**
 * 用量上报确实被触发（PROV-101）。
 *
 * 这个文件的存在原因是一次真机验证：usage-store 的单测全绿、用量页渲染
 * 正常、导出按钮点了也有反应，但表里**一行数据都没有** —— 因为没有任何
 * 地方调用 `usage:record`。三大门禁对这种「功能整体是死的」完全无感。
 *
 * 因此这里断言的是**连接**而不是实现：refreshStats 之后
 * `providers.usage.record` 必须被调用，且带上正确的 provider / model /
 * token / cost。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AgentEvent } from "@sdk";
import { useAppStore } from "./app";

const MODEL = { id: "some-model", provider: "acme", input: ["text"] };

const STATS = {
  sessionId: "sess-42",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 22319, output: 5, cacheRead: 0, cacheWrite: 0, total: 22324 },
  cost: 0.1117,
  contextUsage: { tokens: 22324, contextWindow: 272000, percent: 8.2 },
};

let recordSpy: ReturnType<typeof vi.fn>;

function installBridge(): void {
  recordSpy = vi.fn(async () => undefined);
  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      pi: {
        getSessionStats: vi.fn(async () => ({ success: true, data: STATS })),
        getState: vi.fn(async () => ({ success: true, data: { model: MODEL } })),
        getAvailableThinkingLevels: vi.fn(async () => ({
          success: true,
          data: { levels: ["off"] },
        })),
      },
      providers: { usage: { record: recordSpy, query: vi.fn(async () => []) } },
      sessions: {
        query: vi.fn(async () => []),
        saveDraft: vi.fn(async () => true),
        getDraft: vi.fn(async () => null),
      },
    },
  };
}

/** 让 store 处于「有模型、有工作区」的状态。 */
function primeStore(): ReturnType<typeof useAppStore> {
  const store = useAppStore();
  store.workspaceId = "ws-1";
  store.agentState = { model: MODEL, thinkingLevel: "off", isStreaming: false } as never;
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  installBridge();
});

describe("refreshStats 之后必须上报用量", () => {
  it("record 被调用，且带上 provider / model / token / cost", async () => {
    const store = primeStore();

    // agent_settled 是唯一会让 session stats 出现新值的时机
    store.handleEvent({ type: "agent_settled" } as AgentEvent);
    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalled());

    const payload = recordSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.sessionId).toBe("sess-42");
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.provider).toBe("acme");
    expect(payload.modelId).toBe("some-model");
    expect(payload.inputTokens).toBe(22319);
    expect(payload.outputTokens).toBe(5);
    expect(payload.cost).toBeCloseTo(0.1117, 6);
    expect(payload.contextTokens).toBe(22324);
    expect(payload.failed).toBe(false);
  });

  it("模型未知时不上报（一条 provider 为空的用量行毫无意义）", async () => {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.agentState = null;

    store.handleEvent({ type: "agent_settled" } as AgentEvent);
    // 给足时间让异步链跑完
    await new Promise((r) => setTimeout(r, 50));
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("上报失败不打断对话，但把原因留在 lastUsageError 里（不静默）", async () => {
    const store = primeStore();
    recordSpy.mockRejectedValueOnce(new Error("IPC_RATE_LIMITED: usage:record"));

    store.handleEvent({ type: "agent_settled" } as AgentEvent);
    await vi.waitFor(() => expect(store.lastUsageError).toContain("IPC_RATE_LIMITED"));
    // stats 本身照常更新，界面上的 context 百分比不受影响
    expect(store.stats?.cost).toBeCloseTo(0.1117, 6);
  });
});

describe("失败次数来自事件流", () => {
  it("assistant 以 stopReason==='error' 收场 → 下一次上报 failed=true", async () => {
    const store = primeStore();

    store.handleEvent({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    } as unknown as AgentEvent);
    store.handleEvent({ type: "agent_settled" } as AgentEvent);

    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalled());
    expect((recordSpy.mock.calls[0][0] as { failed: boolean }).failed).toBe(true);
  });

  it("auto_retry_end(success=false) 同样计入失败", async () => {
    const store = primeStore();

    store.handleEvent({
      type: "auto_retry_end",
      success: false,
      finalError: "boom",
    } as unknown as AgentEvent);
    store.handleEvent({ type: "agent_settled" } as AgentEvent);

    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalled());
    expect((recordSpy.mock.calls[0][0] as { failed: boolean }).failed).toBe(true);
  });

  it("正常收场时 failed=false，且失败计数不会跨轮次累积", async () => {
    const store = primeStore();

    store.handleEvent({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    } as unknown as AgentEvent);
    store.handleEvent({ type: "agent_settled" } as AgentEvent);
    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalledTimes(1));

    // 第二轮一切正常：上一轮那次失败已经上报过，不能再算一次
    store.handleEvent({ type: "agent_settled" } as AgentEvent);
    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalledTimes(2));
    expect((recordSpy.mock.calls[1][0] as { failed: boolean }).failed).toBe(false);
  });
});
