/**
 * send() 出参路由（SES-102）。
 *
 * 断言的是**实际交给 RPC 的那个对象**，不是 store 的内部状态：三种产品语义
 * 都必须经 `prompt` 命令传输，靠 streamingBehavior 取值区分。改成原生
 * `{type:"steer"}` / `{type:"follow_up"}` 会让用户在助手流式期间无法调用
 * 斜杠扩展命令（rpc.md:82/:104 明文禁止），是净损失。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { send, useAppStore } from "./app";

interface SentPrompt {
  type?: string;
  message: string;
  streamingBehavior?: string;
}

let sent: SentPrompt[] = [];

function installBridge(): void {
  const prompt = vi.fn(async (payload: Omit<SentPrompt, "type">) => {
    // preload 侧固定发 { type: "prompt", ... }，这里把它补全后记录下来
    sent.push({ type: "prompt", ...payload });
    return { success: true };
  });
  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      pi: { prompt },
      sessions: { saveDraft: vi.fn(async () => true), getDraft: vi.fn(async () => null) },
    },
  };
}

describe("send() 三路分流", () => {
  beforeEach(() => {
    sent = [];
    setActivePinia(createPinia());
    installBridge();
  });

  it("(a) 非 streaming → prompt 且不带 streamingBehavior", async () => {
    const store = useAppStore();
    store.streaming = false;
    await expect(send({ text: "你好" })).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("prompt");
    expect("streamingBehavior" in sent[0]).toBe(false);
  });

  it('(b) streaming + mode="steer" → prompt + streamingBehavior:"steer"', async () => {
    const store = useAppStore();
    store.streaming = true;
    await expect(send({ text: "改一下", mode: "steer" })).resolves.toBe(true);
    expect(sent[0].type).toBe("prompt");
    expect(sent[0].streamingBehavior).toBe("steer");
  });

  it('(c) streaming + mode="followUp" → prompt + streamingBehavior:"followUp"', async () => {
    const store = useAppStore();
    store.streaming = true;
    await expect(send({ text: "等下再说", mode: "followUp" })).resolves.toBe(true);
    expect(sent[0].type).toBe("prompt");
    expect(sent[0].streamingBehavior).toBe("followUp");
  });

  it("(d) streaming 且 mode 缺失 → 抛错，且底层 RPC 一次都没发", async () => {
    const store = useAppStore();
    store.streaming = true;
    await expect(send({ text: "忘了选模式" })).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});
