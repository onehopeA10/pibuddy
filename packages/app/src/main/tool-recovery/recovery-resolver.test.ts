/**
 * 分类算法全矩阵。
 *
 * 这个文件是本任务的主要交付：它证明的是「什么时候可以断言工具没跑」。
 * 任何让 legacy 账本也能得出 `definitely_not_dispatched` 的改动都必须在这里
 * 变红 —— 见 `三态协议判据` 那一组。
 */
import { describe, expect, it } from "vitest";

import { toolFixture } from "./ledger-fixtures";
import { resolveToolRecovery } from "./recovery-resolver";
import { TOOL_RECOVERY_FACT_VERSION } from "./recovery-fact";
import type { ToolLedgerEvent } from "./ledger-scanner";

function only(events: ToolLedgerEvent[]) {
  const resolution = resolveToolRecovery(events);
  expect(resolution.decisions).toHaveLength(1);
  return { resolution, decision: resolution.decisions[0]! };
}

describe("三态协议判据 —— 缺 dispatch 时的结论", () => {
  it("新协议 + 有 call + 无 dispatch → definitely_not_dispatched（可安全自动重跑）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const { resolution, decision } = only([fixture.callEvent]);
    expect(decision.status).toBe("definitely_not_dispatched");
    expect(decision.reason).toBe("new_protocol_before_dispatch");
    expect(resolution.safeToRetry).toHaveLength(1);
    expect(resolution.hasCorruption).toBe(false);
  });

  it("legacy（无 marker）+ 同样的缺口 → indeterminate，绝不升级成「没派发」", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const { resolution, decision } = only([fixture.callEvent]);
    expect(decision.status).toBe("indeterminate");
    expect(decision.reason).toBe("legacy_dispatch_unknown");
    // 关键断言：legacy 账本一条都不许进自动重跑名单。
    expect(resolution.safeToRetry).toHaveLength(0);
    expect(resolution.protocolMarker.status).toBe("absent");
  });

  it("marker 出现在非首位 → 整份账本判损坏（不降级成 legacy 继续用）", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const misplaced: ToolLedgerEvent = {
      ...fixture.dispatchEvent,
      protocol: { toolBoundary: "pibuddy.tool_boundary.v1" },
    };
    const resolution = resolveToolRecovery([fixture.callEvent, misplaced]);
    expect(resolution.protocolMarker).toEqual({
      status: "invalid",
      eventId: misplaced.id,
      reason: "not_first",
    });
    expect(resolution.hasCorruption).toBe(true);
    expect(resolution.issues.map((issue) => issue.code)).toContain("protocol_marker_invalid");
    expect(resolution.decisions.every((d) => d.status === "corruption")).toBe(true);
    expect(resolution.safeToRetry).toHaveLength(0);
  });

  it("marker 版本不认识 → 直接判损坏（不当作 legacy）", () => {
    const fixture = toolFixture();
    const unknown: ToolLedgerEvent = {
      ...fixture.callEvent,
      protocol: { toolBoundary: "pibuddy.tool_boundary.v99" },
    };
    const resolution = resolveToolRecovery([unknown]);
    expect(resolution.protocolMarker).toEqual({
      status: "invalid",
      eventId: unknown.id,
      reason: "unknown_version",
    });
    expect(resolution.hasCorruption).toBe(true);
    expect(resolution.decisions[0]!.status).toBe("corruption");
    expect(resolution.decisions[0]!.reason).toBe("protocol_marker_invalid");
    expect(resolution.safeToRetry).toHaveLength(0);
  });
});

describe("分类矩阵 —— 有 dispatch 的情形", () => {
  it("dispatch 无 response → indeterminate（副作用可能已发生，park 不猜）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const { resolution, decision } = only([fixture.callEvent, fixture.dispatchEvent]);
    expect(decision.status).toBe("indeterminate");
    expect(decision.reason).toBe("dispatch_without_response");
    expect(resolution.requiresReconciliation).toBe(true);
    expect(resolution.safeToRetry).toHaveLength(0);
  });

  it("legacy 账本里的 dispatch 无 response 同样是 indeterminate", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const { decision } = only([fixture.callEvent, fixture.dispatchEvent]);
    expect(decision.status).toBe("indeterminate");
    expect(decision.reason).toBe("dispatch_without_response");
  });

  it("call + dispatch + response → completed / normal_t2", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const { resolution, decision } = only([
      fixture.callEvent,
      fixture.dispatchEvent,
      fixture.responseEvent(),
    ]);
    expect(decision.status).toBe("completed");
    expect(decision.reason).toBe("matching_response");
    expect(decision.settlementOrigin).toBe("normal_t2");
    expect(decision.responseIsError).toBe(false);
    expect(resolution.requiresReconciliation).toBe(false);
  });

  it("错误结果也算结算完毕（工具跑过了，只是失败了）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const { decision } = only([
      fixture.callEvent,
      fixture.dispatchEvent,
      fixture.responseEvent(true),
    ]);
    expect(decision.status).toBe("completed");
    expect(decision.responseIsError).toBe(true);
  });
});

