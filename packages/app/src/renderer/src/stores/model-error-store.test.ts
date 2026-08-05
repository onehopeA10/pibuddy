/**
 * `pi:model-error` 在渲染侧被真的消费了（MDL-101）。
 *
 * 这里断言的是**连接**而不是文案：归一化在主进程、文案在
 * `model-error-advice.ts`，各有各的单测。这个文件回答的是第三个问题 ——
 * 主进程算出来的那个 kind，到底有没有变成界面上的一条提示。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { PROTOCOL_VERSION, type PiModelErrorPayload } from "@contract";
import type { AgentEvent } from "@sdk";

import { useAppStore } from "./app";

const CTX = {
  protocolVersion: PROTOCOL_VERSION,
  workspaceId: "ws-1",
  sessionId: "sess-1",
  runtimeId: "rt-1",
  generation: 1,
  occurredAt: 1,
};

let sequence = 0;
function envelope(payload: PiModelErrorPayload): unknown {
  return { ...CTX, sequence: sequence++, payload };
}

function report(over: Partial<PiModelErrorPayload> = {}): PiModelErrorPayload {
  return {
    kind: "context_overflow",
    source: "message",
    message: "Context window exceeded",
    raw: "prompt is too long: 213462 tokens > 200000 maximum",
    retryable: false,
    ...over,
  };
}

function installBridge(compact: () => Promise<unknown>): void {
  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      pi: {
        compact,
        getSessionStats: vi.fn(async () => ({ success: false })),
        getState: vi.fn(async () => ({ success: false })),
        getAvailableThinkingLevels: vi.fn(async () => ({ success: false })),
      },
      providers: { usage: { record: vi.fn(async () => undefined) } },
      sessions: { query: vi.fn(async () => []) },
    },
  };
}

beforeEach(() => {
  sequence = 0;
  setActivePinia(createPinia());
  installBridge(vi.fn(async () => ({ success: true })));
});

describe("归一化结论进到界面状态", () => {
  it("终态错误落成会话级横幅", () => {
    const store = useAppStore();
    store.handleModelErrorEnvelope(envelope(report()));
    expect(store.modelError?.kind).toBe("context_overflow");
  });

  it("自动重试中的报告只记类别，不弹横幅", () => {
    const store = useAppStore();
    store.handleModelErrorEnvelope(
      envelope(report({ kind: "rate_limit", source: "retry", retryable: true, attempt: 1 }))
    );
    expect(store.modelError).toBeNull();
    expect(store.retryKind).toBe("rate_limit");
  });

  it("重试状态条按已知类别措辞，而不是恒定的「网络繁忙」", () => {
    const store = useAppStore();
    store.handleModelErrorEnvelope(
      envelope(report({ kind: "rate_limit", source: "retry", retryable: true }))
    );
    store.handleEvent({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1_000,
      errorMessage: "rate limit",
    } as AgentEvent);
    expect(store.statusTexts.retry).toContain("服务商限流");
    expect(store.statusTexts.retry).not.toContain("网络繁忙");
  });

  it("重试收场后类别归位，横幅换成终态那一条", () => {
    const store = useAppStore();
    store.handleModelErrorEnvelope(
      envelope(report({ kind: "rate_limit", source: "retry", retryable: true }))
    );
    store.handleEvent({ type: "auto_retry_end", success: false, attempt: 3 } as AgentEvent);
    expect(store.retryKind).toBe("unknown");
    store.handleModelErrorEnvelope(
      envelope(report({ kind: "provider_unavailable", source: "retry-final" }))
    );
    expect(store.modelError?.kind).toBe("provider_unavailable");
  });

  it("abort 不进横幅：那是用户自己按的停止键", () => {
    const store = useAppStore();
    store.handleModelErrorEnvelope(envelope(report({ kind: "abort", source: "message" })));
    expect(store.modelError).toBeNull();
  });

  it("新一轮开始就清掉上一轮的提示", () => {
    const store = useAppStore();
    store.handleModelErrorEnvelope(envelope(report()));
    expect(store.modelError).not.toBeNull();
    store.handleEvent({ type: "agent_start" } as AgentEvent);
    expect(store.modelError).toBeNull();
  });

  it("过不了信封闸门的消息不改变任何状态", () => {
    const store = useAppStore();
    // 协议版本不符 → fail closed
    store.handleModelErrorEnvelope({ ...CTX, protocolVersion: 999, sequence: 0, payload: report() });
    expect(store.modelError).toBeNull();
  });
});

describe("context_overflow 的出口：手动整理对话记忆", () => {
  it("成功即清掉横幅", async () => {
    const compact = vi.fn(async () => ({ success: true }));
    installBridge(compact);
    const store = useAppStore();
    store.handleModelErrorEnvelope(envelope(report()));

    await store.compactSession();

    expect(compact).toHaveBeenCalled();
    expect(store.modelError).toBeNull();
  });

  it("失败时保留横幅：修没修好不能靠猜", async () => {
    installBridge(vi.fn(async () => ({ success: false, error: "busy" })));
    const store = useAppStore();
    store.handleModelErrorEnvelope(envelope(report()));

    await store.compactSession();

    expect(store.modelError?.kind).toBe("context_overflow");
  });
});
