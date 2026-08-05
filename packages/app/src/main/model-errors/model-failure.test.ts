import { describe, expect, it } from "vitest";
import { MODEL_ERROR_KINDS } from "@pibuddy/contract";

import {
  errorClassFromFailureKind,
  modelFailureKind,
  normalizeModelFailure,
} from "./model-failure.js";

function apiError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe("类别名 ↔ kind 的双向映射", () => {
  it("每个 kind 往返一次都回到自己", () => {
    // 只有正向映射时，漏加的成员会静默落进 unknown —— 而 unknown 恰好是
    // 一个合法值，于是漏加这件事没有任何地方会报错。
    for (const kind of MODEL_ERROR_KINDS) {
      expect(modelFailureKind(errorClassFromFailureKind(kind))).toBe(kind);
    }
  });

  it("认不出的类别名一律 unknown，不猜", () => {
    expect(modelFailureKind("SomethingNew")).toBe("unknown");
    expect(modelFailureKind("")).toBe("unknown");
  });
});

describe("normalizeModelFailure", () => {
  it("上下文溢出：不可重试，给出归一化展示语", () => {
    const failure = normalizeModelFailure(
      "prompt is too long: 213462 tokens > 200000 maximum"
    );
    expect(failure.kind).toBe("context_overflow");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toBe("Context window exceeded");
  });

  it("限流：可重试并带上服务端给的时长", () => {
    const failure = normalizeModelFailure(
      apiError("Too Many Requests", {
        statusCode: 429,
        responseHeaders: { "retry-after-ms": "2500" },
      })
    );
    expect(failure).toMatchObject({
      kind: "rate_limit",
      retryable: true,
      retryAfterMs: 2500,
      message: "Rate limit exceeded",
    });
  });

  it("鉴权 / 计费各自成类", () => {
    expect(normalizeModelFailure(apiError("Unauthorized", { statusCode: 401 })).kind).toBe("auth");
    expect(normalizeModelFailure(apiError("Payment Required", { statusCode: 402 })).kind).toBe(
      "provider_billing"
    );
  });

  it("分不出类时退化为**原文首行**，而不是一句无内容的套话", () => {
    const failure = normalizeModelFailure("Something odd happened\nstack line 1\nstack line 2");
    expect(failure.kind).toBe("unknown");
    expect(failure.message).toBe("Something odd happened");
  });

  it("超长的兜底文案被截断", () => {
    const failure = normalizeModelFailure("x".repeat(500));
    expect(failure.message.length).toBeLessThanOrEqual(201);
    expect(failure.message.endsWith("…")).toBe(true);
  });

  it("返回值里不出现任何 SDK 对象或响应头", () => {
    const failure = normalizeModelFailure(
      apiError("Too Many Requests", {
        statusCode: 429,
        responseHeaders: { "retry-after": "1", "x-request-id": "abc" },
        data: { error: { code: "rate_limit_exceeded" } },
      })
    );
    expect(Object.keys(failure).sort()).toEqual([
      "kind",
      "message",
      "retryAfterMs",
      "retryable",
    ]);
  });
});
