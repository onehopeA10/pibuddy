/**
 * 模型 / provider 错误的**归一化词汇**（MDL-101）。
 *
 * 收敛前 pi 的报错是原样透传的：用户看到的是各家 provider 的原始英文报文
 * （Anthropic 的 "prompt is too long: 213462 tokens > 200000 maximum"、
 * OpenRouter 的 "maximum context length is 131072 tokens"、LiteLLM 把
 * provider 溢出包进的 503……）。这些句子对排障有用，对**下一步该做什么**
 * 毫无帮助 —— 「压缩会话」「去填 key」「去充值」「等一会儿」是四件完全不同
 * 的事，而原文并不告诉用户是哪一件。
 *
 * 这里只放**词汇**，不放判据：
 *   - 判据（证据归一 + 否决表 + 正则表 + 重试元数据）住在主进程的
 *     `main/model-errors/`，纯函数、可对拍；
 *   - 中文可操作文案住在渲染层的 `model-error-advice.ts`。
 *
 * 三层各自拥有自己的抽象级别，谁都不重复另一层的内容 —— 这也是这个 kind
 * 必须落在契约包而不是任一进程里的唯一理由：它是两个进程之间共用的那个词。
 */
import { z } from "zod";

/**
 * 归一化后的错误类别。
 *
 * 每一项都对应一个**不同的下一步动作**，这是分这么多类的判据；分不出动作
 * 差别的类别一律并进 `unknown`，宁可少说也不误导。
 */
export const MODEL_ERROR_KINDS = [
  /** 输入超出模型上下文窗口 —— 压缩会话或换大窗口模型能修 */
  "context_overflow",
  /** 限流 / 并发超额 —— 等待 retry-after 后重试能修 */
  "rate_limit",
  /** 鉴权失败 —— 去 Provider 中心改 key */
  "auth",
  /** 余额 / 计费问题（HTTP 402）—— 去额度页看用量、去服务商充值 */
  "provider_billing",
  /** provider 侧 5xx —— 只能等或换模型 */
  "provider_unavailable",
  /** 本机到 provider 的网络问题 */
  "network",
  /** 请求超时 */
  "timeout",
  /** 用户主动中止，不是故障 */
  "abort",
  /** 证据不足以归类。**不猜** —— 猜错会把用户引到错误的设置页 */
  "unknown",
] as const;

export const modelErrorKindSchema = z.enum(MODEL_ERROR_KINDS);
export type ModelErrorKind = z.infer<typeof modelErrorKindSchema>;

/**
 * 这条错误是从 pi 的哪个事件面上摘下来的。
 *
 * 渲染层据此决定语气：`retry` 是「还在自愈中」，`retry-final` 与 `message`
 * 才是「这一轮已经失败了」。合成一个字段的话，重试过程中的提示会和终态
 * 提示长得一模一样，用户分不清还要不要动手。
 */
export const MODEL_ERROR_SOURCES = [
  /** assistant 消息以 stopReason=error 收场 */
  "message",
  /** pi 的自动重试开始（还在自愈中） */
  "retry",
  /** pi 的自动重试彻底失败 */
  "retry-final",
  /** 压缩（compaction）失败 */
  "compaction",
  /** pi 子进程崩溃退出 */
  "exit",
] as const;

export const modelErrorSourceSchema = z.enum(MODEL_ERROR_SOURCES);
export type ModelErrorSource = z.infer<typeof modelErrorSourceSchema>;

/**
 * `pi:model-error` 的 payload。
 *
 * `raw` 保留 provider 原文（已脱敏、已截断）：归一化是**加**一层可操作提示，
 * 不是把证据藏起来 —— 排障时那句原文常常是唯一有用的东西。
 */
export const piModelErrorPayloadSchema = z.object({
  kind: modelErrorKindSchema,
  source: modelErrorSourceSchema,
  /** 归一化后的一句话（分不出类时退化为原文首行） */
  message: z.string(),
  /** provider 原文，已过 redactSecrets 并截断 */
  raw: z.string(),
  retryable: z.boolean(),
  /**
   * 距离下次可重试还有多久。
   *
   * 两个来源：我们自己直连 provider 时解析 `retry-after` 头；经 pi 时取
   * `auto_retry_start.delayMs`（pi 不透出响应头，这是它给出的唯一时间量）。
   */
  retryAfterMs: z.number().int().positive().optional(),
  /** provider 的结构化 code（若有），排障用 */
  code: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
});

export type PiModelErrorPayload = z.infer<typeof piModelErrorPayloadSchema>;
