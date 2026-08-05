/**
 * 账本事件的构造器。**仅供测试与崩溃对拍子进程使用**，生产代码不引用它。
 *
 * 放在生产目录而不是 test 目录，是因为真崩溃对拍的子进程要用裸 node 直接跑
 * 这些构造器 + recovery-store（见 crash-child.ts）。让子进程去 import 一个
 * test-only 目录只会让「哪些文件参与打包」这件事更难说清。
 *
 * 这里刻意不做任何校验：构造出**不合法**的账本正是分类算法测试要的东西。
 */
import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  TOOL_DISPATCH_PROTOCOL_V1,
  buildToolOperationId,
  canonicalToolArgsHash,
  toolCallEventId,
  toolDispatchEventId,
  toolResponseEventId,
  type ToolRecoveryMode,
} from "./operation-id";
import {
  TOOL_RECONCILE_RESULT_FACT_KIND,
  TOOL_RECOVERY_DECISION_FACT_KIND,
  TOOL_RECOVERY_FACT_VERSION,
  parkReasonFor,
  type ToolReconcileObservation,
} from "./recovery-fact";
import type { ToolLedgerEvent } from "./ledger-scanner";
import type { ToolPreparedCommit, ToolOutcomeCommit } from "./commit-sink";
import type { ToolRecoveryBundleCommit } from "./recovery-store";

export interface ToolFixtureInput {
  workspaceId?: string;
  sessionId?: string;
  invocationId?: string;
  runId?: string;
  turnId?: string;
  providerToolCallId?: string;
  toolName?: string;
  args?: unknown;
  recoveryMode?: ToolRecoveryMode;
  /** 首位事件是否带工具边界协议标记。 */
  withProtocolMarker?: boolean;
}

export interface ToolFixture {
  workspaceId: string;
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  operationId: string;
  callEvent: ToolLedgerEvent;
  dispatchEvent: ToolLedgerEvent;
  responseEvent(isError?: boolean): ToolLedgerEvent;
  reconcileEvent(observation: ToolReconcileObservation, ts?: number): ToolLedgerEvent;
  decisionEvent(observation: ToolReconcileObservation, ts?: number): ToolLedgerEvent;
  preparedCommit(): ToolPreparedCommit;
  outcomeCommit(isError?: boolean): ToolOutcomeCommit;
  bundleCommit(observation: ToolReconcileObservation): ToolRecoveryBundleCommit;
}

const DIGEST = `sha256:${"a".repeat(64)}` as const;

export function toolFixture(input: ToolFixtureInput = {}): ToolFixture {
  const workspaceId = input.workspaceId ?? "ws-1";
  const sessionId = input.sessionId ?? "session-1";
  const invocationId = input.invocationId ?? "invocation-1";
  const runId = input.runId ?? "run-1";
  const turnId = input.turnId ?? "turn-1";
  const providerToolCallId = input.providerToolCallId ?? "provider-call-1";
  const toolName = input.toolName ?? "home.light.set";
  const args = input.args ?? { deviceId: "light-1", on: true };
  const recoveryMode = input.recoveryMode ?? "reconcile";
  const canonicalArgsHashValue = canonicalToolArgsHash(toolName, args);
  const operationId = buildToolOperationId({ invocationId, providerToolCallId });

  const spine = { workspaceId, sessionId, invocationId, runId, turnId };

  const callEvent: ToolLedgerEvent = {
    id: toolCallEventId(operationId),
    ...spine,
    ts: 1,
    ...(input.withProtocolMarker ? { protocol: { toolBoundary: TOOL_BOUNDARY_PROTOCOL_V1 } } : {}),
    call: { toolCallId: providerToolCallId, toolName, args },
  };

  const dispatchEvent: ToolLedgerEvent = {
    id: toolDispatchEventId(operationId),
    ...spine,
    ts: 2,
    dispatch: {
      protocol: TOOL_DISPATCH_PROTOCOL_V1,
      operationId,
      providerToolCallId,
      toolName,
      canonicalArgsHash: canonicalArgsHashValue,
      recoveryMode,
    },
    refs: { operationId, toolCallId: providerToolCallId },
  };

  const responseEvent = (isError = false): ToolLedgerEvent => ({
    id: toolResponseEventId(operationId),
    ...spine,
    ts: 3,
    response: { toolCallId: providerToolCallId, toolName, isError },
    refs: { operationId, toolCallId: providerToolCallId },
  });

  const reconcileEvent = (observation: ToolReconcileObservation, ts = 4): ToolLedgerEvent => ({
    id: `${operationId}_reconcile`,
    ...spine,
    ts,
    recovery: {
      kind: TOOL_RECONCILE_RESULT_FACT_KIND,
      version: TOOL_RECOVERY_FACT_VERSION,
      payload: {
        protocol: "tool_reconcile_v1",
        operationId,
        observation,
        observationSchema: "state_identity_v1",
        observationDigest: DIGEST,
      },
    },
    refs: { operationId, toolCallId: providerToolCallId },
  });

  const decisionEvent = (observation: ToolReconcileObservation, ts = 6): ToolLedgerEvent => {
    const evidence = [callEvent.id, dispatchEvent.id, `${operationId}_reconcile`];
    if (observation === "matches_expected_state") {
      evidence.push(toolResponseEventId(operationId));
      return {
        id: `${operationId}_decision`,
        ...spine,
        ts,
        recovery: {
          kind: TOOL_RECOVERY_DECISION_FACT_KIND,
          version: TOOL_RECOVERY_FACT_VERSION,
          payload: {
            protocol: "tool_recovery_v1",
            operationId,
            disposition: "completed",
            reasonCode: "reconcile_matches_expected_state",
            outcomeEventId: toolResponseEventId(operationId),
            evidenceEventIds: evidence,
          },
        },
        refs: { operationId, toolCallId: providerToolCallId },
      };
    }
    return {
      id: `${operationId}_decision`,
      ...spine,
      ts,
      recovery: {
        kind: TOOL_RECOVERY_DECISION_FACT_KIND,
        version: TOOL_RECOVERY_FACT_VERSION,
        payload: {
          protocol: "tool_recovery_v1",
          operationId,
          disposition: "parked",
          reasonCode: parkReasonFor(observation),
          evidenceEventIds: evidence,
        },
      },
      refs: { operationId, toolCallId: providerToolCallId },
    };
  };

  return {
    workspaceId,
    sessionId,
    invocationId,
    runId,
    turnId,
    providerToolCallId,
    toolName,
    canonicalArgsHash: canonicalArgsHashValue,
    operationId,
    callEvent,
    dispatchEvent,
    responseEvent,
    reconcileEvent,
    decisionEvent,
    preparedCommit: () => ({
      workspaceId,
      operationId,
      callEvent,
      dispatchEvent,
      providerToolCallId,
      toolName,
      canonicalArgsHash: canonicalArgsHashValue,
      recoveryMode,
      committedAt: 10,
    }),
    outcomeCommit: (isError = false) => ({
      workspaceId,
      operationId,
      outcomeEvent: responseEvent(isError),
      committedAt: 20,
    }),
    bundleCommit: (observation: ToolReconcileObservation) => ({
      workspaceId,
      operationId,
      reconcileEvent: reconcileEvent(observation),
      ...(observation === "matches_expected_state" ? { outcomeEvent: responseEvent() } : {}),
      decisionEvent: decisionEvent(observation),
    }),
  };
}
