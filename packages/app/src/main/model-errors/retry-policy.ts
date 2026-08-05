/**
 * provider 重试策略（MDL-101）。
 *
 * 移植自 `source/maka-agent/packages/runtime/src/ai-sdk-backend.ts:637-649`
 * （退避）与 `:1805-1845`（重试循环的前置条件）。
 *
 * ## 谁在重试
 *
 * PiBuddy 是 pi 的宿主，**模型请求的重试循环归 pi 所有**（它的
 * `retryProviderRequest` 会读 retry-after-ms / retry-after，做 0.5·2^i 上限
 * 8s 的退避，并向我们 emit `auto_retry_start` / `auto_retry_end`）。因此
 * 本文件**不驱动任何模型请求**，它是这套策略的**判据实现**：
 *
 *   - 我们自己直连 provider 的路径（连通性探测、未来的直连调用）用它；
 *   - 它同时是「pi 那一层做的是不是同一件事」的可执行参照 —— 两边的判据
 *     写在同一处措辞下，差异才谈得上被发现。
 *
 * 全部是纯函数，随机源可注入，因此可以对拍。
 */
import type { ModelFailure } from "./model-failure.js";

/** 单步内允许的最大尝试次数（含首次）。 */
export const MAX_PROVIDER_ATTEMPTS_PER_STEP = 10;

const PROVIDER_RETRY_BASE_DELAY_MS = 1_000;
const PROVIDER_RETRY_MAX_DELAY_MS = 32_000;
const PROVIDER_RETRY_JITTER_FACTOR = 0.25;

/**
 * 指数退避 + 抖动。**服务端的 retry-after 优先于本地退避** —— 服务端说了
 * 具体等多久，本地再算一个数就是在跟它抢方向盘。
 *
 * `random` 可注入：抖动是这个函数唯一的不确定性，把它做成参数之后整个退避
 * 曲线可被逐点断言，而不是只能断言一个区间。
 */
export function providerRetryDelayMs(
  failedAttempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random
): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = Math.min(
    PROVIDER_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempt - 1),
    PROVIDER_RETRY_MAX_DELAY_MS
  );
  return Math.ceil(base + random() * PROVIDER_RETRY_JITTER_FACTOR * base);
}

/**
 * 一次重试判定的全部输入。
 *
 * `hasObservableOutput` 是这四条里最容易被漏掉、也最要命的一条：请求已经
 * 往界面上吐过字之后再重试，用户看到的是**同一段话被说了两遍**。它必须与
 * 「可重试」「次数没用完」「预算没花完」并列，而不是某个分支里的补丁。
 */
export interface ProviderRetryDecisionInput {
  failure: ModelFailure;
  /** 已经失败的尝试序号，从 1 起（第 1 次请求失败后判是否要有第 2 次） */
  attempt: number;
  /** 本步的 token / 时间预算是否还有剩余 */
  budgetRemains: boolean;
  /** 本次尝试是否已经产生了用户可见的输出 */
  hasObservableOutput: boolean;
  maxAttempts?: number;
}

/**
 * 三条前置条件缺一不可：
 *
 *   `retryable && attempt < MAX && 预算未尽 && 本次尝试尚未产生可见输出`
 *
 * 四个合取项没有优先级之分，任何一个为假都不重试。写成短路的 if 嵌套也
 * 等价，但那种写法会让「少了一条」在阅读时看不出来。
 */
export function shouldRetryProviderFailure(input: ProviderRetryDecisionInput): boolean {
  const maxAttempts = input.maxAttempts ?? MAX_PROVIDER_ATTEMPTS_PER_STEP;
  return (
    input.failure.retryable &&
    input.attempt < maxAttempts &&
    input.budgetRemains &&
    !input.hasObservableOutput
  );
}
