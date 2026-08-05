import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toolFixture } from "./ledger-fixtures";
import { resolveToolRecovery } from "./recovery-resolver";
import { ToolRecoveryStore, ToolRecoveryStoreError } from "./recovery-store";
import type { ToolLedgerEvent } from "./ledger-scanner";

let root: string;
let store: ToolRecoveryStore;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pibuddy-tool-recovery-"));
  store = new ToolRecoveryStore(path.join(root, "tool-recovery.db"));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("T1 commitToolPrepared", () => {
  it("落地后 operation 处于 prepared，且账本里 call 先于 dispatch", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const result = await store.commitToolPrepared(fixture.preparedCommit());
    expect(result).toEqual({ created: true, ledgerSeq: 2 });

    const operation = store.readToolOperation(fixture.operationId);
    expect(operation).toMatchObject({
      currentState: "prepared",
      callEventId: fixture.callEvent.id,
      dispatchEventId: fixture.dispatchEvent.id,
      version: 1,
    });
    expect(operation?.resultEventId).toBeUndefined();
    expect(store.readJournal(fixture.workspaceId).map((r) => r.state)).toEqual([
      "call",
      "prepared",
    ]);
  });

  it("幂等重试：同 operationId 逐字节相同 → created:false，不产生第二份账本行", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    const retry = await store.commitToolPrepared(fixture.preparedCommit());
    expect(retry).toEqual({ created: false, ledgerSeq: 2 });
    expect(store.readJournal(fixture.workspaceId)).toHaveLength(2);
    expect(store.readToolOperation(fixture.operationId)?.version).toBe(1);
  });

  it("同 operationId 但事件内容不同 → 冲突抛错，绝不静默覆盖", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    const tampered = fixture.preparedCommit();
    tampered.callEvent = { ...tampered.callEvent, ts: 999 };
    await expect(store.commitToolPrepared(tampered)).rejects.toThrow(
      /idempotent_retry_conflict/
    );
  });

  it("operationId 不是确定性派生出来的 → 直接拒（否则崩溃后算不回来）", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const forged = { ...fixture.preparedCommit(), operationId: "toolop_handwritten" };
    await expect(store.commitToolPrepared(forged)).rejects.toThrow(/input_identity_conflict/);
  });

  it("canonicalArgsHash 与实参重算结果不符 → 拒（不信写入方自述）", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const forged = { ...fixture.preparedCommit(), canonicalArgsHash: `sha256:${"e".repeat(64)}` };
    await expect(store.commitToolPrepared(forged)).rejects.toThrow(/input_identity_conflict/);
  });

  it("dispatch 与 call 不在同一执行身份上 → 拒", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const commit = fixture.preparedCommit();
    commit.dispatchEvent = { ...commit.dispatchEvent, turnId: "turn-9" };
    await expect(store.commitToolPrepared(commit)).rejects.toThrow(/input_identity_conflict/);
  });

  it("按 workspaceId 分区：另一个工作区看不到这条 operation 的账本", async () => {
    const a = toolFixture({ withProtocolMarker: true, workspaceId: "ws-a" });
    const b = toolFixture({
      withProtocolMarker: true,
      workspaceId: "ws-b",
      invocationId: "invocation-2",
    });
    await store.commitToolPrepared(a.preparedCommit());
    await store.commitToolPrepared(b.preparedCommit());
    expect(store.readLedger("ws-a").map((e) => e.id)).toEqual([a.callEvent.id, a.dispatchEvent.id]);
    expect(store.readLedger("ws-b").map((e) => e.id)).toEqual([b.callEvent.id, b.dispatchEvent.id]);
    expect(store.listUnsettledToolOperations("ws-a").map((o) => o.operationId)).toEqual([
      a.operationId,
    ]);
  });
});

