import { describe, expect, it } from "vitest";

import { childSpecSchema, type ChildSpec } from "@pibuddy/contract";
import { ChildAgentCore, type ChildLaunchRequest } from "../src/main/child-agent/child-core.js";

/**
 * child Agent 编排核心的可证伪判据（AGT-102）。
 *
 * 铁律：cancel 传播到子节点、非幂等工具不因断线自动重放这类行为，必须**真的
 * 制造父子拓扑 + 断线时序**来证伪，而不是断言「某函数被调用过」。因此每个
 * host 调用都被记进一条有序流水（launched / stopped / delivered），断言读的是
 * 这条流水的内容与顺序。
 *
 * 对拍验证（临时拆掉确认变红，两次输出）记在
 * `.workflow/scratch/capability-research/FEAT-child-agent.md`。
 */

interface HostLog {
  launched: string[];
  stopped: string[];
  delivered: Array<{ nodeId: string; text: string }>;
}

function makeCore(opts?: { cap?: number; deliverResult?: boolean }) {
  const log: HostLog = { launched: [], stopped: [], delivered: [] };
  const core = new ChildAgentCore({
    providerConcurrencyCap: opts?.cap ?? 3,
    host: {
      launch: (req: ChildLaunchRequest) => log.launched.push(req.nodeId),
      stop: (nodeId: string) => log.stopped.push(nodeId),
      deliver: async (nodeId: string, text: string) => {
        log.delivered.push({ nodeId, text });
        return opts?.deliverResult ?? true;
      },
    },
  });
  return { core, log };
}

function spec(over: Partial<ChildSpec> = {}): ChildSpec {
  return childSpecSchema.parse({ goal: "g", ...over });
}

function statusOf(core: ChildAgentCore, nodeId: string): string {
  return core.snapshot().nodes.find((n) => n.nodeId === nodeId)!.status;
}

describe("child 编排：创建与拓扑", () => {
  it("父子孙三层拓扑：parentId 串成一棵树，runtime 确认后进入 running", () => {
    const { core, log } = makeCore();
    const now = 1000;
    const p = core.createChild(null, spec({ goal: "parent" }), now).nodeId;
    const c = core.createChild(p, spec({ goal: "child" }), now).nodeId;
    const g = core.createChild(c, spec({ goal: "grand" }), now).nodeId;
    core.onRuntimeReady(p, now);
    core.onRuntimeReady(c, now);
    core.onRuntimeReady(g, now);

    const snap = core.snapshot();
    expect(snap.nodes.map((n) => n.nodeId)).toEqual([p, c, g]);
    expect(snap.nodes.find((n) => n.nodeId === c)!.parentId).toBe(p);
    expect(snap.nodes.find((n) => n.nodeId === g)!.parentId).toBe(c);
    expect([statusOf(core, p), statusOf(core, c), statusOf(core, g)]).toEqual([
      "running",
      "running",
      "running",
    ]);
    expect(log.launched).toEqual([p, c, g]);
  });

  it("子未指定工作区时继承父的工作区", () => {
    const { core } = makeCore();
    const p = core.createChild(null, spec({ workspaceId: "ws-1" }), 0).nodeId;
    const c = core.createChild(p, spec({ workspaceId: null }), 0).nodeId;
    expect(core.snapshot().nodes.find((n) => n.nodeId === c)!.workspaceId).toBe("ws-1");
  });

  it("重复任务检测：同父同目标未终态 → 返回既有节点，不重复派生", () => {
    const { core, log } = makeCore();
    const a = core.createChild(null, spec({ goal: "build" }), 0);
    const b = core.createChild(null, spec({ goal: "build" }), 0);
    expect(b.duplicate).toBe(true);
    expect(b.nodeId).toBe(a.nodeId);
    // 只 launch 了一次——对拍：去掉 findDuplicate，这里会变成两条 launch。
    expect(log.launched).toEqual([a.nodeId]);
  });
});

