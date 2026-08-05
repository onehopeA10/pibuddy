import { describe, expect, it } from "vitest";

import { toolFixture } from "./ledger-fixtures";
import {
  scanToolLedger,
  toolCallIdentity,
  validateToolLedgerEventLane,
  validateToolLedgerTransition,
  type ToolLedgerEvent,
} from "./ledger-scanner";

describe("lane 语义", () => {
  it("四个 lane 各自被正确识别", () => {
    const fixture = toolFixture();
    expect(validateToolLedgerEventLane(fixture.callEvent)).toEqual({
      ok: true,
      lane: "function_call",
    });
    expect(validateToolLedgerEventLane(fixture.dispatchEvent)).toEqual({
      ok: true,
      lane: "tool_dispatch",
    });
    expect(validateToolLedgerEventLane(fixture.responseEvent())).toEqual({
      ok: true,
      lane: "function_response",
    });
    expect(validateToolLedgerEventLane(fixture.reconcileEvent("diverged"))).toEqual({
      ok: true,
      lane: "reconcile_result",
    });
    expect(validateToolLedgerEventLane(fixture.decisionEvent("diverged"))).toEqual({
      ok: true,
      lane: "recovery_decision",
    });
  });

  it("一行同时带两个 lane 字段 → semantic_lane_conflict", () => {
    const fixture = toolFixture();
    const hybrid: ToolLedgerEvent = { ...fixture.callEvent, dispatch: fixture.dispatchEvent.dispatch };
    expect(validateToolLedgerEventLane(hybrid).ok).toBe(false);
  });

  it("dispatch 行的 refs 必须与 dispatch 事实一致，否则它证明不了自己结算的是谁", () => {
    const fixture = toolFixture();
    const mismatched: ToolLedgerEvent = {
      ...fixture.dispatchEvent,
      refs: { operationId: "toolop_other", toolCallId: fixture.providerToolCallId },
    };
    expect(validateToolLedgerEventLane(mismatched).ok).toBe(false);
  });

  it("call 行不得带 refs（它发生在 operationId 存在之前）", () => {
    const fixture = toolFixture();
    const withRefs: ToolLedgerEvent = {
      ...fixture.callEvent,
      refs: { operationId: fixture.operationId, toolCallId: fixture.providerToolCallId },
    };
    expect(validateToolLedgerEventLane(withRefs).ok).toBe(false);
  });

  it("recovery 字段存在但 kind 认不出来 → 冲突，不会被当成普通行放过", () => {
    const fixture = toolFixture();
    const broken = fixture.reconcileEvent("diverged");
    broken.recovery = { ...broken.recovery!, kind: "pibuddy.tool.whatever" } as never;
    expect(validateToolLedgerEventLane(broken).ok).toBe(false);
  });

  it("普通行（不带任何 lane 字段）合法且被扫描忽略", () => {
    const fixture = toolFixture();
    const ordinary: ToolLedgerEvent = {
      id: "note-1",
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      invocationId: fixture.invocationId,
      runId: fixture.runId,
      turnId: fixture.turnId,
      ts: 0,
    };
    expect(validateToolLedgerEventLane(ordinary)).toEqual({ ok: true, lane: "ordinary" });
    expect(scanToolLedger([ordinary]).operations).toEqual([]);
  });
});

describe("元组主键", () => {
  it("分隔符注入不会撞出同一个 key", () => {
    expect(toolCallIdentity("a", "b_c")).not.toBe(toolCallIdentity("a_b", "c"));
  });
});

describe("重复事件 id", () => {
  it("同一个 id 出现两次 → duplicate_event_id", () => {
    const fixture = toolFixture();
    const scan = scanToolLedger([fixture.callEvent, fixture.callEvent]);
    expect(scan.issues.map((issue) => issue.code)).toContain("duplicate_event_id");
  });
});

describe("validateToolLedgerTransition —— 写入事务前置校验", () => {
  it("T1 形状：call + dispatch 通过", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    expect(
      validateToolLedgerTransition({
        existingEvents: [],
        candidateEvents: [fixture.callEvent, fixture.dispatchEvent],
        expectedTransition: "t1_prepare",
      })
    ).toEqual({ ok: true });
  });

  it("T1 形状：call 已存在时只补 dispatch 也通过（等审批期间 call 先落了）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    expect(
      validateToolLedgerTransition({
        existingEvents: [fixture.callEvent],
        candidateEvents: [fixture.callEvent, fixture.dispatchEvent],
        expectedTransition: "t1_prepare",
      })
    ).toEqual({ ok: true });
  });

  it("T1 形状：顺序反了直接拒", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const result = validateToolLedgerTransition({
      existingEvents: [],
      candidateEvents: [fixture.dispatchEvent, fixture.callEvent],
      expectedTransition: "t1_prepare",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("transition_shape_conflict");
  });

  it("T2 形状：response 必须带 refs.operationId（无主的 response 结算不了任何东西）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const unbound = fixture.responseEvent();
    delete unbound.refs;
    const result = validateToolLedgerTransition({
      existingEvents: [fixture.callEvent, fixture.dispatchEvent],
      candidateEvents: [unbound],
      expectedTransition: "t2_outcome",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("transition_shape_conflict");
  });

  it("同 id 不同内容的候选事件 → duplicate_event_id（不是幂等重试）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const tampered: ToolLedgerEvent = { ...fixture.callEvent, ts: 999 };
    const result = validateToolLedgerTransition({
      existingEvents: [fixture.callEvent],
      candidateEvents: [tampered, fixture.dispatchEvent],
      expectedTransition: "t1_prepare",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("duplicate_event_id");
  });

  it("已损坏的账本上不接受任何新事务", () => {
    const fixture = toolFixture();
    const orphan = fixture.dispatchEvent;
    const next = toolFixture({ providerToolCallId: "provider-call-2" });
    const result = validateToolLedgerTransition({
      existingEvents: [orphan],
      candidateEvents: [next.callEvent, next.dispatchEvent],
      expectedTransition: "t1_prepare",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("orphan_dispatch");
  });

  it("恢复包形状：reconcile + outcome + decision 通过，缺 reconcile 拒", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const existing = [fixture.callEvent, fixture.dispatchEvent];
    expect(
      validateToolLedgerTransition({
        existingEvents: existing,
        candidateEvents: [
          fixture.reconcileEvent("matches_expected_state"),
          fixture.responseEvent(),
          fixture.decisionEvent("matches_expected_state"),
        ],
        expectedTransition: "recovery_bundle",
      })
    ).toEqual({ ok: true });

    const result = validateToolLedgerTransition({
      existingEvents: existing,
      candidateEvents: [fixture.decisionEvent("diverged")],
      expectedTransition: "recovery_bundle",
    });
    expect(result.ok).toBe(false);
  });
});
