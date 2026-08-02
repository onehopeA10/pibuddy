/**
 * 模型输入能力判定（PROV-101）。
 *
 * 判据只有一个：`Model.input` 数组里有没有 `"image"`。这个文件同时是那条
 * 「不硬编码模型名单」纪律的守卫 —— 最后一组用例用一个**从没有人见过的
 * 模型 id** 走通全流程，任何基于名单的实现都会在那里失败。
 */
import { describe, expect, it } from "vitest";
import type { Model } from "@sdk";

import {
  assertImageCapable,
  imageBlockedMessage,
  imageCapableModels,
  supportsImage,
} from "./model-capability";

const TEXT_ONLY = { id: "text-only", provider: "acme", input: ["text"] };
const MULTIMODAL = { id: "multimodal", provider: "acme", input: ["text", "image"] };
const NO_FIELD = { id: "no-caps-field", provider: "acme" };

describe("supportsImage", () => {
  it("input 含 image → true；不含 / 缺席 / null → false", () => {
    expect(supportsImage(MULTIMODAL)).toBe(true);
    expect(supportsImage(TEXT_ONLY)).toBe(false);
    expect(supportsImage(NO_FIELD)).toBe(false);
    expect(supportsImage(null)).toBe(false);
    expect(supportsImage(undefined)).toBe(false);
  });

  it("input 里有别的模态但没有 image → 仍是 false", () => {
    expect(supportsImage({ id: "a", input: ["text", "audio", "video"] })).toBe(false);
  });
});

describe("assertImageCapable", () => {
  it("没有图片时恒放行 —— 纯文本消息永远不该被能力判定挡住", () => {
    expect(assertImageCapable(TEXT_ONLY, 0)).toEqual({ ok: true });
    expect(assertImageCapable(NO_FIELD, 0)).toEqual({ ok: true });
    expect(assertImageCapable(null, 0)).toEqual({ ok: true });
    // 负数（不该发生，但发生了也不能变成拦截）
    expect(assertImageCapable(TEXT_ONLY, -1)).toEqual({ ok: true });
  });

  it("有图片 + 模型支持 → 放行", () => {
    expect(assertImageCapable(MULTIMODAL, 1)).toEqual({ ok: true });
    expect(assertImageCapable(MULTIMODAL, 5)).toEqual({ ok: true });
  });

  it("有图片 + 模型不支持 → 拦住，并带上当前模型 id 与可切换列表", () => {
    const verdict = assertImageCapable(TEXT_ONLY, 1, [TEXT_ONLY, MULTIMODAL, NO_FIELD]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("no-image-support");
    expect(verdict.currentModelId).toBe("text-only");
    // 建议列表只含真正收得下图的那些
    expect(verdict.suggestedModelIds).toEqual(["multimodal"]);
  });

  it("没有任何支持图片的模型时，建议列表为空数组而不是 undefined", () => {
    const verdict = assertImageCapable(TEXT_ONLY, 1, [TEXT_ONLY, NO_FIELD]);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.suggestedModelIds).toEqual([]);
  });

  it("完全没选模型时 currentModelId 是一句可读的话，不是 undefined", () => {
    const verdict = assertImageCapable(null, 1);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.currentModelId).toContain("未选择");
  });
});

describe("imageCapableModels", () => {
  it("按 input 过滤，保持上游给的顺序", () => {
    const models = [TEXT_ONLY, MULTIMODAL, NO_FIELD, { ...MULTIMODAL, id: "mm2" }] as Model[];
    expect(imageCapableModels(models).map((m) => m.id)).toEqual(["multimodal", "mm2"]);
  });

  it("空列表返回空列表", () => {
    expect(imageCapableModels([])).toEqual([]);
  });
});

describe("提示文案必须带上模型 id", () => {
  it("有可切换目标时提示「切换」", () => {
    const verdict = assertImageCapable(TEXT_ONLY, 1, [MULTIMODAL]);
    if (verdict.ok) throw new Error("unreachable");
    const text = imageBlockedMessage(verdict);
    expect(text).toContain("text-only");
    expect(text).toContain("切换");
  });

  it("没有可切换目标时提示「移除图片」而不是让用户去点一个不存在的按钮", () => {
    const verdict = assertImageCapable(TEXT_ONLY, 1, []);
    if (verdict.ok) throw new Error("unreachable");
    const text = imageBlockedMessage(verdict);
    expect(text).toContain("text-only");
    expect(text).toContain("移除图片");
  });
});

describe("唯一来源是上游返回的字段，不是任何硬编码名单", () => {
  it("一个自造的模型 id（input 含 image）照样被判为支持图片", () => {
    const invented = { id: "test-model-xyz", provider: "made-up", input: ["text", "image"] };
    expect(supportsImage(invented)).toBe(true);
    expect(assertImageCapable(invented, 3)).toEqual({ ok: true });
    expect(imageCapableModels([invented] as Model[]).map((m) => m.id)).toEqual([
      "test-model-xyz",
    ]);
  });

  it("一个名字听起来很强、但 input 只有 text 的模型仍被拦住", () => {
    const misleading = { id: "super-vision-pro-max", provider: "made-up", input: ["text"] };
    expect(supportsImage(misleading)).toBe(false);
    expect(assertImageCapable(misleading, 1).ok).toBe(false);
  });
});