describe("child 编排：cancel 向整棵子树传播（真父子时序）", () => {
  it("取消父 → 父/子/孙全部 cancelled，且每个在跑的子进程都被 stop（后序）", () => {
    const { core, log } = makeCore();
    const now = 0;
    const p = core.createChild(null, spec({ goal: "p" }), now).nodeId;
    const c = core.createChild(p, spec({ goal: "c" }), now).nodeId;
    const g = core.createChild(c, spec({ goal: "g" }), now).nodeId;
    core.onRuntimeReady(p, now);
    core.onRuntimeReady(c, now);
    core.onRuntimeReady(g, now);

    const stopped = core.cancel(p, now + 10);

    expect([statusOf(core, p), statusOf(core, c), statusOf(core, g)]).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    // 后序：最深的孙先停，再子，再父。对拍：只取消自己不递归子树时，
    // g 仍是 running、stopped 里没有 g。
    expect(stopped).toEqual([g, c, p]);
    expect(log.stopped).toEqual([g, c, p]);
  });

  it("取消一个中间节点只波及它的子树，兄弟不受影响", () => {
    const { core } = makeCore();
    const p = core.createChild(null, spec({ goal: "p" }), 0).nodeId;
    const c1 = core.createChild(p, spec({ goal: "c1" }), 0).nodeId;
    const c2 = core.createChild(p, spec({ goal: "c2" }), 0).nodeId;
    core.onRuntimeReady(p, 0);
    core.onRuntimeReady(c1, 0);
    core.onRuntimeReady(c2, 0);
    core.cancel(c1, 1);
    expect(statusOf(core, c1)).toBe("cancelled");
    expect(statusOf(core, c2)).toBe("running");
    expect(statusOf(core, p)).toBe("running");
  });
});

describe("child 编排：非幂等工具不因断线自动重放（断线时序）", () => {
  it("非幂等子运行中断线 → blocked，不自动重放（launch 恰一次）", () => {
    const { core, log } = makeCore();
    const c = core.createChild(null, spec({ goal: "migrate-db", idempotent: false }), 0).nodeId;
    core.onRuntimeReady(c, 0);
    expect(statusOf(core, c)).toBe("running");
    // 断线（崩溃）。
    core.onRuntimeExit(c, "crash", 100);
    expect(statusOf(core, c)).toBe("blocked");
    // 关键：只 launch 过一次，断线没有触发第二次 launch。
    // 对拍：把「非幂等 → blocked」改成「一律重放」，launched 会变成两条、
    // 状态回到 running。
    expect(log.launched).toEqual([c]);
    expect(core.snapshot().nodes[0].blockedReason).toContain("非幂等");
  });

  it("等待回答时断线 → 保留问题并进入 disconnected blocked，不自动重放", () => {
    const { core, log } = makeCore();
    const c = core.createChild(
      null,
      spec({ goal: "confirm-side-effect", idempotent: false, retryBudget: 3 }),
      0
    ).nodeId;
    core.ingestMessage(
      c,
      { type: "question", question: { id: "q1", prompt: "继续？", options: [], at: 1 } },
      1
    );

    core.onRuntimeExit(c, "crash", 100);

    const node = core.snapshot().nodes[0];
    expect(node.status).toBe("blocked");
    expect(node.question).toEqual({ id: "q1", prompt: "继续？", options: [], at: 1 });
    expect(node.blockedReason).toContain("等待回答时断开");
    expect(log.launched).toEqual([c]);

    core.cancel(c, 101);
    expect(log.stopped).toEqual([]);
  });

  it("幂等子运行中断线 → 预算内自动重放（launch 两次），预算耗尽转 failed", () => {
    const { core, log } = makeCore();
    const c = core.createChild(
      null,
      spec({ goal: "fetch-idempotent", idempotent: true, retryBudget: 1 }),
      0
    ).nodeId;
    core.onRuntimeReady(c, 0);
    expect(log.launched).toEqual([c]);
    core.onRuntimeExit(c, "crash", 100);
    // 预算内：重放并等待新 runtime 确认首条目标。
    expect(statusOf(core, c)).toBe("pending");
    core.onRuntimeReady(c, 101);
    expect(statusOf(core, c)).toBe("running");
    expect(log.launched).toEqual([c, c]);
    expect(core.snapshot().nodes[0].retryCount).toBe(1);
    // 再断一次：预算耗尽 → failed，不再 launch。
    core.onRuntimeExit(c, "crash", 200);
    expect(statusOf(core, c)).toBe("failed");
    expect(log.launched).toEqual([c, c]);
  });

  it("expected-stop（预期停止）永不触发重放，无论幂等与否", () => {
    const { core, log } = makeCore();
    const c = core.createChild(null, spec({ goal: "x", idempotent: true, retryBudget: 5 }), 0).nodeId;
    core.onRuntimeReady(c, 0);
    core.onRuntimeExit(c, "expected-stop", 10);
    expect(statusOf(core, c)).toBe("running"); // 状态不变（预期停止由上层已处置）
    expect(log.launched).toEqual([c]);
  });
});

