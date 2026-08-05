import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@pibuddy/pi-sdk";
import { piModelErrorPayloadSchema } from "@pibuddy/contract";

import { modelErrorFromAgentEvent, modelErrorFromExit } from "./pi-error-report.js";

/** pi 的 message_end：assistant 消息以 stopReason 收场。 */
function messageEnd(stopReason: string, errorMessage?: string): AgentEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    },
  } as AgentEvent;
}

describe("pi 事件面 → 归一化模型错误", () => {
  it("assistant 以 stopReason=error 收场 → source=message，kind 来自原文", () => {
    const report = modelErrorFromAgentEvent(
      messageEnd("error", "prompt is too long: 213462 tokens > 200000 maximum")
    );
    expect(report).toMatchObject({
      kind: "context_overflow",
      source: "message",
      retryable: false,
    });
    expect(report?.raw).toContain("prompt is too long");
  });

  it("**中止不产出报告**：那是用户自己按的停止键", () => {
    expect(modelErrorFromAgentEvent(messageEnd("aborted"))).toBeNull();
    expect(modelErrorFromAgentEvent(messageEnd("stop"))).toBeNull();
  });

  it("stopReason=error 但没有正文 → 没有证据，不报", () => {
    expect(modelErrorFromAgentEvent(messageEnd("error"))).toBeNull();
  });

  it("auto_retry_start：source=retry，delayMs 作为 retryAfterMs 交给倒计时", () => {
    const report = modelErrorFromAgentEvent({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 4_000,
      errorMessage: "429 Too Many Requests: rate limit exceeded",
    });
    expect(report).toMatchObject({
      kind: "rate_limit",
      source: "retry",
      retryAfterMs: 4_000,
      attempt: 2,
      maxAttempts: 5,
    });
  });

  it("auto_retry_end：只有失败才报", () => {
    expect(
      modelErrorFromAgentEvent({ type: "auto_retry_end", success: true, attempt: 3 })
    ).toBeNull();
    expect(
      modelErrorFromAgentEvent({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "503 upstream unavailable",
      })
    ).toMatchObject({ kind: "provider_unavailable", source: "retry-final", attempt: 3 });
  });

  /**
   * 状态码的格式知识住在适配层：官方 SDK 的 `APIError.message` 恒为
   * `"<status> <body>"`，本层把它解成显式字段再交给分类器。分类器自己
   * 仍然只认显式字段。
   */
  it("SDK 的 `<status> <body>` 前缀被解成显式状态码", () => {
    expect(modelErrorFromAgentEvent(messageEnd("error", "401 invalid api key"))?.kind).toBe("auth");
    expect(
      modelErrorFromAgentEvent(messageEnd("error", "402 insufficient credits"))?.kind
    ).toBe("provider_billing");
    expect(modelErrorFromAgentEvent(messageEnd("error", "500 internal error"))?.kind).toBe(
      "provider_unavailable"
    );
    expect(
      modelErrorFromAgentEvent(
        messageEnd("error", '413 {"error":{"type":"request_too_large"}}')
      )?.kind
    ).toBe("context_overflow");
  });

  it("窄口之外的数字前缀不认（否则「正文里有个数」就成了状态码）", () => {
    // 200 不在 4xx/5xx；1024 不是三位；数字后面不是空白。
    expect(modelErrorFromAgentEvent(messageEnd("error", "200 tokens were dropped"))?.kind).toBe(
      "unknown"
    );
    expect(modelErrorFromAgentEvent(messageEnd("error", "4130 items failed"))?.kind).toBe(
      "unknown"
    );
    expect(modelErrorFromAgentEvent(messageEnd("error", "job 500 crashed"))?.kind).toBe("unknown");
  });

  it("compaction_end 带错 → source=compaction", () => {
    const report = modelErrorFromAgentEvent({
      type: "compaction_end",
      reason: "overflow",
      result: null,
      aborted: false,
      errorMessage: "Input length (265330) exceeds model's maximum context length (262144).",
    });
    expect(report).toMatchObject({ kind: "context_overflow", source: "compaction" });
  });

  it("与 provider 错误无关的事件一律返回 null", () => {
    expect(modelErrorFromAgentEvent({ type: "agent_start" })).toBeNull();
    expect(modelErrorFromAgentEvent({ type: "turn_start" })).toBeNull();
    expect(
      modelErrorFromAgentEvent({
        type: "extension_error",
        extensionPath: "/x",
        event: "y",
        error: "boom",
      })
    ).toBeNull();
  });
});

