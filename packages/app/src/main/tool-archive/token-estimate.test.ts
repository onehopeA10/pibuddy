import { describe, expect, it } from "vitest";

import {
  CJK_TOKENS_PER_CHAR,
  NON_CJK_CHARS_PER_TOKEN,
  estimateTokens,
} from "./token-estimate.js";

/**
 * token 估算的中文标定（tool-archive）。
 *
 * 这组用例钉住的是**常数本身**，不是实现细节：参考实现的 `chars / 4` 对中文
 * 低估 6 倍，我们是中文优先产品，所以重标定成「CJK 每字 1.5 token、其余
 * 每 4 字符 1 token」。期望值都是手算得出、写在断言旁边的——写成
 * `expect(f(s)).toBe(f(s))` 那种自证式断言等于没测。
 */

/** 旧口径，只在对拍里出现：用它证明「同一段中文，两种口径差 6 倍」。 */
const legacyEstimate = (text: string): number => Math.ceil(text.length / 4);

describe("estimateTokens：按字符类别分段", () => {
  it("空串是 0（不是 NaN、不是 1）", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("纯 ASCII 沿用 4 字符 / token：11 字符 → 3", () => {
    // 11 / 4 = 2.75 → ceil 3
    expect(estimateTokens("hello world")).toBe(3);
  });

  it("纯中文按 1.5 token / 字：6 字 → 9", () => {
    // 6 × 1.5 = 9
    expect(estimateTokens("客厅灯已打开")).toBe(9);
  });

  it("中英混排分段相加：7 汉字 + 8 ASCII → 13", () => {
    // "PiBuddy " = 8 个 ASCII → 2；"的工具结果护栏" = 7 汉字 → 10.5；合计 12.5 → 13
    expect(estimateTokens("PiBuddy 的工具结果护栏")).toBe(13);
  });

  it("中文标点与数字混排：11 CJK + 4 ASCII → 18", () => {
    // "客厅灯已打开，当前亮度" = 11（全角逗号算 CJK）→ 16.5；" 180" = 4 → 1；合计 17.5 → 18
    expect(estimateTokens("客厅灯已打开，当前亮度 180")).toBe(18);
  });

  it("全角标点计入 CJK（它们在中文文本里到处都是）", () => {
    expect(estimateTokens("（全角括号）")).toBe(9);
  });

  it("扩展汉字按码点算 1 个字，不因代理对被算成 2 个", () => {
    // "𠮷野家" UTF-16 长度是 4（𠮷 是代理对），码点数是 3 → 3 × 1.5 = 4.5 → 5
    expect("𠮷野家".length).toBe(4);
    expect(estimateTokens("𠮷野家")).toBe(5);
  });

  it("常数就是标定结果本身", () => {
    expect([CJK_TOKENS_PER_CHAR, NON_CJK_CHARS_PER_TOKEN]).toEqual([1.5, 4]);
  });
});

describe("对拍：旧口径 chars/4 对中文低估 6 倍", () => {
  it("纯中文：新口径恰是旧口径的 6 倍", () => {
    const zh = "智能家居实体的完整属性快照".repeat(40);
    expect(estimateTokens(zh) / legacyEstimate(zh)).toBe(6);
  });

  it("纯 ASCII：两种口径完全一致（重标定不误伤英文）", () => {
    const en = JSON.stringify({ entity_id: "light.living_room", state: "on" }).repeat(20);
    expect(estimateTokens(en)).toBe(legacyEstimate(en));
  });

  it("落到阈值上：同一段中文，旧口径不触发 2048，新口径触发", () => {
    // 1560 个汉字：旧口径报 390 token（远低于阈值 → 不归档，上下文被撑爆）；
    // 新口径报 2340 token（超阈值 → 归档）。这就是重标定要解决的那件事。
    const zh = "智能家居实体的完整属性快照".repeat(120);
    expect(zh.length).toBe(1560);
    expect(legacyEstimate(zh)).toBe(390);
    expect(estimateTokens(zh)).toBe(2340);
  });
});