describe("child 编排：结构化消息（不解析自然语言）", () => {
  it("progress / question / evidence / result 各自落到结构化字段", async () => {
    const { core, log } = makeCore();
    const c = core.createChild(null, spec({ goal: "g" }), 0).nodeId;

    expect(core.ingestMessage(c, { type: "progress", progress: { note: "50%", fraction: 0.5, at: 1 } }, 1)).toBe(true);
    expect(core.snapshot().nodes[0].progress).toEqual({ note: "50%", fraction: 0.5, at: 1 });

    core.ingestMessage(c, { type: "evidence", evidence: { kind: "commit", title: "abc123", detail: "feat: x", at: 2 } }, 2);
    expect(core.snapshot().nodes[0].evidence).toEqual([
      { kind: "commit", title: "abc123", detail: "feat: x", at: 2 },
    ]);

    core.ingestMessage(c, { type: "question", question: { id: "q1", prompt: "继续？", options: [], at: 3 } }, 3);
    expect(statusOf(core, c)).toBe("waiting_answer");

    await core.answer(c, "q1", "继续", 4);
    expect(statusOf(core, c)).toBe("running");
    expect(log.delivered).toEqual([{ nodeId: c, text: "继续" }]);

    core.ingestMessage(c, { type: "result", result: { ok: true, summary: "done", deliverables: {}, at: 5 } }, 5);
    expect(statusOf(core, c)).toBe("succeeded");
  });

  it("回答投递失败 → 保留问题并阻塞，不虚报 running", async () => {
    const { core, log } = makeCore({ deliverResult: false });
    const c = core.createChild(null, spec({ goal: "g" }), 0).nodeId;
    core.ingestMessage(
      c,
      { type: "question", question: { id: "q1", prompt: "继续？", options: [], at: 1 } },
      1
    );

    await core.answer(c, "q1", "继续", 2);

    const node = core.snapshot().nodes[0];
    expect(node.status).toBe("blocked");
    expect(node.question?.id).toBe("q1");
    expect(node.blockedReason).toContain("回答投递失败");
    expect(log.delivered).toEqual([{ nodeId: c, text: "继续" }]);

    core.cancel(c, 3);
    expect(log.stopped).toEqual([]);
  });

  it("非结构化 / 不合 schema 的上报被丢弃，不猜、不容错", () => {
    const { core } = makeCore();
    const c = core.createChild(null, spec({ goal: "g" }), 0).nodeId;
    core.onRuntimeReady(c, 0);
    // 一段像日志的自然语言，不是结构化消息 → 丢弃，状态不动。
    expect(core.ingestMessage(c, "任务已完成，结果良好", 1)).toBe(false);
    expect(core.ingestMessage(c, { type: "done" }, 1)).toBe(false);
    expect(statusOf(core, c)).toBe("running");
  });
});

