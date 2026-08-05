import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeCommitBoundaryError } from "./commit-sink";
import {
  ToolDispatchBlockedError,
  ToolDispatchBoundary,
  resolveToolDispatchVerdict,
  type ToolDispatchLedger,
  type ToolDispatchRequest,
} from "./dispatch-guard";
import { toolFixture } from "./ledger-fixtures";
import { TOOL_BOUNDARY_PROTOCOL_V1, buildToolOperationId } from "./operation-id";
import { ToolRecoveryStore } from "./recovery-store";
import { ToolOutcomeUnknownError } from "./tool-guards";
import type { ToolLedgerEvent } from "./ledger-scanner";

let root: string;
let store: ToolRecoveryStore;
let clock = 1000;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pibuddy-dispatch-guard-"));
  store = new ToolRecoveryStore(path.join(root, "tool-recovery.db"));
  clock = 1000;
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function boundary(ledger: ToolDispatchLedger = store): ToolDispatchBoundary {
  return new ToolDispatchBoundary(ledger, () => ++clock);
}

function request(overrides: Partial<ToolDispatchRequest> = {}): ToolDispatchRequest {
  return {
    workspaceId: "ws-1",
    sessionId: "session-1",
    invocationId: "invocation-1",
    runId: "run-1",
    turnId: "turn-1",
    providerToolCallId: "call-1",
    toolName: "home.light.set",
    args: { entity_id: "light.a", on: true },
    ...overrides,
  };
}

describe("① T1 严格早于 impl，失败直接抛（impl 零调用）", () => {
  it("正常路径：先落 call + dispatch，再跑 impl，最后落 response", async () => {
    const order: string[] = [];
    const result = await boundary().run(request(), async () => {
      // impl 跑起来的这一刻，账本里必须已经有派发事实。
      order.push(...store.readJournal("ws-1").map((row) => row.state));
      return "ok";
    });
    expect(result).toBe("ok");
    expect(order).toEqual(["call", "prepared"]);
    expect(store.readJournal("ws-1").map((row) => row.state)).toEqual([
      "call",
      "prepared",
      "outcome_committed",
    ]);
  });

  it("T1 落不下去时 impl 一次都不跑，且异常穿透到调用方", async () => {
    let calls = 0;
    const broken: ToolDispatchLedger = {
      readLedger: (workspaceId) => store.readLedger(workspaceId),
      commitToolPrepared: () => Promise.reject(new Error("磁盘满了")),
      commitToolOutcome: () => Promise.reject(new Error("不该走到这里")),
    };
    await expect(
      boundary(broken).run(request(), async () => {
        calls += 1;
        return "副作用";
      })
    ).rejects.toBeInstanceOf(RuntimeCommitBoundaryError);
    // 这一条是整套夹逼的地基：没有 dispatch 事实 ⇒ 断言 impl 没跑过。
    expect(calls).toBe(0);
  });

  it("② created:false 同样算失败：重复派发不会执行第二次", async () => {
    let calls = 0;
    const req = request();
    await boundary().run(req, async () => {
      calls += 1;
      return "第一次";
    });
    // 同一个 (invocationId, providerToolCallId) 再来一次：operationId 相同。
    // 此时 T2 已经落地，store 会以 CAS 失败拒绝；把它退回到 prepared 之前的
    // 状态不可能，所以这里直接断言「第二次不会执行 impl」。
    await expect(
      boundary().run(req, async () => {
        calls += 1;
        return "第二次";
      })
    ).rejects.toBeInstanceOf(RuntimeCommitBoundaryError);
    expect(calls).toBe(1);
  });

  it("③ T1 之前重新检查 abort：审批期间被取消 → 零副作用、零账本行", async () => {
    let calls = 0;
    let aborted = false;
    await expect(
      boundary().run(
        request({
          aborted: () => aborted,
          validateArgs: () => {
            // 模拟一次 async 审批：校验通过之后用户点了取消。
            aborted = true;
          },
        }),
        async () => {
          calls += 1;
          return "开灯";
        }
      )
    ).rejects.toThrow(/已被取消/);
    expect(calls).toBe(0);
    expect(store.readJournal("ws-1")).toHaveLength(0);
  });
});

