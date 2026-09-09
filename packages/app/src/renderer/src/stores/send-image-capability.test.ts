/**
 * 图片能力拦截的**双向**断言（PROV-101）。
 *
 * 双向是关键：只测「拦住了」的话，一个恒返回 false 的 send() 也能通过。
 * 因此这里成对断言 —— 阻断用例要求 RPC 发出次数为 0，放行用例要求
 * **恰好发出 1 次且图片真的在参数里**。
 *
 * 另外一条：`send()` 在拦截路径上必须 `return false` 而不是裸 `return`。
 * 裸 return 返回 undefined，InputBar 那边 `if (await store.send(...))` 的
 * 行为碰巧一样（都不清空输入区），但类型是错的 —— 这条断言把它钉死。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Model } from "@sdk";
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENT_TOKENS,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_TOTAL_ATTACHMENT_BYTES,
} from "@contract";
import { send, useAppStore } from "./app";

/**
 * `window.piBuddy.pi` 上的 15 个产品动作（TASK-007 定名）。
 *
 * 这里逐字列出而不是从实现里读：这条断言的用处正是「实现悄悄多长出一个
 * 方法时要失败」。stub 的键集合与它逐项相等，长度必须是 15。
 */
const PI_PRODUCT_ACTIONS = [
  "prompt",
  "steer",
  "followUp",
  "abort",
  "newSession",
  "switchSession",
  "setModel",
  "setThinkingLevel",
  "getState",
  "getMessages",
  "getSessionStats",
  "getAvailableModels",
  "getAvailableThinkingLevels",
  "compact",
  "setSessionName",
] as const;

const IMAGE = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

let promptSpy: ReturnType<typeof vi.fn>;
let notified: [string, string][] = [];

/** 造一个只有 15 个产品动作的 pi stub。 */
function installBridge(): void {
  promptSpy = vi.fn(async () => ({ success: true }));
  const piStub: Record<string, unknown> = {};
  for (const name of PI_PRODUCT_ACTIONS) {
    piStub[name] = name === "prompt" ? promptSpy : vi.fn(async () => ({ success: true }));
  }
  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      pi: piStub,
      sessions: { saveDraft: vi.fn(async () => true), getDraft: vi.fn(async () => null) },
    },
  };
}

/** 把 store 的当前模型换成指定形状。agentState 是 shallowRef，整体替换即可。 */
function setCurrentModel(model: Partial<Model> | null): void {
  const store = useAppStore();
  store.agentState = model
    ? ({ model, thinkingLevel: "off", isStreaming: false } as never)
    : ({ model: null, thinkingLevel: "off", isStreaming: false } as never);
}

beforeEach(() => {
  notified = [];
  setActivePinia(createPinia());
  installBridge();
  const store = useAppStore();
  store.setNotifier({
    info: (s: string) => notified.push(["info", s]),
    success: (s: string) => notified.push(["success", s]),
    warning: (s: string) => notified.push(["warning", s]),
    error: (s: string) => notified.push(["error", s]),
  });
});

describe("stub 的接口面是有界枚举", () => {
  it("window.piBuddy.pi 恰有 15 个产品动作，逐项与 TASK-007 的名单相等", () => {
    const keys = Object.keys(
      (window as unknown as { piBuddy: { pi: Record<string, unknown> } }).piBuddy.pi
    ).sort();
    expect(keys).toHaveLength(15);
    expect(keys).toEqual([...PI_PRODUCT_ACTIONS].sort());
  });
});

