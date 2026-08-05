/**
 * 恢复事实的 schema（reconcile 观测 / recovery 终局裁决两种 envelope）。
 *
 * ## 为什么是「事实」而不是「状态」
 *
 * 崩溃恢复不能靠读一个可变的 `status` 列。状态列会被后来的写覆盖，事后无法
 * 复盘「当时凭什么这么判」。这里落地的是两条**不可变事实**：
 *
 *   1. `reconcile_result`：去真实世界读回状态，观测到了什么（四选一）。
 *   2. `recovery_decision`：基于那次观测做出的终局裁决（completed / parked）。
 *
 * 两条分开、且 decision 必须引用它依据的 reconcile 事件 id —— 这样任何时候
 * 都能拿着账本重放出同一个结论，而不是相信某个人当时写下的 status。
 *
 * ## 校验为什么用「精确字段集」而不是「至少有这些字段」
 *
 * `hasExactKeys` 要求键集合完全相等：多一个字段也拒。宽松校验（只查必需字段
 * 存在）的失败模式是致命的 —— 一条 v2 写入的、多带了字段的记录会被 v1 读者
 * 认成合法 v1 事实，然后按 v1 语义解释它。少读一个字段可能正好是「这次其实
 * 没成功」的那个字段。协议演进必须靠 version 显式切换，不能靠字段容忍度。
 *
 * `observationDigest` 强校验 `sha256:` + 64 位小写十六进制：摘要是「我确实读
 * 回了状态」的凭据，格式松了就等于凭据可以伪造成任意字符串。
 */
import { isSha256Digest } from "./operation-id";

export const TOOL_RECONCILE_RESULT_FACT_KIND = "pibuddy.tool.reconcile_result" as const;
export const TOOL_RECOVERY_DECISION_FACT_KIND = "pibuddy.tool.recovery_decision" as const;

/** 恢复事实版本恒 1。改字段集必须 +1，禁止原地扩字段。 */
export const TOOL_RECOVERY_FACT_VERSION = 1 as const;

/** 读回真实世界之后的四种观测。除第一种外都不足以判「工具跑成功了」。 */
export type ToolReconcileObservation =
  | "matches_expected_state"
  | "matches_prior_state"
  | "diverged"
  | "unreadable";

export interface ToolReconcileResultFact {
  protocol: "tool_reconcile_v1";
  operationId: string;
  observation: ToolReconcileObservation;
  observationSchema: "state_identity_v1";
  observationDigest: `sha256:${string}`;
}

export type ToolRecoveryParkReason =
  | "reconcile_matches_prior_state"
  | "reconcile_diverged"
  | "reconcile_unreadable";

export interface ToolRecoveryCompletedDecisionFact {
  protocol: "tool_recovery_v1";
  operationId: string;
  disposition: "completed";
  reasonCode: "reconcile_matches_expected_state";
  outcomeEventId: string;
  evidenceEventIds: string[];
}

export interface ToolRecoveryParkedDecisionFact {
  protocol: "tool_recovery_v1";
  operationId: string;
  disposition: "parked";
  reasonCode: ToolRecoveryParkReason;
  evidenceEventIds: string[];
}

export type ToolRecoveryDecisionFact =
  | ToolRecoveryCompletedDecisionFact
  | ToolRecoveryParkedDecisionFact;

export type ToolRecoveryFactEnvelope =
  | {
      kind: typeof TOOL_RECONCILE_RESULT_FACT_KIND;
      version: typeof TOOL_RECOVERY_FACT_VERSION;
      payload: ToolReconcileResultFact;
    }
  | {
      kind: typeof TOOL_RECOVERY_DECISION_FACT_KIND;
      version: typeof TOOL_RECOVERY_FACT_VERSION;
      payload: ToolRecoveryDecisionFact;
    };

const OBSERVATIONS: readonly ToolReconcileObservation[] = [
  "matches_expected_state",
  "matches_prior_state",
  "diverged",
  "unreadable",
];

const PARK_REASONS: readonly ToolRecoveryParkReason[] = [
  "reconcile_matches_prior_state",
  "reconcile_diverged",
  "reconcile_unreadable",
];

export function isToolRecoveryFactEnvelope(value: unknown): value is ToolRecoveryFactEnvelope {
  if (!hasExactKeys(value, ["kind", "version", "payload"])) return false;
  // 版本不认识 → 直接拒。绝不「尽力解析」：把未知版本当 v1 读，正是把
  // 无法证明的东西证明成了「工具没执行」。
  if (value.version !== TOOL_RECOVERY_FACT_VERSION) return false;
  if (value.kind === TOOL_RECONCILE_RESULT_FACT_KIND) return isToolReconcileResultFact(value.payload);
  if (value.kind === TOOL_RECOVERY_DECISION_FACT_KIND) return isToolRecoveryDecisionFact(value.payload);
  return false;
}

export function isToolReconcileResultFact(value: unknown): value is ToolReconcileResultFact {
  if (
    !hasExactKeys(value, [
      "protocol",
      "operationId",
      "observation",
      "observationSchema",
      "observationDigest",
    ])
  ) {
    return false;
  }
  return (
    value.protocol === "tool_reconcile_v1" &&
    isNonEmptyString(value.operationId) &&
    value.observationSchema === "state_identity_v1" &&
    isSha256Digest(value.observationDigest) &&
    OBSERVATIONS.includes(value.observation as ToolReconcileObservation)
  );
}

export function isToolRecoveryDecisionFact(value: unknown): value is ToolRecoveryDecisionFact {
  if (!isRecord(value)) return false;
  if (
    value.protocol !== "tool_recovery_v1" ||
    !isNonEmptyString(value.operationId) ||
    !isDistinctNonEmptyStringArray(value.evidenceEventIds)
  ) {
    return false;
  }
  if (value.disposition === "completed") {
    return (
      hasExactKeys(value, [
        "protocol",
        "operationId",
        "disposition",
        "reasonCode",
        "outcomeEventId",
        "evidenceEventIds",
      ]) &&
      value.reasonCode === "reconcile_matches_expected_state" &&
      isNonEmptyString(value.outcomeEventId)
    );
  }
  return (
    value.disposition === "parked" &&
    hasExactKeys(value, [
      "protocol",
      "operationId",
      "disposition",
      "reasonCode",
      "evidenceEventIds",
    ]) &&
    PARK_REASONS.includes(value.reasonCode as ToolRecoveryParkReason)
  );
}

/** 观测 → 唯一允许的 park 原因。多对一或一对多都会让裁决无法复盘。 */
export function parkReasonFor(
  observation: Exclude<ToolReconcileObservation, "matches_expected_state">
): ToolRecoveryParkReason {
  switch (observation) {
    case "matches_prior_state":
      return "reconcile_matches_prior_state";
    case "diverged":
      return "reconcile_diverged";
    case "unreadable":
      return "reconcile_unreadable";
  }
}

/** 键集合**完全相等**才通过。多一个少一个都拒（见文件头说理）。 */
export function hasExactKeys(
  value: unknown,
  required: readonly string[]
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDistinctNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}