describe("④ T2 在结果交还调用方之前", () => {
  it("结算落不下去时不返回结果，而是抛「不知道有没有生效」", async () => {
    const halfDead: ToolDispatchLedger = {
      readLedger: (workspaceId) => store.readLedger(workspaceId),
      commitToolPrepared: (input) => store.commitToolPrepared(input),
      commitToolOutcome: () => Promise.reject(new Error("进程正在退出")),
    };
    const error = await boundary(halfDead)
      .run(request(), async () => "灯已经开了")
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ToolOutcomeUnknownError);
    // 账本停在 prepared，交给下次启动的恢复流程 —— 这正是 indeterminate。
    expect(store.readToolOperation(buildToolOperationId(request()))?.currentState).toBe("prepared");
  });

  it("impl 抛错也要结算（错误同样是一条结算事实）", async () => {
    await expect(
      boundary().run(request(), async () => {
        throw new Error("端点拒绝");
      })
    ).rejects.toThrow("端点拒绝");
    const journal = store.readJournal("ws-1");
    expect(journal.map((row) => row.state)).toEqual(["call", "prepared", "outcome_committed"]);
    expect(journal[2]?.event.response?.isError).toBe(true);
  });
});

describe("派发护栏挂在同一段路上", () => {
  it("循环闸：同一调用连续失败 3 次后第 3 次不再执行 impl", async () => {
    const line = boundary();
    let calls = 0;
    const impl = async (): Promise<never> => {
      calls += 1;
      throw new Error("失败");
    };
    // 每次用不同的 providerToolCallId（否则会先撞上 T1 的重复派发）。
    for (let i = 0; i < 2; i += 1) {
      await expect(
        line.run(request({ providerToolCallId: `call-${i}` }), impl)
      ).rejects.toThrow("失败");
    }
    const blocked = await line
      .run(request({ providerToolCallId: "call-2" }), impl)
      .catch((err: unknown) => err);
    expect(blocked).toBeInstanceOf(ToolDispatchBlockedError);
    expect(calls).toBe(2);
    // 拦住的这次不该留下任何账本行。
    expect(store.readToolOperation(buildToolOperationId(request({ providerToolCallId: "call-2" }))))
      .toBeUndefined();
  });

  it("参数违规：在 T1 之前被拦，回执带上这个工具接受的字段名", async () => {
    let calls = 0;
    const blocked = await boundary()
      .run(
        request({
          parameters: { shape: { entity_id: {}, brightness: {} } },
          validateArgs: () => {
            throw new Error("entityId 不是这个工具的字段");
          },
        }),
        async () => {
          calls += 1;
          return "开灯";
        }
      )
      .catch((err: unknown) => err);
    expect(blocked).toBeInstanceOf(ToolDispatchBlockedError);
    expect((blocked as Error).message).toContain("entity_id");
    expect((blocked as Error).message).toContain("brightness");
    expect(calls).toBe(0);
    expect(store.readJournal("ws-1")).toHaveLength(0);
  });
});

describe("协议标记盖在账本首位，且只盖一次", () => {
  it("空账本的第一次 T1 盖章；之后的调用不再盖", async () => {
    await boundary().run(request(), async () => "一");
    await boundary().run(request({ providerToolCallId: "call-2" }), async () => "二");

    const ledger = store.readLedger("ws-1");
    expect(ledger[0]?.protocol).toEqual({ toolBoundary: TOOL_BOUNDARY_PROTOCOL_V1 });
    expect(ledger.slice(1).every((event) => event.protocol === undefined)).toBe(true);
  });

  it("已有老数据的账本（非空、无标记）绝不补盖 —— 老数据不许被升级成新协议", async () => {
    // 先用 fixture 直接落一条**不带标记**的 pre-T1 老记录。
    const legacy = toolFixture({ workspaceId: "ws-1", invocationId: "legacy", withProtocolMarker: false });
    await store.commitToolPrepared(legacy.preparedCommit());

    await boundary().run(request(), async () => "新调用");
    expect(store.readLedger("ws-1").every((event) => event.protocol === undefined)).toBe(true);
  });

  it("按工作区分别盖章：ws-2 的第一次 T1 自己盖自己的", async () => {
    await boundary().run(request(), async () => "一");
    await boundary().run(
      request({ workspaceId: "ws-2", invocationId: "invocation-2" }),
      async () => "二"
    );
    expect(store.readLedger("ws-2")[0]?.protocol).toEqual({
      toolBoundary: TOOL_BOUNDARY_PROTOCOL_V1,
    });
  });
});

