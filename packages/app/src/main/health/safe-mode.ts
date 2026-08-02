/**
 * 安全模式（UPD-006）。
 *
 * ## 它是「自动回滚」的**替代方案**，不是回滚本身
 *
 * v1 不做真实的二进制自动回滚 —— 那需要在用户机器上保留上一版完整安装包
 * 并有一条经过验证的降级安装路径，而 Windows per-user NSIS + macOS ZIP +
 * Linux AppImage 三条路的降级语义各不相同，做半套比不做更危险。决定与理由
 * 见 docs/product/ADR-0001-update-feed.md。
 *
 * 替代方案是四件事：更新后健康检查 → 连续失败进安全模式 → 安全模式里给出
 * 诊断与上一稳定版本的下载入口 → 发布侧分阶段放量 + 快速撤回 feed。
 *
 * ## 失败计数必须能归零
 *
 * 一次成功启动把 consecutiveFailures 打回 0 并退出安全模式。不复位的话，
 * 用户第一次进了安全模式就**永远出不来**，而界面上没有任何按钮能改变这件事。
 */
import type { HealthCheckResult, SafeModeState } from "@pibuddy/contract";

import {
  readHealth,
  readLastKnownGood,
  writeHealth,
  type HealthRecord,
} from "./update-markers.js";

/** 连续多少次启动健康检查失败之后进安全模式。 */
export const SAFE_MODE_FAILURE_THRESHOLD = 2;

/**
 * 安全模式下被关掉的东西。
 *
 * 逐条列出来给用户看，不写「部分功能受限」这种话 —— 用户需要知道的是
 * 「我的自动任务今天没跑，是因为它被关了」，而不是一句含糊的免责声明。
 */
export const SAFE_MODE_DISABLED: string[] = [
  "第三方扩展与技能（pi extensions / skills）",
  "自动更新检查与后台下载",
  "启动时的自动会话恢复",
];

/**
 * 记录一次启动健康检查的结果，返回新的安全模式态。
 *
 * 这是**唯一**写 health.json 的地方；safeMode 由 consecutiveFailures 推导，
 * 不接受外部直接置位 —— 那会立刻产生「计数说没事、标志说有事」的分叉。
 */
export function recordHealthResult(
  dir: string,
  result: HealthCheckResult,
  now: () => number = () => Date.now()
): SafeModeState {
  const prev = readHealth(dir);
  const consecutiveFailures = result.ok ? 0 : prev.consecutiveFailures + 1;
  const record: HealthRecord = {
    consecutiveFailures,
    safeMode: consecutiveFailures >= SAFE_MODE_FAILURE_THRESHOLD,
    lastResult: result,
    updatedAt: now(),
  };
  writeHealth(dir, record);
  return toState(dir, record);
}

/** 当前安全模式态（只读，不改盘）。 */
export function safeModeState(dir: string): SafeModeState {
  return toState(dir, readHealth(dir));
}

/** 界面上的「退出安全模式」：把计数清零并落盘。 */
export function clearSafeMode(dir: string, now: () => number = () => Date.now()): SafeModeState {
  const prev = readHealth(dir);
  const record: HealthRecord = {
    consecutiveFailures: 0,
    safeMode: false,
    lastResult: prev.lastResult,
    updatedAt: now(),
  };
  writeHealth(dir, record);
  return toState(dir, record);
}

function toState(dir: string, record: HealthRecord): SafeModeState {
  return {
    active: record.safeMode,
    consecutiveFailures: record.consecutiveFailures,
    previousVersion: readLastKnownGood(dir)?.version ?? null,
    disabled: record.safeMode ? [...SAFE_MODE_DISABLED] : [],
  };
}

/**
 * 安全模式下某项能力是否应该被禁用。
 *
 * 调用点只有一处判断依据，而不是各处 `if (safeMode && ...)` 各写各的 ——
 * 后者的必然结果是某一处漏判，而漏判的表现正好是「安全模式下它还在跑」。
 */
export function isDisabledInSafeMode(state: SafeModeState): boolean {
  return state.active;
}
