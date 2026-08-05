/**
 * pi 事件面 → 归一化模型错误（MDL-101 的**边界适配层**）。
 *
 * ## pi 的错误以什么形状到达我们
 *
 * 全部经 RPC stdout 的 JSONL 事件流，**没有一条走 stderr 或退出码**（后两者
 * 是进程级故障，另有出口）。产生 provider 错误的事件只有这几个，形状读自
 * `@pibuddy/pi-sdk` 的 `AgentEvent`：
 *
 *   - `message_end` 的 assistant 消息 `stopReason:"error"` + `errorMessage`
 *   - `auto_retry_start` `{attempt, maxAttempts, delayMs, errorMessage}`
 *   - `auto_retry_end`   `{success:false, finalError}`
 *   - `compaction_end`   `{errorMessage}`
 *
 * 四个字段**全是裸字符串**：pi 内部确实做了分类（`isContextOverflow` 用于
 * 触发自动压缩、`retryProviderRequest` 用于重试退避），但那些判定结论
 * **一个都没有出现在协议里**。我们收到的只有各家 provider 的原始英文报文。
 * 这就是本域存在的全部理由：把那句原文变成一个可以驱动界面动作的 kind。
 *
 * ## 状态码的知识住在**这一层**，不住在分类器里
 *
 * 分类器只认显式的 `statusCode` / `code` 字段，绝不从子串里猜 —— 正文里出现
 * 「413」这三个字符的次数远多于它真是状态码的次数。但 pi 给我们的是字符串，
 * 于是经 pi 的 5xx / 401 / 402 会**全部退化成 unknown**，用户拿到的仍然是
 * 一句没有方向的话。
 *
 * 解法不是放松分类器，而是让**知道 pi 格式的这一层**把状态码解出来后以
 * 显式字段交进去：OpenAI / Anthropic 官方 SDK 的 `APIError.message` 恒为
 * `"<status> <body>"`（pi 自己的文档里也是这么记的：`413 {"error":…}`、
 * `400/413 status code (no body)`）。这是**解析一个已知格式的前缀**，不是
 * 在全文里找数字：必须位于串首、必须是 400–599、后面必须跟空白或串尾。
 * 越出这个窄口的一律不认，宁可退回纯文本证据。
 */
import type { AgentEvent, AssistantMessage } from "@pibuddy/pi-sdk";
import type { ModelErrorSource, PiModelErrorPayload } from "@pibuddy/contract";

import { redactSecrets } from "../logger-redact.js";
import { normalizeModelFailure } from "./model-failure.js";

/**
 * 送去展示的原文：脱敏 + 有界。
 *
 * 长度上界由 `redactSecrets` 自己给（512 字符 + `…(+N)` 标记），这里不再叠
 * 第二把裁剪刀 —— 两处各截一次的话，界面上那个 `+N` 说的就不是真实剩余量。
 *
 * **脱敏在分类之后**：401 的响应正文里经常原样回显发过去的 Authorization，
 * 而 `[redacted]` 会毁掉证据。顺序反过来的话，某些溢出文案会因为里面恰好
 * 有个被抹掉的字段而分不出来。
 */
function redactedRaw(text: string): string {
  return String(redactSecrets(text));
}

/**
 * 官方 SDK 的 `"<status> <body>"` 前缀。窄口：串首、400–599、后跟空白或串尾。
 */
const SDK_STATUS_PREFIX = /^\s*([45]\d\d)(?=\s|$)/;

/**
 * 把 pi 的一行原文变成分类器的输入。
 *
 * 认得出状态码就交一个**带显式 statusCode 字段**的证据对象，认不出就原样交
 * 字符串 —— 后者仍然走全套文本证据（两张正则表），只是少了状态码那一档。
 */
function evidenceFrom(raw: string): unknown {
  const matched = SDK_STATUS_PREFIX.exec(raw);
  if (!matched) return raw;
  return { statusCode: Number(matched[1]), message: raw };
}

/**
 * 把一段 provider 原文归一成 payload。
 *
 * 走的是**字符串 / 裸对象**入口而不是 Error 入口：pi 给到我们的就是字符串，
 * 硬包一个 `new Error(text)` 会凭空造出一个 `name: "Error"` 混进文本证据里。
 */
function reportFrom(
  raw: string,
  source: ModelErrorSource,
  extra?: { retryAfterMs?: number; attempt?: number; maxAttempts?: number }
): PiModelErrorPayload {
  const failure = normalizeModelFailure(evidenceFrom(raw));
  const retryAfterMs = extra?.retryAfterMs ?? failure.retryAfterMs;
  return {
    kind: failure.kind,
    source,
    message: failure.message,
    raw: redactedRaw(raw),
    retryable: failure.retryable,
    ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { retryAfterMs } : {}),
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    ...(extra?.attempt !== undefined ? { attempt: extra.attempt } : {}),
    ...(extra?.maxAttempts !== undefined ? { maxAttempts: extra.maxAttempts } : {}),
  };
}

/**
 * 从一条 pi 事件里摘出模型错误；不是错误就返回 null。
 *
 * **中止不产出报告**：`stopReason:"aborted"` 是用户自己按的停止键，界面上
 * 早已有「已按你的要求停止」。再弹一条错误提示等于告诉用户他刚做的事出了问题。
 */
export function modelErrorFromAgentEvent(event: AgentEvent): PiModelErrorPayload | null {
  switch (event.type) {
    case "message_end": {
      const message = event.message as AssistantMessage;
      if (message?.role !== "assistant") return null;
      if (message.stopReason !== "error") return null;
      const text = message.errorMessage;
      if (!text) return null;
      return reportFrom(text, "message");
    }
    case "auto_retry_start":
      if (!event.errorMessage) return null;
      return reportFrom(event.errorMessage, "retry", {
        ...(event.delayMs > 0 ? { retryAfterMs: event.delayMs } : {}),
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
      });
    case "auto_retry_end":
      if (event.success || !event.finalError) return null;
      return reportFrom(event.finalError, "retry-final", { attempt: event.attempt });
    case "compaction_end":
      if (!event.errorMessage) return null;
      return reportFrom(event.errorMessage, "compaction");
    default:
      return null;
  }
}

/**
 * pi 子进程崩溃退出时的报告。
 *
 * 只在 `crash` 且带错误正文时产出：用户点「停止」造成的 `expected-stop`
 * 不是故障，早先那条「智能体进程意外退出」的误报就是没分这两者的结果。
 */
export function modelErrorFromExit(meta: {
  reason: "expected-stop" | "crash";
  error?: string;
}): PiModelErrorPayload | null {
  if (meta.reason !== "crash" || !meta.error) return null;
  return reportFrom(meta.error, "exit");
}
