import { describe, expect, it } from "vitest";
import { MODEL_ERROR_KINDS, MODEL_ERROR_SOURCES } from "@contract";

import {
  adviseModelError,
  formatRetryAfter,
  retryStatusText,
  shouldSurfaceModelError,
} from "./model-error-advice";

describe("每个 kind 都有可操作的中文提示", () => {
  it("没有任何一类落到「请稍后再试」这种无内容的话上", () => {
    for (const kind of MODEL_ERROR_KINDS) {
      const advice = adviseModelError(kind);
      expect(advice.title, kind).toBeTruthy();
      expect(advice.hint.length, kind).toBeGreaterThan(8);
      // 全中文文案：漏译一条的表现是界面上突然冒出一句英文
      expect(/[一-龥]/.test(advice.title), kind).toBe(true);
    }
  });

  it("四类关键错误各自指向一个真存在的入口", () => {
    expect(adviseModelError("context_overflow")).toMatchObject({
      action: "compact",
      actionLabel: expect.stringContaining("整理"),
    });
    expect(adviseModelError("auth")).toMatchObject({ action: "provider" });
    expect(adviseModelError("provider_billing")).toMatchObject({ action: "usage" });
    expect(adviseModelError("rate_limit")).toMatchObject({ action: "wait" });
  });

  it("限流带上服务端给的时长时，提示里出现具体的等待时间", () => {
    expect(adviseModelError("rate_limit", { retryAfterMs: 8_000 }).hint).toContain("8 秒");
    expect(adviseModelError("rate_limit", { retryAfterMs: 125_000 }).hint).toContain("3 分钟");
    // 其它类别不受影响：retryAfter 只对限流有意义
    expect(adviseModelError("auth", { retryAfterMs: 8_000 })).toEqual(adviseModelError("auth"));
  });

  it("不足一秒按一秒说 —— 「等 0 秒」是句废话", () => {
    expect(formatRetryAfter(1)).toBe("1 秒");
    expect(formatRetryAfter(0)).toBe("1 秒");
    expect(formatRetryAfter(59_000)).toBe("59 秒");
    expect(formatRetryAfter(60_000)).toBe("1 分钟");
  });
});

describe("哪些报告该抢用户的注意力", () => {
  it("自动重试期间不弹横幅：系统正在自愈时不该催用户动手", () => {
    expect(shouldSurfaceModelError("retry", "rate_limit")).toBe(false);
    expect(shouldSurfaceModelError("retry-final", "rate_limit")).toBe(true);
  });

  it("abort 根本不是故障", () => {
    for (const source of MODEL_ERROR_SOURCES) {
      expect(shouldSurfaceModelError(source, "abort"), source).toBe(false);
    }
  });

  it("其余来源一律浮出", () => {
    for (const source of MODEL_ERROR_SOURCES) {
      if (source === "retry") continue;
      expect(shouldSurfaceModelError(source, "context_overflow"), source).toBe(true);
    }
  });
});

describe("重试状态条按类别措辞", () => {
  it("限流不再被说成「网络繁忙」", () => {
    const text = retryStatusText("rate_limit", 2, 5);
    expect(text).toContain("服务商限流");
    expect(text).toContain("(2/5)");
    expect(text).not.toContain("网络");
  });

  it("各类别互不相同，分不出类时给中性说法", () => {
    const variants = new Set(
      (["rate_limit", "provider_unavailable", "timeout", "network"] as const).map((kind) =>
        retryStatusText(kind, 1, 3)
      )
    );
    expect(variants.size).toBe(4);
    expect(retryStatusText("unknown", 1, 3)).toContain("上次请求失败");
  });
});