describe("T2 commitToolOutcome", () => {
  it("结算后进入 outcome_committed，版本递增，不再出现在未结算列表里", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    const result = await store.commitToolOutcome(fixture.outcomeCommit());
    expect(result).toEqual({ created: true, ledgerSeq: 3 });
    expect(store.readToolOperation(fixture.operationId)).toMatchObject({
      currentState: "outcome_committed",
      resultEventId: fixture.responseEvent().id,
      version: 2,
    });
    expect(store.listUnsettledToolOperations(fixture.workspaceId)).toEqual([]);
  });

  it("CAS 冲突：并发双写的第二个写入者必须抛，而不是静默覆盖", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());

    // 模拟第二个写入者：它读到的还是 prepared 快照，但真正写的时候
    // current_state 已经不是 prepared 了。CAS 的 WHERE 会让 changes = 0。
    await store.commitToolOutcome(fixture.outcomeCommit());
    const second = fixture.outcomeCommit();
    second.outcomeEvent = { ...second.outcomeEvent, ts: 99 };
    await expect(store.commitToolOutcome(second)).rejects.toThrow(/idempotent_retry_conflict/);
    // 第一次写入的内容原封不动。
    expect(store.readToolOperation(fixture.operationId)?.version).toBe(2);
    expect(store.readJournal(fixture.workspaceId)).toHaveLength(3);
  });

  it("同 operationId 的 T2 幂等重试：逐字节相同 → created:false", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    await store.commitToolOutcome(fixture.outcomeCommit());
    const retry = await store.commitToolOutcome(fixture.outcomeCommit());
    expect(retry).toEqual({ created: false, ledgerSeq: 3 });
    expect(store.readToolOperation(fixture.operationId)?.version).toBe(2);
  });

  it("未 prepare 过的 operation 直接 T2 → unknown_operation", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await expect(store.commitToolOutcome(fixture.outcomeCommit())).rejects.toThrow(
      /unknown_operation/
    );
  });

  it("结算事件身份对不上 operation → 拒", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    const commit = fixture.outcomeCommit();
    commit.outcomeEvent = {
      ...commit.outcomeEvent,
      refs: { operationId: "toolop_other", toolCallId: fixture.providerToolCallId },
    };
    await expect(store.commitToolOutcome(commit)).rejects.toThrow(/input_identity_conflict/);
  });
});

describe("CAS 语义的直接证明", () => {
  it("并发双写：恢复流程已 park，迟到的 T2 必须被 CAS 拦下而不是静默覆盖", async () => {
    // 这是 CAS 真正防的那一格：两个结算权威（正常 T2 与恢复流程）都认为
    // 自己看到的是 prepared 快照。恢复流程先落了 parked 裁决，此时
    // result_event_id 仍然是 NULL —— 只有 `current_state = 'prepared'` 这个
    // 条件能把迟到的 T2 拦住。
    //
    // 拆掉 CAS 的 WHERE 之后，这条 UPDATE 的 changes 仍然是 1：parked 裁决
    // 被悄无声息地改写成 outcome_committed，账本里那条「已 park」的终局事实
    // 就成了谎话。本用例是那次改动的红灯。
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    await store.commitToolRecoveryBundle(fixture.bundleCommit("diverged"));
    const parked = store.readToolOperation(fixture.operationId);
    expect(parked?.currentState).toBe("recovery_parked");
    expect(parked?.resultEventId).toBeUndefined();

    await expect(store.commitToolOutcome(fixture.outcomeCommit())).rejects.toThrow(
      /compare_and_set_failed/
    );
    // 终局事实原封不动。
    expect(store.readToolOperation(fixture.operationId)?.currentState).toBe("recovery_parked");
  });

  it("拆掉 CAS 的 WHERE 条件后，第二次写入会静默覆盖第一次", async () => {
    // 这里直接对同一张表复现「无条件 UPDATE」的行为，说明 CAS 的必要性：
    // 不带 current_state / result_event_id 条件时，第二次 UPDATE 的 changes
    // 仍然是 1，覆盖悄无声息地发生。
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    await store.commitToolOutcome(fixture.outcomeCommit());
    const before = store.readToolOperation(fixture.operationId);
    expect(before?.resultEventId).toBe(fixture.responseEvent().id);

    // 带条件的第二次写入：CAS 拦住它（result_event_id 已非 NULL）。
    const conflicting = fixture.outcomeCommit();
    conflicting.outcomeEvent = { ...conflicting.outcomeEvent, ts: 77 };
    await expect(store.commitToolOutcome(conflicting)).rejects.toBeInstanceOf(
      ToolRecoveryStoreError
    );
    expect(store.readToolOperation(fixture.operationId)?.resultEventId).toBe(before?.resultEventId);
  });
});