describe("(a) 阻断：模型只收文本，却带了一张图", () => {
  it("send() === false，prompt 一次都没发，notify('warning') 恰一次且含模型 id", async () => {
    const store = useAppStore();
    setCurrentModel({ id: "text-only-model", provider: "acme", input: ["text"] });

    const result = await send({ text: "看这张图", images: [IMAGE] });

    expect(result).toBe(false);
    // 类型层面也钉住：裸 return 会是 undefined
    expect(result).not.toBeUndefined();
    expect(promptSpy).toHaveBeenCalledTimes(0);

    const warnings = notified.filter(([kind]) => kind === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toContain("text-only-model");

    // 界面据它把附件条目标灰、禁用发送键
    expect(store.modelBlockedImages).not.toBeNull();
    expect(store.modelBlockedImages?.ok).toBe(false);
  });

  it("input 字段缺席时同样拦（保守处理），且 RPC 发出次数为 0", async () => {
    setCurrentModel({ id: "unknown-caps-model", provider: "acme" });
    await expect(send({ text: "图", images: [IMAGE] })).resolves.toBe(false);
    expect(promptSpy).toHaveBeenCalledTimes(0);
  });

  it("完全没选模型时带图 → 拦住，不发 RPC", async () => {
    setCurrentModel(null);
    await expect(send({ images: [IMAGE] })).resolves.toBe(false);
    expect(promptSpy).toHaveBeenCalledTimes(0);
  });
});

describe("(b) 放行：模型收得下图，图片必须真的发出去", () => {
  it("send() === true，prompt 恰被调用 1 次，入参 images 长度为 1", async () => {
    const store = useAppStore();
    setCurrentModel({
      id: "multimodal-model",
      provider: "acme",
      input: ["text", "image"],
    });

    const result = await send({ text: "看这张图", images: [IMAGE] });

    expect(result).toBe(true);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const payload = promptSpy.mock.calls[0][0] as { images?: unknown[]; message: string };
    // 放行路径必须真的把图片带上 —— 「没报错」不等于「发出去了」
    expect(payload.images).toHaveLength(1);
    expect(payload.images?.[0]).toEqual(IMAGE);
    expect(payload.message).toBe("看这张图");
    expect(store.modelBlockedImages).toBeNull();
  });

  it("多张图全部带上", async () => {
    setCurrentModel({ id: "multimodal-model", provider: "acme", input: ["text", "image"] });
    await expect(send({ text: "三张", images: [IMAGE, IMAGE, IMAGE] })).resolves.toBe(true);
    const payload = promptSpy.mock.calls[0][0] as { images?: unknown[] };
    expect(payload.images).toHaveLength(3);
  });
});

describe("SEC-005 renderer send 资源边界", () => {
  beforeEach(() => {
    setCurrentModel({ id: "multimodal-model", provider: "acme", input: ["text", "image"] });
  });

  it("绕过 InputBar 传入过多图片时仍不发 RPC", async () => {
    await expect(
      send({ text: "too many", images: Array(MAX_PROMPT_IMAGES + 1).fill(IMAGE) })
    ).resolves.toBe(false);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(notified).toContainEqual(["warning", `图片最多添加 ${MAX_PROMPT_IMAGES} 张`]);
  });

  it("绕过 InputBar 传入超大图片时仍不发 RPC", async () => {
    const encoded = "A".repeat(4 * Math.ceil((MAX_PROMPT_IMAGE_BYTES + 1) / 3));
    await expect(
      send({
        text: "too large",
        images: [{ type: "image", data: encoded, mimeType: "image/png" }],
      })
    ).resolves.toBe(false);
    expect(promptSpy).not.toHaveBeenCalled();
    expect(notified.some(([, text]) => text.includes("单张图片不能超过"))).toBe(true);
  });

  it("非图片附件的数量和单文件大小同样在 RPC 前受限", async () => {
    const attachment = (index: number, size = 1) => ({
      token: `t-${index}`,
      name: `${index}.txt`,
      size,
      kind: "other" as const,
    });
    await expect(
      send({
        text: "too many files",
        attachments: Array.from({ length: MAX_PROMPT_ATTACHMENT_TOKENS + 1 }, (_, index) =>
          attachment(index)
        ),
      })
    ).resolves.toBe(false);
    await expect(
      send({ text: "huge file", attachments: [attachment(0, MAX_PROMPT_ATTACHMENT_BYTES + 1)] })
    ).resolves.toBe(false);
    const halfPlusOne = Math.floor(MAX_PROMPT_TOTAL_ATTACHMENT_BYTES / 2) + 1;
    await expect(
      send({
        text: "too much total",
        attachments: [attachment(1, halfPlusOne), attachment(2, halfPlusOne)],
      })
    ).resolves.toBe(false);
    expect(promptSpy).not.toHaveBeenCalled();
  });
});

describe("(c) 边界：纯文本永远发得出去", () => {
  it("input 为 undefined 且没有图片 → send() === true，不误拦", async () => {
    setCurrentModel({ id: "unknown-caps-model", provider: "acme" });
    const result = await send({ text: "只是一句话" });
    expect(result).toBe(true);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    const payload = promptSpy.mock.calls[0][0] as { images?: unknown[] };
    // 没有图片时不该凭空塞一个空数组进去
    expect(payload.images).toBeUndefined();
  });

  it("模型只收文本 + 纯文本消息 → 放行", async () => {
    setCurrentModel({ id: "text-only-model", provider: "acme", input: ["text"] });
    await expect(send({ text: "你好" })).resolves.toBe(true);
    expect(promptSpy).toHaveBeenCalledTimes(1);
  });

  it("空消息（无文本无图无附件）仍然返回 false 且不发 RPC", async () => {
    setCurrentModel({ id: "multimodal-model", provider: "acme", input: ["text", "image"] });
    await expect(send({ text: "   " })).resolves.toBe(false);
    expect(promptSpy).toHaveBeenCalledTimes(0);
  });
});

describe("模型能力的唯一来源是上游返回的字段", () => {
  it("一个自造的模型 id 只要 input 含 image 就放行（不查任何硬编码名单）", async () => {
    setCurrentModel({
      id: "test-model-xyz",
      provider: "nobody-has-heard-of-this",
      input: ["text", "image"],
    });
    await expect(send({ text: "图", images: [IMAGE] })).resolves.toBe(true);
    expect(promptSpy).toHaveBeenCalledTimes(1);
  });
});