describe("盖章之后 definitely_not_dispatched 才可能出现", () => {
  /** 一条「有调用事实、没有派发事实」的账本 —— 崩在 T1 之前的样子。 */
  function callOnlyLedger(withMarker: boolean): ToolLedgerEvent[] {
    const fixture = toolFixture({ withProtocolMarker: withMarker });
    return [fixture.callEvent];
  }

  it("没盖章（legacy）：缺派发事实不携带任何信息 → indeterminate，不许自动重跑", () => {
    const fixture = toolFixture({ withProtocolMarker: false });
    const verdict = resolveToolDispatchVerdict({
      events: callOnlyLedger(false),
      identity: { invocationId: fixture.invocationId, providerToolCallId: fixture.providerToolCallId },
      dispatchedNotBefore: 0,
    });
    expect(verdict.status).toBe("indeterminate");
    expect(verdict.retrySafe).toBe(false);
    expect(verdict.reason).toBe("legacy_dispatch_unknown");
    expect(verdict.uncertain?.retrySafe).toBe(false);
  });

  it("盖了章：同一份账本、同一条 operation → definitely_not_dispatched，可安全自动重跑", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const verdict = resolveToolDispatchVerdict({
      events: callOnlyLedger(true),
      identity: { invocationId: fixture.invocationId, providerToolCallId: fixture.providerToolCallId },
      dispatchedNotBefore: 0,
    });
    expect(verdict.status).toBe("definitely_not_dispatched");
    expect(verdict.retrySafe).toBe(true);
    expect(verdict.reason).toBe("new_protocol_before_dispatch");
    expect(verdict.uncertain).toBeUndefined();
  });

  it("有派发、无结算 → 恒 indeterminate，不管盖没盖章", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const verdict = resolveToolDispatchVerdict({
      events: [fixture.callEvent, fixture.dispatchEvent],
      identity: { invocationId: fixture.invocationId, providerToolCallId: fixture.providerToolCallId },
      dispatchedNotBefore: 0,
    });
    expect(verdict.status).toBe("indeterminate");
    expect(verdict.reason).toBe("dispatch_without_response");
    expect(verdict.retrySafe).toBe(false);
  });

  it("有结算 → settled", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const verdict = resolveToolDispatchVerdict({
      events: [fixture.callEvent, fixture.dispatchEvent, fixture.responseEvent()],
      identity: { invocationId: fixture.invocationId, providerToolCallId: fixture.providerToolCallId },
      dispatchedNotBefore: 0,
    });
    expect(verdict.status).toBe("settled");
    expect(verdict.retrySafe).toBe(false);
  });
});

describe("账本里查无此条：时间下界堵住「标记之前的老执行」", () => {
  it("执行晚于标记落地 → definitely_not_dispatched（T1 都没写，impl 一定没跑）", async () => {
    await boundary().run(request(), async () => "先来一条把章盖上");
    const markerTs = store.readLedger("ws-1")[0]!.ts;
    const verdict = resolveToolDispatchVerdict({
      events: store.readLedger("ws-1"),
      identity: { invocationId: "task-run:r9", providerToolCallId: "attempt-1" },
      dispatchedNotBefore: markerTs + 1,
    });
    expect(verdict.status).toBe("definitely_not_dispatched");
    expect(verdict.retrySafe).toBe(true);
  });

  it("执行早于标记落地 → indeterminate（那时候的代码写不写派发事实，这份账本证明不了）", async () => {
    await boundary().run(request(), async () => "先来一条把章盖上");
    const markerTs = store.readLedger("ws-1")[0]!.ts;
    const verdict = resolveToolDispatchVerdict({
      events: store.readLedger("ws-1"),
      identity: { invocationId: "task-run:old", providerToolCallId: "attempt-1" },
      dispatchedNotBefore: markerTs - 1,
    });
    expect(verdict.status).toBe("indeterminate");
    expect(verdict.retrySafe).toBe(false);
  });

  it("账本整份为空 → indeterminate（连标记都没有，什么都推不出来）", () => {
    const verdict = resolveToolDispatchVerdict({
      events: [],
      identity: { invocationId: "never-happened", providerToolCallId: "call-1" },
      dispatchedNotBefore: 0,
    });
    expect(verdict.status).toBe("indeterminate");
    expect(verdict.retrySafe).toBe(false);
  });

  it("账本损坏 → corruption，且绝不给出可重跑结论", () => {
    const fixture = toolFixture({ withProtocolMarker: true });
    const verdict = resolveToolDispatchVerdict({
      // 孤儿派发（没有对应的 call 事实）：账本自身损坏。
      events: [{ ...fixture.dispatchEvent, protocol: { toolBoundary: TOOL_BOUNDARY_PROTOCOL_V1 } }],
      identity: { invocationId: fixture.invocationId, providerToolCallId: fixture.providerToolCallId },
      dispatchedNotBefore: 0,
    });
    expect(verdict.status).toBe("corruption");
    expect(verdict.retrySafe).toBe(false);
  });
});