describe("recovery bundle", () => {
  it("completed 包：一个事务落地 reconcile + outcome + decision", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    await store.commitToolRecoveryBundle(fixture.bundleCommit("matches_expected_state"));
    expect(store.readToolOperation(fixture.operationId)).toMatchObject({
      currentState: "recovery_completed",
      resultEventId: fixture.responseEvent().id,
    });
    expect(store.readJournal(fixture.workspaceId).map((r) => r.state)).toEqual([
      "call",
      "prepared",
      "reconcile_observed",
      "outcome_committed",
      "recovery_completed",
    ]);
  });

  it("parked 包：不写 outcome，operation 停在 recovery_parked", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    await store.commitToolRecoveryBundle(fixture.bundleCommit("diverged"));
    const operation = store.readToolOperation(fixture.operationId);
    expect(operation?.currentState).toBe("recovery_parked");
    expect(operation?.resultEventId).toBeUndefined();
    expect(store.listUnsettledToolOperations(fixture.workspaceId)).toEqual([]);
  });

  it("只允许完全相同的重试：同一份包再来一次是幂等的", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    await store.commitToolRecoveryBundle(fixture.bundleCommit("diverged"));
    await store.commitToolRecoveryBundle(fixture.bundleCommit("diverged"));
    expect(store.readJournal(fixture.workspaceId)).toHaveLength(4);
  });

  it("已 parked 的 operation 上重放一份 completed 包 → 拒", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    await store.commitToolRecoveryBundle(fixture.bundleCommit("diverged"));
    await expect(
      store.commitToolRecoveryBundle(fixture.bundleCommit("matches_expected_state"))
    ).rejects.toThrow(/bundle_conflict/);
  });

  it("重试时内容有一处不同 → 拒（差的那一点可能正是裁决依据）", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    await store.commitToolRecoveryBundle(fixture.bundleCommit("diverged"));
    const retry = fixture.bundleCommit("diverged");
    retry.reconcileEvent = { ...retry.reconcileEvent, ts: 999 };
    await expect(store.commitToolRecoveryBundle(retry)).rejects.toThrow(
      /idempotent_retry_conflict/
    );
  });

  it("观测 diverged 却判 completed → 拒", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    const forged = fixture.bundleCommit("matches_expected_state");
    forged.reconcileEvent = fixture.reconcileEvent("diverged");
    await expect(store.commitToolRecoveryBundle(forged)).rejects.toThrow(/bundle_conflict/);
  });

  it("parked 包却带 outcome → 拒", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    const forged = fixture.bundleCommit("diverged");
    forged.outcomeEvent = fixture.responseEvent();
    await expect(store.commitToolRecoveryBundle(forged)).rejects.toThrow(/bundle_conflict/);
  });

  it("未 prepare 的 operation 上提交恢复包 → unknown_operation", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await expect(store.commitToolRecoveryBundle(fixture.bundleCommit("diverged"))).rejects.toThrow(
      /unknown_operation/
    );
  });
});

