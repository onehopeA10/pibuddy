/**
 * Provider / 模型中心与用量统计的契约（PROV-101）。
 *
 * ## 为什么这些形状必须住在契约包
 *
 * 「某个 provider 配没配密钥」这件事在四个地方被问到：主进程的 auth-store
 * 读 `~/.pi/agent/auth.json`、providers-ipc 组装返回值、preload 声明签名、
 * 渲染进程的 ProviderCenter 渲染。四处各写一份 interface，等于四份会各自
 * 漂移的定义 —— 而漂移的表现是「界面显示已配置、实际发请求 401」。
 *
 * ## 渲染进程能看到的极限
 *
 * `ProviderView` 里**没有** key 字段，将来也不会有。密钥的明文只在两个
 * 位置存在：用户输入框里那一瞬间，以及 `~/.pi/agent/auth.json` 里那一行。
 * 渲染进程能问到的极限是 `configured` 与 `last4`（与 SecretDescriptor
 * 同一口径）。
 */
import { z } from "zod";

/**
 * 凭据形态。
 *
 * `oauth` 是**如实降级**的那一档：Claude Pro/Max、Codex、Copilot 这类订阅
 * 登录是 pi 的交互式 TUI 流程，RPC 协议里没有对应命令，PiBuddy 本轮做不到
 * 端内登录。界面必须显示「需要在终端里完成 /login」的真实状态，而不是摆一个
 * 点了没反应的按钮 —— 后者是更坏的体验，因为用户会以为是自己操作错了。
 */
export const providerAuthKindSchema = z.enum(["api_key", "oauth", "none"]);
export type ProviderAuthKind = z.infer<typeof providerAuthKindSchema>;

/**
 * 模型的能力描述。
 *
 * **唯一来源是 pi 的 `get_available_models`**，不是任何硬编码名单：
 * 名单一旦写进代码，pi 侧新增的模型就会被静默判成「不支持图片」，
 * 而这种失败不报错、不记日志，只表现为「拖进去的图发不出去」。
 */
export const providerModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  provider: z.string().optional(),
  /** 支持的输入模态。含 `"image"` 才能收图片；缺席按「只支持文本」保守处理 */
  input: z.array(z.string()).optional(),
  contextWindow: z.number().optional(),
  reasoning: z.boolean().optional(),
  cost: z
    .object({ input: z.number(), output: z.number() })
    .partial()
    .optional(),
});
export type ProviderModel = z.infer<typeof providerModelSchema>;

/** 渲染进程可见的 provider。没有 key，只有「配没配 + 尾四位」。 */
export const providerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  authKind: providerAuthKindSchema,
  configured: z.boolean(),
  last4: z.string(),
  /** 来自 models.json 的自定义 OpenAI 兼容端点 */
  custom: z.boolean(),
  baseUrl: z.string().optional(),
  models: z.array(providerModelSchema),
  /**
   * 文件权限是否真的被收紧到 0600。
   *
   * Windows 上 `fs.chmod` 对 NTFS ACL 基本无效，此处恒为 false，界面据此
   * 显示「此平台无法限制文件权限」—— 假装已加固比不加固更糟。
   */
  permissionEnforced: z.boolean(),
});
export type ProviderView = z.infer<typeof providerViewSchema>;

export const providerListResultSchema = z.object({
  providers: z.array(providerViewSchema),
  /** auth.json 是否成功以 0600 落盘（平台能力，不是单个 provider 的属性） */
  permissionEnforced: z.boolean(),
});
export type ProviderListResult = z.infer<typeof providerListResultSchema>;

/** providers:save-key 的入参。value 为空串表示删除该条凭据。 */
export const providerSaveKeyRequestSchema = z.object({
  providerId: z.string().min(1),
  key: z.string(),
  /** provider 作用域的环境值（Cloudflare account id 之类），见 providers.md */
  env: z.record(z.string(), z.string()).optional(),
});
export type ProviderSaveKeyRequest = z.infer<typeof providerSaveKeyRequestSchema>;

export const providerIdRequestSchema = z.object({ providerId: z.string().min(1) });

/**
 * providers:add-custom 的入参：一个 OpenAI 兼容端点。
 *
 * `baseUrl` 在**落盘之前**过 endpoints.ts 的 registerEndpoint
 * （normalizeEndpointUrl + assertPublicAddress），被拒时一个字节都不写。
 */
export const providerCustomRequestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "provider id 只能用小写字母、数字与 . _ -"),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  models: z.array(z.string()).default([]),
});
export type ProviderCustomRequest = z.infer<typeof providerCustomRequestSchema>;

/**
 * providers:set-model-input 的入参：给自定义端点的一个模型标注输入模态。
 *
 * 为什么需要它：中转 / 自建端点的 `GET /models` 只回 id，pi 对缺省的
 * `input` 一律补成 `["text"]`，于是一个明明能看图的 grok / gpt 中转模型会被
 * 判成「不支持图片」。能力判据仍然只有 `Model.input`（不引入模型名单），
 * 这里只是给用户一个把真实能力**写进 input** 的入口。只允许自定义端点：
 * 内置 provider 的模型表归 pi 所有。
 */
export const modelInputModalitySchema = z.enum(["text", "image"]);
export type ModelInputModality = z.infer<typeof modelInputModalitySchema>;

export const providerModelInputRequestSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /** 该模型接受的输入：文 / 图 / 图文，至少一项 */
  input: z.array(modelInputModalitySchema).min(1),
});
export type ProviderModelInputRequest = z.infer<typeof providerModelInputRequestSchema>;