describe("退出：只有崩溃才报", () => {
  it("expected-stop 不报（用户点的停止不是故障）", () => {
    expect(modelErrorFromExit({ reason: "expected-stop", error: "whatever" })).toBeNull();
  });

  it("crash 且带正文才报", () => {
    expect(modelErrorFromExit({ reason: "crash" })).toBeNull();
    expect(
      modelErrorFromExit({ reason: "crash", error: "spawn pi ENOENT" })
    ).toMatchObject({ source: "exit", kind: "unknown" });
  });
});

describe("产出的 payload 必须过得了 IPC 边界的 schema", () => {
  /**
   * 这条不是形式主义：`PUSH_CONTRACTS` 里那份 schema 是渲染侧解包前的最后
   * 一道闸。适配层哪天多给一个字段或把 retryAfterMs 给成 0，消息会在边界上
   * 被**静默丢弃** —— 没有报错、没有日志，只是提示再也不出现。
   */
  const SAMPLES: AgentEvent[] = [
    messageEnd("error", "prompt is too long: 213462 tokens > 200000 maximum"),
    messageEnd("error", "401 invalid api key"),
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 0,
      errorMessage: "429 rate limit exceeded",
    },
    {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "500 internal error",
    },
    {
      type: "compaction_end",
      reason: "overflow",
      result: null,
      aborted: false,
      errorMessage: "context_length_exceeded",
    },
  ];

  it.each(SAMPLES.map((event, i) => [i, event] as const))("样本 %i", (_i, event) => {
    const report = modelErrorFromAgentEvent(event);
    expect(report).not.toBeNull();
    expect(piModelErrorPayloadSchema.safeParse(report).success).toBe(true);
  });

  it("delayMs=0 不会变成一个非法的 retryAfterMs", () => {
    // schema 要求 positive；给 0 会让整条消息在边界上被丢掉。
    const report = modelErrorFromAgentEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 0,
      errorMessage: "429 rate limit exceeded",
    });
    expect(report?.retryAfterMs).toBeUndefined();
  });

  it("崩溃退出的 payload 同样过 schema", () => {
    const report = modelErrorFromExit({ reason: "crash", error: "spawn pi ENOENT" });
    expect(piModelErrorPayloadSchema.safeParse(report).success).toBe(true);
  });
});

describe("送去展示的原文要脱敏", () => {
  it("401 响应正文里回显的 Authorization 不会原样进渲染进程", () => {
    const report = modelErrorFromAgentEvent(
      messageEnd(
        "error",
        '401 {"error":"invalid key","echo":"Authorization: Bearer sk-live-abcdefgh12345678"}'
      )
    );
    expect(report?.kind).toBe("auth");
    expect(report?.raw).not.toContain("sk-live-abcdefgh12345678");
    // 证据没被整段毁掉：仍然看得出是哪个字段泄的
    expect(report?.raw).toContain("invalid key");
  });

  it("分类跑在**脱敏之前**：被抹掉的字段不会让溢出文案失配", () => {
    const report = modelErrorFromAgentEvent(
      messageEnd(
        "error",
        'Bearer sk-live-abcdefgh12345678 → prompt is too long: 213462 tokens > 200000 maximum'
      )
    );
    expect(report?.kind).toBe("context_overflow");
  });
});
