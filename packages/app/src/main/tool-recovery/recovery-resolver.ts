/**
 * 崩溃恢复的分类算法：账本 → 每条 operation 的处置结论。
 *
 * ## 它要解决的真实问题
 *
 * `tasks/scheduler.ts` 现在的做法是：lease 过期的孤儿 run **一律判死**，注释
 * 写着「未自动重跑，避免重复副作用」。这是保守的一端 —— 确实压根没跑的 run
 * 也被误杀，用户得手动重试。
 *
 * T1/T2 夹逼让我们能把「不知道」拆成两半：
 *
 *   - 有 call、有 dispatch、无 response → `indeterminate`。工具**可能**已经
 *     产生了副作用。park 住，不猜。
 *   - 有 call、无 dispatch          → `definitely_not_dispatched`。dispatch
 *     事实严格早于 impl，它不在就意味着 impl 一定没被调用过。可以安全自动重跑。
 *
 * ## 三态协议判据（本文件的核心，改它等于改安全性）
 *
 * 上面第二条只在**新协议**账本上成立。老账本压根没写过 dispatch 事实，
 * 「无 dispatch」在那里不携带任何信息 —— 它既可能没跑，也可能跑完了但当时
 * 的代码根本不记这个。所以：
 *
 * | 协议标记          | 无 dispatch 的结论            |
 * |-------------------|-------------------------------|
 * | `valid`（首位、版本认识） | `definitely_not_dispatched` |
 * | `absent`（legacy）        | `indeterminate`（保守）     |
 * | `invalid`（版本不认识 / 非首位） | 整份账本判损坏      |
 *
 * **禁止把老数据「升级」成新协议来证明工具没执行。** 这是本文件唯一一条不能
 * 被优化掉的规则：任何「标记坏了就当 legacy 凑合用」「补一个标记再读」的改动
 * 都会让一次已经产生过副作用的调用被判成「没跑」，然后被自动重跑一遍。
 *
 * 标记 invalid 时**所有** decision 一并降为 `corruption`：一份自己都无法解释
 * 边界在哪的账本，不该对任何单条 operation 给出可执行结论。
 *
 * ## corruption 判据用固定优先级顺序
 *
 * 同一条 operation 可能同时命中多个 issue。诊断必须确定性 —— 同样的账本每次
 * 都报同一个原因，否则现场之间没法对照。所以用有序数组遍历，**不用 Set 迭代
 * 或 issues[0]**（前者顺序取决于插入历史，后者取决于扫描顺序）。
 */
import {
  scanToolLedger,
  type ToolLedgerEvent,
  type ToolLedgerIssueCode,
  type ToolLedgerProtocolMarker,
  type ToolLedgerScanOperation,
} from "./ledger-scanner";

export type ToolRecoveryDecisionStatus =
  | "completed"
  | "parked"
  | "definitely_not_dispatched"
  | "indeterminate"
  | "corruption";

export type ToolRecoveryDecisionReason =
  | "matching_response"
  | "recovery_bundle_completed"
  | "dispatch_without_response"
  | "new_protocol_before_dispatch"
  | "legacy_dispatch_unknown"
  | "protocol_marker_invalid"
  | "orphan_dispatch"
  | "orphan_response"
  | "duplicate_call"
  | "duplicate_operation"
  | "duplicate_dispatch"
  | "duplicate_response"
  | "canonical_args_hash_conflict"
  | "identity_conflict"
  | "invocation_identity_conflict"
  | "event_order_conflict"
  | "recovery_fact_corruption"
  | "reconcile_matches_prior_state"
  | "reconcile_diverged"
  | "reconcile_unreadable";

/** 结算来源：正常 T2、pre-T1 的合成结算、恢复包裁决。 */
export type ToolSettlementOrigin = "normal_t2" | "pre_t1_synthetic" | "recovery_bundle";

export interface ToolRecoveryDecision {
  invocationId: string;
  toolCallId: string;
  toolName?: string;
  operationId?: string;
  status: ToolRecoveryDecisionStatus;
  reason: ToolRecoveryDecisionReason;
  settlementOrigin?: ToolSettlementOrigin;
  callEventId?: string;
  dispatchEventId?: string;
  responseEventId?: string;
  responseIsError?: boolean;
}