/**
 * 连通性测试的错误词汇。
 *
 * ## 为什么它等于 `ModelErrorKind`（去 abort）再加一个 `model`
 *
 * 收敛前这里只有四项（auth / network / model / unknown），于是 429、402、413
 * **全落 unknown** —— 而「被限流」「余额不够」「请求体超上限」的下一步动作彼此
 * 完全不同，一句「未知问题」等于什么都没说。连通性探测又恰好是全仓**唯一**
 * 手握显式 statusCode 与响应正文的调用点，判据在这里最该发挥。
 *
 * 因此词汇与 `MODEL_ERROR_KINDS` 同源：
 *   - 去掉 `abort` —— 一次自动的探测请求不存在「用户主动中止」这一档；
 *   - 补一个 `model` —— 探测路径特有：`GET {base}/models` 回 404 说明端点路径
 *     或模型名不对，它在通用的模型错误词汇里没有对应项。
 *
 * 同源不是为了整齐：渲染层因此可以**直接复用** `model-error-advice.ts` 的那张
 * 中文可操作提示表，而不必为 provider 测试再写第二套文案（两套文案的失败形态
 * 是同一个错误在两个界面上被说成两件事）。
 *
 * ## 旧值的含义没有变，只是变窄了
 *
 * `auth`（401/403）、`model`（404）、`unknown` 逐字照旧。`network` 从前兼管
 * 5xx，现在 5xx 归 `provider_unavailable` —— 这不是给 `network` 换意思，而是
 * 把「你这边连不上」和「服务商那边挂了」分开：前者的提示是「检查网络或地址」，
 * 对一个 503 来说是把用户引去做一件没用的事。
 */
export const PROVIDER_TEST_ERROR_CODES = [
  "auth",
  "network",
  "model",
  "unknown",
  "rate_limit",
  "provider_billing",
  "context_overflow",
  "provider_unavailable",
  "timeout",
] as const;

/**
 * 连通性测试结果。
 *
 * `redactedMessage` 是**已经过 logger-redact 的 redactSecrets**的文本：
 * 上游 401 的响应正文里经常原样回显你发过去的 Authorization 头。
 */
export const providerTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  errorCode: z.enum(PROVIDER_TEST_ERROR_CODES).optional(),
  redactedMessage: z.string().optional(),
});
export type ProviderTestResult = z.infer<typeof providerTestResultSchema>;

// ------------------------------------------------------------ 模型作用域

/**
 * 模型默认值的作用域。
 *
 * 三层各有各的用处，合成一层就一定会出错：
 *   - `global`    没有别的信息时用哪个模型
 *   - `workspace` 这个项目习惯用哪个模型（写代码用 A、写文档用 B）
 *   - `session`   这条会话**当时**用的是哪个模型（记在会话文件里）
 *
 * 打开一条历史会话时，session 层永远赢 —— 拿全局默认去覆盖它，等于用户
 * 每打开一次旧对话就被悄悄换一次模型，而且没有任何提示。
 */
export const modelScopeSchema = z.enum(["global", "workspace", "session"]);
export type ModelScope = z.infer<typeof modelScopeSchema>;

export const modelRefSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

export const setScopeDefaultRequestSchema = z.object({
  scope: z.enum(["global", "workspace"]),
  /** scope === "workspace" 时必填；渲染进程只持有不透明 id */
  workspaceId: z.string().optional(),
  provider: z.string().min(1),
  modelId: z.string().min(1),
});
export type SetScopeDefaultRequest = z.infer<typeof setScopeDefaultRequestSchema>;

// ------------------------------------------------------------------ 用量

/** 用量查询条件。`day` 一律是本地时区的 `YYYY-MM-DD`。 */
export const usageQuerySchema = z.object({
  fromDay: z.string().optional(),
  toDay: z.string().optional(),
  workspaceId: z.string().optional(),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

export const usageRowSchema = z.object({
  day: z.string(),
  workspace: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  contextTokens: z.number(),
  failures: z.number(),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

/**
 * 按会话明细的一行（REQ-0001 R5.2）。
 *
 * 粒度是 (sessionId, day)：跨日的长会话按天各成一行，每行只记当天新增的
 * 增量 —— 与 usage_daily 同一套差值口径，双源（前台渲染进程 / 池后台）
 * 重复上报同一份累计快照时增量为 0，不会重复计数。
 */
export const usageSessionRowSchema = z.object({
  sessionId: z.string(),
  day: z.string(),
  workspace: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.number(),
  failures: z.number(),
});
export type UsageSessionRow = z.infer<typeof usageSessionRowSchema>;

export const usageExportRequestSchema = usageQuerySchema.extend({
  format: z.enum(["csv", "json"]),
});
export type UsageExportRequest = z.infer<typeof usageExportRequestSchema>;

export const usageExportResultSchema = z.object({
  filename: z.string(),
  content: z.string(),
});
export type UsageExportResult = z.infer<typeof usageExportResultSchema>;

/**
 * usage:record 的入参：一次 agent_settled 之后的会话累计快照。
 *
 * 主进程按 (sessionId) 记 last_seen_total 做差值。**pi 侧在压缩之后会重置
 * 统计**，此时本次 total 会小于上一次 —— 那种情况下增量必须归零而不是写
 * 一个负数进表（负数会让「这个月花了多少钱」显示成一个比上周还小的数）。
 */
export const usageRecordRequestSchema = z.object({
  sessionId: z.string().min(1),
  workspaceId: z.string().optional(),
  provider: z.string(),
  modelId: z.string(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  contextTokens: z.number().nonnegative().optional(),
  failed: z.boolean().optional(),
});
export type UsageRecordRequest = z.infer<typeof usageRecordRequestSchema>;
