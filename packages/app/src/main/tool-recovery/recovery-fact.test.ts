import { describe, expect, it } from "vitest";

import {
  TOOL_RECONCILE_RESULT_FACT_KIND,
  TOOL_RECOVERY_DECISION_FACT_KIND,
  TOOL_RECOVERY_FACT_VERSION,
  hasExactKeys,
  isToolReconcileResultFact,
  isToolRecoveryDecisionFact,
  isToolRecoveryFactEnvelope,
  parkReasonFor,
} from "./recovery-fact";

const DIGEST = `sha256:${"b".repeat(64)}`;

function reconcile(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocol: "tool_reconcile_v1",
    operationId: "toolop_1",
    observation: "matches_expected_state",
    observationSchema: "state_identity_v1",
    observationDigest: DIGEST,
    ...overrides,
  };
}

function completedDecision(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocol: "tool_recovery_v1",
    operationId: "toolop_1",
    disposition: "completed",
    reasonCode: "reconcile_matches_expected_state",
    outcomeEventId: "evt-outcome",
    evidenceEventIds: ["a", "b"],
    ...overrides,
  };
}

function parkedDecision(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocol: "tool_recovery_v1",
    operationId: "toolop_1",
    disposition: "parked",
    reasonCode: "reconcile_diverged",
    evidenceEventIds: ["a", "b"],
    ...overrides,
  };
}

describe("hasExactKeys —— 精确字段集", () => {
  it("多一个字段就拒（宽松校验会让 v2 记录被当成合法 v1 读）", () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys(null, [])).toBe(false);
    expect(hasExactKeys([], [])).toBe(false);
  });
});

describe("isToolReconcileResultFact", () => {
  it("规范形状通过", () => {
    expect(isToolReconcileResultFact(reconcile())).toBe(true);
  });

  it("四种观测都认，别的一律拒", () => {
    for (const observation of [
      "matches_expected_state",
      "matches_prior_state",
      "diverged",
      "unreadable",
    ]) {
      expect(isToolReconcileResultFact(reconcile({ observation }))).toBe(true);
    }
    expect(isToolReconcileResultFact(reconcile({ observation: "probably_ok" }))).toBe(false);
  });

  it("observationDigest 强校验：格式松了等于凭据可伪造", () => {
    expect(isToolReconcileResultFact(reconcile({ observationDigest: "sha256:zz" }))).toBe(false);
    expect(isToolReconcileResultFact(reconcile({ observationDigest: "b".repeat(64) }))).toBe(false);
    expect(
      isToolReconcileResultFact(reconcile({ observationDigest: `sha256:${"B".repeat(64)}` }))
    ).toBe(false);
  });

  it("多一个字段就拒", () => {
    expect(isToolReconcileResultFact(reconcile({ note: "x" }))).toBe(false);
  });

  it("少一个字段就拒", () => {
    const partial = reconcile() as Record<string, unknown>;
    delete partial.observationSchema;
    expect(isToolReconcileResultFact(partial)).toBe(false);
  });
});

describe("isToolRecoveryDecisionFact", () => {
  it("completed / parked 两种形状各自通过", () => {
    expect(isToolRecoveryDecisionFact(completedDecision())).toBe(true);
    expect(isToolRecoveryDecisionFact(parkedDecision())).toBe(true);
  });

  it("completed 缺 outcomeEventId 就拒（没有结果凭据不能宣布成功）", () => {
    const partial = completedDecision() as Record<string, unknown>;
    delete partial.outcomeEventId;
    expect(isToolRecoveryDecisionFact(partial)).toBe(false);
  });

  it("parked 带 outcomeEventId 就拒（字段集必须精确）", () => {
    expect(isToolRecoveryDecisionFact(parkedDecision({ outcomeEventId: "x" }))).toBe(false);
  });

  it("evidenceEventIds 必须非空且去重", () => {
    expect(isToolRecoveryDecisionFact(parkedDecision({ evidenceEventIds: [] }))).toBe(false);
    expect(isToolRecoveryDecisionFact(parkedDecision({ evidenceEventIds: ["a", "a"] }))).toBe(false);
  });

  it("park 原因只认三种", () => {
    expect(isToolRecoveryDecisionFact(parkedDecision({ reasonCode: "just_because" }))).toBe(false);
  });

  it("completed 的 reasonCode 只认一种", () => {
    expect(isToolRecoveryDecisionFact(completedDecision({ reasonCode: "reconcile_diverged" }))).toBe(
      false
    );
  });
});

describe("isToolRecoveryFactEnvelope", () => {
  it("版本恒 1；未知版本直接拒，不做尽力解析", () => {
    expect(
      isToolRecoveryFactEnvelope({
        kind: TOOL_RECONCILE_RESULT_FACT_KIND,
        version: TOOL_RECOVERY_FACT_VERSION,
        payload: reconcile(),
      })
    ).toBe(true);
    expect(
      isToolRecoveryFactEnvelope({
        kind: TOOL_RECONCILE_RESULT_FACT_KIND,
        version: 2,
        payload: reconcile(),
      })
    ).toBe(false);
  });

  it("kind 不认识就拒", () => {
    expect(
      isToolRecoveryFactEnvelope({
        kind: "pibuddy.tool.something_else",
        version: 1,
        payload: reconcile(),
      })
    ).toBe(false);
  });

  it("信封本身也是精确字段集", () => {
    expect(
      isToolRecoveryFactEnvelope({
        kind: TOOL_RECOVERY_DECISION_FACT_KIND,
        version: 1,
        payload: parkedDecision(),
        extra: 1,
      })
    ).toBe(false);
  });

  it("kind 与 payload 必须配套（decision 信封里塞 reconcile 载荷要拒）", () => {
    expect(
      isToolRecoveryFactEnvelope({
        kind: TOOL_RECOVERY_DECISION_FACT_KIND,
        version: 1,
        payload: reconcile(),
      })
    ).toBe(false);
  });
});

describe("parkReasonFor", () => {
  it("观测到 park 原因是一一映射", () => {
    expect(parkReasonFor("matches_prior_state")).toBe("reconcile_matches_prior_state");
    expect(parkReasonFor("diverged")).toBe("reconcile_diverged");
    expect(parkReasonFor("unreadable")).toBe("reconcile_unreadable");
  });
});
