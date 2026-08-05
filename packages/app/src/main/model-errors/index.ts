/**
 * `model-errors` —— provider 错误归一化与重试策略（MDL-101）。
 *
 * 纯函数域：**不 import electron**，因此整域可以脱离 Electron 被单测驱动，
 * 也可以被对拍（拆掉否决表 / 拆掉「已有可见输出」前置条件，看哪些用例变红）。
 *
 * 四个文件各占一层，互不重复：
 *   - `provider-error-classification.ts` 证据归一 + 两张正则表 + 分类
 *   - `model-failure.ts`                 分类结果 → ModelFailure（含反向映射）
 *   - `retry-policy.ts`                  退避曲线 + 四条重试前置条件
 *   - `pi-error-report.ts`               pi 事件面 → 可上 IPC 的 payload
 */
export {
  classifyError,
  errorPresentationFromClass,
  isAuthenticationErrorText,
  isContextOverflowErrorText,
  providerRetryMetadata,
  type ProviderRetryMetadata,
} from "./provider-error-classification.js";

export {
  errorClassFromFailureKind,
  modelFailureKind,
  normalizeModelFailure,
  type ModelFailure,
} from "./model-failure.js";

export {
  MAX_PROVIDER_ATTEMPTS_PER_STEP,
  providerRetryDelayMs,
  shouldRetryProviderFailure,
  type ProviderRetryDecisionInput,
} from "./retry-policy.js";

export { modelErrorFromAgentEvent, modelErrorFromExit } from "./pi-error-report.js";