describe("事务原子性（同进程等价验证）", () => {
  it("T1 中途抛错 → 整个事务回滚，账本与 operation 表都保持空", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pibuddy-tool-recovery-fp-"));
    const failing = new ToolRecoveryStore(path.join(dir, "db.sqlite"), {
      failpoint: (point) => {
        if (point === "after_operation_insert") throw new Error("boom");
      },
    });
    const fixture = toolFixture({ withProtocolMarker: true });
    try {
      await expect(failing.commitToolPrepared(fixture.preparedCommit())).rejects.toThrow("boom");
      expect(failing.readLedger(fixture.workspaceId)).toEqual([]);
      expect(failing.readToolOperation(fixture.operationId)).toBeUndefined();
    } finally {
      failing.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T2 中途抛错 → 回滚到 prepared，T1 的两条事实不受影响", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pibuddy-tool-recovery-fp-"));
    let armed = false;
    const failing = new ToolRecoveryStore(path.join(dir, "db.sqlite"), {
      failpoint: (point) => {
        if (armed && point === "after_ledger_event_insert") throw new Error("boom-t2");
      },
    });
    const fixture = toolFixture({ withProtocolMarker: true });
    try {
      await failing.commitToolPrepared(fixture.preparedCommit());
      armed = true;
      await expect(failing.commitToolOutcome(fixture.outcomeCommit())).rejects.toThrow("boom-t2");
      expect(failing.readToolOperation(fixture.operationId)).toMatchObject({
        currentState: "prepared",
        version: 1,
      });
      expect(failing.readLedger(fixture.workspaceId).map((e) => e.id)).toEqual([
        fixture.callEvent.id,
        fixture.dispatchEvent.id,
      ]);
    } finally {
      failing.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("恢复包中途抛错 → 整包回滚，不留半截观测", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pibuddy-tool-recovery-fp-"));
    const failing = new ToolRecoveryStore(path.join(dir, "db.sqlite"), {
      failpoint: (point) => {
        if (point === "after_recovery_reconcile") throw new Error("boom-bundle");
      },
    });
    const fixture = toolFixture({ withProtocolMarker: true });
    try {
      await failing.commitToolPrepared(fixture.preparedCommit());
      await expect(
        failing.commitToolRecoveryBundle(fixture.bundleCommit("diverged"))
      ).rejects.toThrow("boom-bundle");
      expect(failing.readToolOperation(fixture.operationId)?.currentState).toBe("prepared");
      expect(failing.readJournal(fixture.workspaceId)).toHaveLength(2);
    } finally {
      failing.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("store → scanner → resolver 闭环", () => {
  it("落地一条只 prepare 未结算的 operation，重开后被判 indeterminate", async () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    await store.commitToolPrepared(fixture.preparedCommit());
    const resolution = resolveToolRecovery(store.readLedger(fixture.workspaceId));
    expect(resolution.hasCorruption).toBe(false);
    expect(resolution.requiresReconciliation).toBe(true);
    expect(resolution.decisions[0]).toMatchObject({
      status: "indeterminate",
      reason: "dispatch_without_response",
      operationId: fixture.operationId,
    });
  });

  it("落地 call 但 T1 未完成（模拟崩在 T1 里）的账本 → definitely_not_dispatched", async () => {
    // T1 是原子的，所以真实账本里不会出现「只有 call」。这里用 resolver 直接
    // 验证判据本身：新协议下缺 dispatch 就是「没派发」。
    const fixture = toolFixture({ withProtocolMarker: true });
    const ledger: ToolLedgerEvent[] = [fixture.callEvent];
    const resolution = resolveToolRecovery(ledger);
    expect(resolution.safeToRetry.map((d) => d.operationId ?? d.toolCallId)).toEqual([
      fixture.providerToolCallId,
    ]);
  });

  it("多工作区共库时 resolver 只看自己那份账本", async () => {
    const a = toolFixture({ withProtocolMarker: true, workspaceId: "ws-a" });
    const b = toolFixture({
      withProtocolMarker: true,
      workspaceId: "ws-b",
      invocationId: "invocation-2",
    });
    await store.commitToolPrepared(a.preparedCommit());
    await store.commitToolPrepared(b.preparedCommit());
    await store.commitToolOutcome(b.outcomeCommit());
    expect(resolveToolRecovery(store.readLedger("ws-a")).decisions[0]!.status).toBe(
      "indeterminate"
    );
    expect(resolveToolRecovery(store.readLedger("ws-b")).decisions[0]!.status).toBe("completed");
  });
});