describe("child 编排：Provider 限流协调", () => {
  it("同 provider 超过在飞闸的子进入 pending，前者让位后才准入", () => {
    const { core, log } = makeCore({ cap: 2 });
    const p = childSpecSchema.parse({ goal: "a", model: { provider: "anthropic", modelId: "m" } });
    const a = core.createChild(null, { ...p, goal: "a" }, 0).nodeId;
    const b = core.createChild(null, { ...p, goal: "b" }, 0).nodeId;
    const d = core.createChild(null, { ...p, goal: "d" }, 0).nodeId;
    core.onRuntimeReady(a, 0);
    core.onRuntimeReady(b, 0);
    // cap=2：a、b running，d 因在飞满而 pending。对拍：去掉 inFlight>=cap 半句，
    // 三个会同时 running。
    expect([statusOf(core, a), statusOf(core, b), statusOf(core, d)]).toEqual([
      "running",
      "running",
      "pending",
    ]);
    expect(log.launched).toEqual([a, b]);
    expect(core.snapshot().providerInFlight).toEqual({ anthropic: 2 });

    // a 提问 → 让出在飞位 → d 被准入。
    core.ingestMessage(a, { type: "question", question: { id: "q", prompt: "?", options: [], at: 1 } }, 1);
    expect(statusOf(core, d)).toBe("pending");
    core.onRuntimeReady(d, 1);
    expect(statusOf(core, d)).toBe("running");
    expect(log.launched).toEqual([a, b, d]);
  });
});

describe("child 编排：超时与预算收口", () => {
  it("超时 → timed_out 并取消子树", () => {
    const { core } = makeCore();
    const p = core.createChild(null, spec({ goal: "p", timeoutMs: 100 }), 0).nodeId;
    const c = core.createChild(p, spec({ goal: "c" }), 0).nodeId;
    const expired = core.tick(200);
    expect(expired).toEqual([p]);
    expect(statusOf(core, p)).toBe("timed_out");
    expect(statusOf(core, c)).toBe("cancelled");
  });

  it("成本超预算 → failed 并停进程", () => {
    const { core, log } = makeCore();
    const c = core.createChild(null, spec({ goal: "g", budgetUsd: 1 }), 0).nodeId;
    core.recordCost(c, 1.5, 10);
    expect(statusOf(core, c)).toBe("failed");
    expect(core.snapshot().nodes[0].blockedReason).toBe("超出成本预算");
    expect(log.stopped).toEqual([c]);
  });
});

describe("child 编排：coding 子的 worktree 合并裁决", () => {
  it("isolatedWorktree 子 result.ok → blocked 等裁决；accept → succeeded", () => {
    const { core, log } = makeCore();
    const c = core.createChild(null, spec({ goal: "code", isolatedWorktree: true }), 0).nodeId;
    core.ingestMessage(c, { type: "evidence", evidence: { kind: "patch", title: "改了 3 个文件", detail: "diff...", at: 1 } }, 1);
    core.ingestMessage(c, { type: "result", result: { ok: true, summary: "done", deliverables: {}, at: 2 } }, 2);
    // 不直接 succeeded：合并前要父裁决。
    expect(statusOf(core, c)).toBe("blocked");
    expect(core.snapshot().nodes[0].pendingMerge).toEqual({ patchTitle: "改了 3 个文件", hasConflict: false });
    expect(log.stopped).toEqual([c]);

    core.resolveMerge(c, true, 3);
    expect(statusOf(core, c)).toBe("succeeded");
    expect(core.snapshot().nodes[0].pendingMerge).toBeNull();
  });

  it("reject → failed", () => {
    const { core } = makeCore();
    const c = core.createChild(null, spec({ goal: "code", isolatedWorktree: true }), 0).nodeId;
    core.ingestMessage(c, { type: "result", result: { ok: true, summary: "", deliverables: {}, at: 1 } }, 1);
    core.resolveMerge(c, false, 2);
    expect(statusOf(core, c)).toBe("failed");
  });
});
