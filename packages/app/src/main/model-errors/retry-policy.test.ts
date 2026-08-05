import { describe, expect, it } from "vitest";

import type { ModelFailure } from "./model-failure.js";
import {
  MAX_PROVIDER_ATTEMPTS_PER_STEP,
  providerRetryDelayMs,
  shouldRetryProviderFailure,
} from "./retry-policy.js";

const RETRYABLE: ModelFailure = {
  kind: "rate_limit",
  retryable: true,
  message: "Rate limit exceeded",
};

/** 抖动置零，退避曲线因此可以逐点断言而不是只断言一个区间。 */
const noJitter = (): number => 0;
/** 抖动拉满，用来钉住上界。 */
const fullJitter = (): number => 1;

describe("退避：指数 + 抖动，base 1s / max 32s / jitter 0.25", () => {
  it("抖动为 0 时是 1s 起步的 2 的幂，32s 封顶", () => {
    const observed = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) =>
      providerRetryDelayMs(attempt, undefined, noJitter)
    );
    expect(observed).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000]);
  });

  it("抖动拉满时最多多出 25%，同样在封顶后不再增长", () => {
    expect(providerRetryDelayMs(1, undefined, fullJitter)).toBe(1_250);
    expect(providerRetryDelayMs(6, undefined, fullJitter)).toBe(40_000);
    expect(providerRetryDelayMs(9, undefined, fullJitter)).toBe(40_000);
  });

  it("第 0 次（或负数）不会把指数算成分数", () => {
    expect(providerRetryDelayMs(0, undefined, noJitter)).toBe(1_000);
    expect(providerRetryDelayMs(-3, undefined, noJitter)).toBe(1_000);
  });

  it("**服务端 retry-after 优先于本地退避**", () => {
    // 服务端说了具体等多久，本地再算一个数就是在跟它抢方向盘。
    expect(providerRetryDelayMs(5, 1_500, noJitter)).toBe(1_500);
    expect(providerRetryDelayMs(1, 90_000, fullJitter)).toBe(90_000);
  });
});

describe("重试前置条件：四条缺一不可", () => {
  const base = {
    failure: RETRYABLE,
    attempt: 1,
    budgetRemains: true,
    hasObservableOutput: false,
  };

  it("四条全满足才重试", () => {
    expect(shouldRetryProviderFailure(base)).toBe(true);
  });

  it("不可重试的失败不重试", () => {
    expect(
      shouldRetryProviderFailure({
        ...base,
        failure: { kind: "auth", retryable: false, message: "Authentication failed" },
      })
    ).toBe(false);
  });

  it("次数用尽不重试", () => {
    expect(
      shouldRetryProviderFailure({ ...base, attempt: MAX_PROVIDER_ATTEMPTS_PER_STEP })
    ).toBe(false);
    expect(
      shouldRetryProviderFailure({ ...base, attempt: MAX_PROVIDER_ATTEMPTS_PER_STEP - 1 })
    ).toBe(true);
  });

  it("预算已尽不重试", () => {
    expect(shouldRetryProviderFailure({ ...base, budgetRemains: false })).toBe(false);
  });

  /**
   * 这一条是四条里最容易被漏掉、也最要命的：请求已经往界面上吐过字之后再
   * 重试，用户看到的是**同一段话被说了两遍**。
   */
  it("本次尝试已产生可见输出 → 不重试", () => {
    expect(shouldRetryProviderFailure({ ...base, hasObservableOutput: true })).toBe(false);
  });

  it("已有可见输出时，另外三条全满足也不重试", () => {
    expect(
      shouldRetryProviderFailure({
        failure: RETRYABLE,
        attempt: 1,
        budgetRemains: true,
        hasObservableOutput: true,
      })
    ).toBe(false);
  });

  it("maxAttempts 可覆盖（不同调用点的预算不同）", () => {
    expect(shouldRetryProviderFailure({ ...base, attempt: 2, maxAttempts: 3 })).toBe(true);
    expect(shouldRetryProviderFailure({ ...base, attempt: 3, maxAttempts: 3 })).toBe(false);
  });
});