describe("分类矩阵 —— pre-T1 合成结算", () => {
  it("有 response 无 dispatch → completed，来源标为 pre_t1_synthetic", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    // pre-T1 的 response 不带 refs：那时候还没有 operationId 这个概念。
    const legacyResponse: ToolLedgerEvent = { ...fixture.responseEvent() };
    delete legacyResponse.refs;
    const { decision } = only([fixture.callEvent, legacyResponse]);
    expect(decision.status).toBe("completed");
    expect(decision.reason).toBe("matching_response");
    expect(decision.settlementOrigin).toBe("pre_t1_synthetic");
    expect(decision.dispatchEventId).toBeUndefined();
  });
});

describe("分类矩阵 —— 结构损坏", () => {
  it("孤儿 dispatch（无 call）→ corruption", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const { resolution, decision } = only([fixture.dispatchEvent]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("orphan_dispatch");
    expect(resolution.hasCorruption).toBe(true);
  });

  it("孤儿 response（无 call）→ corruption", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const { decision } = only([fixture.responseEvent()]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("orphan_response");
  });

  it("重复 call → corruption", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const duplicate: ToolLedgerEvent = { ...fixture.callEvent, id: `${fixture.callEvent.id}_2` };
    const { decision } = only([fixture.callEvent, duplicate]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("duplicate_call");
  });

  it("重复 dispatch → corruption", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const duplicate: ToolLedgerEvent = {
      ...fixture.dispatchEvent,
      id: `${fixture.dispatchEvent.id}_2`,
    };
    const { decision } = only([fixture.callEvent, fixture.dispatchEvent, duplicate]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("duplicate_dispatch");
  });

  it("重复 response → corruption", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const duplicate: ToolLedgerEvent = {
      ...fixture.responseEvent(),
      id: `${fixture.responseEvent().id}_2`,
    };
    const { decision } = only([
      fixture.callEvent,
      fixture.dispatchEvent,
      fixture.responseEvent(),
      duplicate,
    ]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("duplicate_response");
  });

  it("dispatch 声称的实参哈希与 call 实参重算结果不符 → corruption", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const tampered: ToolLedgerEvent = {
      ...fixture.dispatchEvent,
      dispatch: { ...fixture.dispatchEvent.dispatch!, canonicalArgsHash: `sha256:${"c".repeat(64)}` },
    };
    const { decision } = only([fixture.callEvent, tampered]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("canonical_args_hash_conflict");
  });

  it("一行同时属于两个 lane → semantic_lane_conflict，整份账本损坏", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const hybrid: ToolLedgerEvent = {
      ...fixture.callEvent,
      response: { toolCallId: fixture.providerToolCallId, toolName: fixture.toolName, isError: false },
    };
    const resolution = resolveToolRecovery([hybrid]);
    expect(resolution.hasCorruption).toBe(true);
    expect(resolution.issues.map((issue) => issue.code)).toContain("semantic_lane_conflict");
  });

  it("response 先于 dispatch 落地 → 回溯校验触发 event_order_conflict", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const { decision } = only([
      fixture.callEvent,
      fixture.responseEvent(),
      fixture.dispatchEvent,
    ]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("event_order_conflict");
  });

  it("同一个 invocation 跨越两条 (session, run, turn) 脊 → corruption", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const strayed: ToolLedgerEvent = { ...fixture.dispatchEvent, turnId: "turn-2" };
    const resolution = resolveToolRecovery([fixture.callEvent, strayed]);
    expect(resolution.hasCorruption).toBe(true);
    expect(resolution.issues.map((i) => i.code)).toContain("invocation_identity_conflict");
  });

  it("corruption 判据是固定优先级：同时命中多项时诊断确定，且可重复", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const duplicateCall: ToolLedgerEvent = { ...fixture.callEvent, id: `${fixture.callEvent.id}_2` };
    const tampered: ToolLedgerEvent = {
      ...fixture.dispatchEvent,
      dispatch: { ...fixture.dispatchEvent.dispatch!, canonicalArgsHash: `sha256:${"d".repeat(64)}` },
    };
    const events = [fixture.callEvent, duplicateCall, tampered];
    const first = resolveToolRecovery(events).decisions[0]!;
    const second = resolveToolRecovery(events).decisions[0]!;
    // duplicate_call 优先于 canonical_args_hash_conflict（见 CORRUPTION_PRIORITY）。
    expect(first.reason).toBe("duplicate_call");
    expect(second.reason).toBe(first.reason);
  });
});

