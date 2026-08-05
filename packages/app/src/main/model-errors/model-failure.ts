/**
 * provider 错误 → 归一化失败对象（MDL-101）。
 *
 * 移植自 `source/maka-agent/packages/runtime/src/model-adapter.ts:710-790`
 * 的 `normalizeModelFailure` / `modelFailureKind` / `errorClassFromFailureKind`。
 *
 * `errorClassFromFailureKind` 是**反向映射**，它不是给谁用的方便函数 ——
 * 它的存在让「类别名 ↔ kind」这对映射有两个方向可以互相对照，任何一边加了
 * 成员而另一边忘了，都会在单测里表现为一次往返不等。只有正向映射时，漏加
 * 的成员静默落进 `unknown`，而 unknown 恰好是一个合法值。
 */
import type { ModelErrorKind } from "@pibuddy/contract";

import {
  classifyError,
  errorPresentationFromClass,
  providerRetryMetadata,
} from "./provider-error-classification.js";

/**
 * 一次模型请求失败的归一化表示。
 *
 * 这里**不出现任何 SDK 对象**：`retryable` / `retryAfterMs` 是两个标量，
 * 上层因此不可能顺着它摸回 provider 响应头。
 */
export interface ModelFailure {
  kind: ModelErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  /** provider 的顶层 code（若有），排障用 */
  code?: string;
  /** 归一化后的一句话；分不出类时退化为原文首行 */
  message: string;
}

export function modelFailureKind(errorClass: string): ModelErrorKind {
  switch (errorClass) {
    case "Abort":
      return "abort";
    case "Auth":
      return "auth";
    case "ContextLength":
      return "context_overflow";
    case "Network":
      return "network";
    case "ProviderBilling":
      return "provider_billing";
    case "ProviderUnavailable":
      return "provider_unavailable";
    case "RateLimit":
      return "rate_limit";
    case "Timeout":
      return "timeout";
    default:
      return "unknown";
  }
}

export function errorClassFromFailureKind(kind: ModelErrorKind): string {
  switch (kind) {
    case "abort":
      return "Abort";
    case "auth":
      return "Auth";
    case "context_overflow":
      return "ContextLength";
    case "network":
      return "Network";
    case "provider_billing":
      return "ProviderBilling";
    case "provider_unavailable":
      return "ProviderUnavailable";
    case "rate_limit":
      return "RateLimit";
    case "timeout":
      return "Timeout";
    case "unknown":
      return "Other";
  }
}

/**
 * 分不出类时的兜底文案：原文首行，去掉两端空白并截断。
 *
 * 三条取值路径都必要：Error 取 `.message`；流内 error part 是**裸对象**，
 * 直接 `String()` 会得到 "[object Object]"，必须先看它的 `message` 字段；
 * 其余才落到 `String()`。
 */
function fallbackMessage(error: unknown): string {
  const messageField =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  const text =
    error instanceof Error
      ? error.message
      : typeof messageField === "string"
        ? messageField
        : String(error);
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/**
 * 把任意 provider 错误归一成 `ModelFailure`。
 *
 * 三件事按顺序发生，顺序不可换：先分类（决定 kind 与展示语），再取重试元
 * 数据（它内部会再分一次类以判 Network），最后才是兜底文案。
 */
export function normalizeModelFailure(error: unknown): ModelFailure {
  const errorClass = classifyError(error);
  const presentation = errorPresentationFromClass(errorClass);
  const retry = providerRetryMetadata(error);
  const code =
    error instanceof Error && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  return {
    kind: modelFailureKind(errorClass),
    retryable: retry.retryable,
    ...(retry.retryAfterMs !== undefined ? { retryAfterMs: retry.retryAfterMs } : {}),
    ...(code !== undefined ? { code } : {}),
    message: presentation.message ?? fallbackMessage(error),
  };
}