export interface ToolRecoveryResolution {
  protocolMarker: ToolLedgerProtocolMarker;
  decisions: ToolRecoveryDecision[];
  issues: Array<{ code: ToolLedgerIssueCode; eventId: string }>;
  hasCorruption: boolean;
  /** 有 indeterminate 且账本本身干净时才为真：这些 operation 需要去读回真实世界。 */
  requiresReconciliation: boolean;
  /** 可以安全自动重跑的 operation（`definitely_not_dispatched`）。 */
  safeToRetry: ToolRecoveryDecision[];
}

export function resolveToolRecovery(events: readonly ToolLedgerEvent[]): ToolRecoveryResolution {
  const scan = scanToolLedger(events);
  const issues = scan.issues.map(({ code, eventId }) => ({ code, eventId }));
  const markerInvalid = scan.protocolMarker.status === "invalid";

  const decisions = scan.operations.map((operation) =>
    markerInvalid
      ? protocolCorruptionDecision(operation)
      : decisionFromOperation(operation, scan.protocolMarker.status === "valid")
  );

  const hasCorruption =
    issues.length > 0 || decisions.some((decision) => decision.status === "corruption");
  return {
    protocolMarker: scan.protocolMarker,
    decisions,
    issues,
    hasCorruption,
    requiresReconciliation:
      !hasCorruption && decisions.some((decision) => decision.status === "indeterminate"),
    safeToRetry: hasCorruption
      ? []
      : decisions.filter((decision) => decision.status === "definitely_not_dispatched"),
  };
}

function baseDecision(operation: ToolLedgerScanOperation): ToolRecoveryDecision {
  return {
    invocationId: operation.invocationId,
    toolCallId: operation.toolCallId,
    ...(operation.toolName ? { toolName: operation.toolName } : {}),
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
    status: "indeterminate",
    reason: "legacy_dispatch_unknown",
    ...(operation.callEvent ? { callEventId: operation.callEvent.id } : {}),
    ...(operation.dispatchEvent ? { dispatchEventId: operation.dispatchEvent.id } : {}),
    ...(operation.responseEvent
      ? {
          responseEventId: operation.responseEvent.id,
          responseIsError: operation.responseEvent.response?.isError === true,
        }
      : {}),
  };
}

function protocolCorruptionDecision(operation: ToolLedgerScanOperation): ToolRecoveryDecision {
  const decision = baseDecision(operation);
  decision.status = "corruption";
  decision.reason = "protocol_marker_invalid";
  return decision;
}

function decisionFromOperation(
  operation: ToolLedgerScanOperation,
  newProtocol: boolean
): ToolRecoveryDecision {
  const decision = baseDecision(operation);
  // 缺口的默认解释：新协议下「没派发」，legacy 下「不知道」。
  decision.status = newProtocol ? "definitely_not_dispatched" : "indeterminate";
  decision.reason = newProtocol ? "new_protocol_before_dispatch" : "legacy_dispatch_unknown";

  const corruption = operationCorruptionReason(operation);
  if (corruption) {
    decision.status = "corruption";
    decision.reason = corruption;
    return decision;
  }

  if (operation.responseEvent) {
    decision.status = "completed";
    decision.reason = "matching_response";
    // 无 dispatch 却有 response = pre-T1 的老数据。它已经结算了，只是不是
    // 经由 T1/T2 结算的 —— 记下来源，别让后面的人误以为它有 dispatch 凭据。
    decision.settlementOrigin = operation.dispatchEvent ? "normal_t2" : "pre_t1_synthetic";
  } else if (operation.dispatchEvent) {
    // 有派发、无结果：副作用可能已经发生。这里必须是 indeterminate，
    // 不管协议是新是旧。
    decision.status = "indeterminate";
    decision.reason = "dispatch_without_response";
  }

  if (operation.reconcileEvents.length === 0 && operation.decisionEvents.length === 0) {
    return decision;
  }
  return applyRecoveryBundle(operation, decision);
}