describe("分类矩阵 —— 恢复包", () => {
  it("完整的 completed 恢复包 → completed / recovery_bundle", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const { decision } = only([
      fixture.callEvent,
      fixture.dispatchEvent,
      fixture.reconcileEvent("matches_expected_state"),
      fixture.responseEvent(),
      fixture.decisionEvent("matches_expected_state"),
    ]);
    expect(decision.status).toBe("completed");
    expect(decision.reason).toBe("recovery_bundle_completed");
    expect(decision.settlementOrigin).toBe("recovery_bundle");
  });

  it("三种 parked 观测各自映射到对应的 park 原因", () => {
    for (const observation of ["matches_prior_state", "diverged", "unreadable"] as const) {
      const fixture = toolFixture({ withProtocolMarker: true });
      const { decision } = only([
        fixture.callEvent,
        fixture.dispatchEvent,
        fixture.reconcileEvent(observation),
        fixture.decisionEvent(observation),
      ]);
      expect(decision.status).toBe("parked");
      expect(decision.reason).toBe(
        observation === "matches_prior_state"
          ? "reconcile_matches_prior_state"
          : observation === "diverged"
            ? "reconcile_diverged"
            : "reconcile_unreadable"
      );
    }
  });

  it("只有 reconcile 没有 decision → recovery_fact_corruption（半截恢复包比没有更危险）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const { decision } = only([
      fixture.callEvent,
      fixture.dispatchEvent,
      fixture.reconcileEvent("diverged"),
    ]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("recovery_fact_corruption");
    expect(decision.settlementOrigin).toBeUndefined();
  });

  it("裁决与观测矛盾（观测 diverged 却判 completed）→ corruption", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const { decision } = only([
      fixture.callEvent,
      fixture.dispatchEvent,
      fixture.reconcileEvent("diverged"),
      fixture.responseEvent(),
      fixture.decisionEvent("matches_expected_state"),
    ]);
    expect(decision.status).toBe("corruption");
    expect(decision.reason).toBe("recovery_fact_corruption");
  });

  it("证据链顺序被打乱 → corruption（裁决不能声称依据了当时不存在的观测）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const tampered = fixture.decisionEvent("diverged");
    const payload = tampered.recovery!.payload as { evidenceEventIds: string[] };
    tampered.recovery = {
      ...tampered.recovery!,
      payload: { ...payload, evidenceEventIds: [...payload.evidenceEventIds].reverse() },
    } as typeof tampered.recovery;
    const { decision } = only([
      fixture.callEvent,
      fixture.dispatchEvent,
      fixture.reconcileEvent("diverged"),
      tampered,
    ]);
    expect(decision.status).toBe("corruption");
  });

  it("恢复事实版本不认识 → lane 判定就拒（不会被当成普通行放过去）", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const future = fixture.reconcileEvent("diverged");
    future.recovery = {
      ...future.recovery!,
      version: (TOOL_RECOVERY_FACT_VERSION + 1) as typeof TOOL_RECOVERY_FACT_VERSION,
    };
    const resolution = resolveToolRecovery([fixture.callEvent, fixture.dispatchEvent, future]);
    expect(resolution.hasCorruption).toBe(true);
    expect(resolution.issues.map((i) => i.code)).toContain("semantic_lane_conflict");
  });
});

describe("多 operation 账本", () => {
  it("同一个 toolCallId 在不同 invocation 下是两条独立 operation，不会互相短路", () => {
    const first = toolFixture({
      withProtocolMarker: true,
      invocationId: "inv-a",
      providerToolCallId: "call_1",
    });
    const second = toolFixture({ invocationId: "inv-b", providerToolCallId: "call_1" });
    const resolution = resolveToolRecovery([
      first.callEvent,
      first.dispatchEvent,
      first.responseEvent(),
      second.callEvent,
    ]);
    expect(resolution.hasCorruption).toBe(false);
    expect(resolution.decisions).toHaveLength(2);
    expect(resolution.decisions[0]!.status).toBe("completed");
    expect(resolution.decisions[1]!.status).toBe("definitely_not_dispatched");
    expect(resolution.safeToRetry.map((d) => d.invocationId)).toEqual(["inv-b"]);
  });

  it("账本里有任何一处损坏，safeToRetry 一律清空", () => {
    const clean = toolFixture({
      withProtocolMarker: true,
      invocationId: "inv-a",
      providerToolCallId: "call_1",
    });
    const broken = toolFixture({ invocationId: "inv-b", providerToolCallId: "call_2" });
    const resolution = resolveToolRecovery([
      clean.callEvent,
      broken.dispatchEvent, // 孤儿 dispatch
    ]);
    expect(resolution.hasCorruption).toBe(true);
    expect(resolution.safeToRetry).toHaveLength(0);
  });
});

describe("空账本", () => {
  it("没有事件时不产生任何结论，也不算损坏", () => {
    const resolution = resolveToolRecovery([]);
    expect(resolution).toMatchObject({
      hasCorruption: false,
      requiresReconciliation: false,
    });
    expect(resolution.decisions).toEqual([]);
    expect(resolution.protocolMarker.status).toBe("absent");
  });
});