/**
 * 恢复包的解释：必须恰好一条 reconcile + 一条 decision，且两者互相印证。
 *
 * 不满足就判 `recovery_fact_corruption` —— 半截的恢复包比没有更危险，它看起来
 * 像是「已经处理过了」。
 */
function applyRecoveryBundle(
  operation: ToolLedgerScanOperation,
  decision: ToolRecoveryDecision
): ToolRecoveryDecision {
  const reconcileEvent = operation.reconcileEvents[0];
  const decisionEvent = operation.decisionEvents[0];
  const reconcile = reconcileEvent?.recovery;
  const terminal = decisionEvent?.recovery;
  const corrupt = (): ToolRecoveryDecision => {
    decision.status = "corruption";
    decision.reason = "recovery_fact_corruption";
    delete decision.settlementOrigin;
    return decision;
  };

  if (
    operation.reconcileEvents.length !== 1 ||
    operation.decisionEvents.length !== 1 ||
    !operation.callEvent ||
    !operation.dispatchEvent ||
    !operation.operationId ||
    reconcile?.kind !== "pibuddy.tool.reconcile_result" ||
    terminal?.kind !== "pibuddy.tool.recovery_decision"
  ) {
    return corrupt();
  }

  const observation = reconcile.payload.observation;
  const payload = terminal.payload;
  const evidence = [operation.callEvent.id, operation.dispatchEvent.id, reconcileEvent!.id];

  if (payload.disposition === "completed") {
    // 判 completed 必须同时满足：观测到期望状态 + 真的有一条 outcome 落地 +
    // 裁决引用的就是那一条。任何一条不满足都不能宣布工具跑成功了。
    if (
      observation !== "matches_expected_state" ||
      !operation.responseEvent ||
      operation.responseEvent.response?.isError === true ||
      payload.outcomeEventId !== operation.responseEvent.id
    ) {
      return corrupt();
    }
    evidence.push(operation.responseEvent.id);
    if (!sameOrder(payload.evidenceEventIds, evidence)) return corrupt();
    decision.status = "completed";
    decision.reason = "recovery_bundle_completed";
    decision.settlementOrigin = "recovery_bundle";
    return decision;
  }

  if (observation === "matches_expected_state" || operation.responseEvent) return corrupt();
  const expectedReason =
    observation === "matches_prior_state"
      ? "reconcile_matches_prior_state"
      : observation === "diverged"
        ? "reconcile_diverged"
        : "reconcile_unreadable";
  if (payload.reasonCode !== expectedReason) return corrupt();
  if (!sameOrder(payload.evidenceEventIds, evidence)) return corrupt();
  decision.status = "parked";
  decision.reason = payload.reasonCode;
  decision.settlementOrigin = "recovery_bundle";
  return decision;
}

/**
 * 固定优先级的 corruption 判据。顺序即诊断确定性（见文件头）。
 *
 * 顺序本身也有意义：越靠前的越接近「身份层面就已经错了」，报它比报一个
 * 由它派生出来的次生 issue 更有指导性。
 */
const CORRUPTION_PRIORITY: ReadonlyArray<readonly [ToolLedgerIssueCode, ToolRecoveryDecisionReason]> =
  [
    ["orphan_dispatch", "orphan_dispatch"],
    ["orphan_response", "orphan_response"],
    ["duplicate_call", "duplicate_call"],
    ["duplicate_operation", "duplicate_operation"],
    ["duplicate_dispatch", "duplicate_dispatch"],
    ["duplicate_response", "duplicate_response"],
    ["canonical_args_hash_conflict", "canonical_args_hash_conflict"],
    ["invocation_identity_conflict", "invocation_identity_conflict"],
    ["identity_conflict", "identity_conflict"],
    ["event_order_conflict", "event_order_conflict"],
  ];

function operationCorruptionReason(
  operation: ToolLedgerScanOperation
): ToolRecoveryDecisionReason | undefined {
  for (const [code, reason] of CORRUPTION_PRIORITY) {
    if (operation.issues.some((issue) => issue.code === code)) return reason;
  }
  return undefined;
}

function sameOrder(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}
