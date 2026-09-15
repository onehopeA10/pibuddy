import { describe, expect, it } from "vitest";

import type { AgentEvent } from "@pibuddy/pi-sdk";
import { PROTOCOL_VERSION, type PiEnvelope } from "@pibuddy/contract";
import {
  AgentPoolCore,
  type PoolLaunchRequest,
  type PoolRuntimeHost,
} from "../src/main/agent-pool/pool-core.js";

/**
 * AgentPoolCore 的**可证伪**判据（AGT-101 第一批）。
 *
 * 本项目铁律：多会话并发的判据必须**真的制造并发**，不能只断言 `pool.size==N`。
 * 因此这里的核心用例交错投喂两个会话的真实事件流 / 成本 / 权限，断言 A 会话
 * 的列表态/成本/未读只反映 A 自己——**串台就红**。序号闸门那条尤其关键：它构造
 * 出「B 的序号恒小于 A 当前序号」的交错，若把 per-session 闸门退化成全局单
 * 计数器，B 的事件会被全部判成「序号倒退」丢掉，B 永远到不了 done，用例立刻红。
 */

// ---------------------------------------------------------------- 测试替身

interface HostCall {
  op: "launch" | "stop";
  sessionId: string;
  origin?: string;
}

function makeHost(): { host: PoolRuntimeHost; calls: HostCall[] } {
  const calls: HostCall[] = [];
  const host: PoolRuntimeHost = {
    launch(req: PoolLaunchRequest) {
      calls.push({ op: "launch", sessionId: req.sessionId, origin: req.origin });
    },
    stop(sessionId: string) {
      calls.push({ op: "stop", sessionId });
    },
  };
  return { host, calls };
}

let seqCounter = 0;
function envelope(
  sessionId: string,
  generation: number,
  sequence: number,
  payload: AgentEvent
): PiEnvelope<AgentEvent> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: "ws",
    sessionId,
    runtimeId: `rt-${sessionId}-${generation}`,
    generation,
    sequence,
    occurredAt: ++seqCounter,
    payload,
  };
}

const agentStart = { type: "agent_start" } as unknown as AgentEvent;
const agentSettled = { type: "agent_settled" } as unknown as AgentEvent;
const message = { type: "message_update" } as unknown as AgentEvent;

// ---------------------------------------------------------------- 并发不串台

describe("N 个并发会话不串消息/成本/权限（真交错，串台就红）", () => {
  it("两个活跃会话交错事件流：列表态/成本/未读各归各的", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.requestSession({ sessionId: "B", workspaceId: "ws" });
    pool.onRuntimeReady("A", { runtimeId: "rt-A-1", generation: 1 }, 10);
    pool.onRuntimeReady("B", { runtimeId: "rt-B-1", generation: 1 }, 10);
    pool.setFocused("A"); // A 前台，B 后台

    // A 先跑一整轮，把它的序号推到 5。
    pool.observeEnvelope(envelope("A", 1, 0, agentStart));
    for (let s = 1; s <= 5; s++) pool.observeEnvelope(envelope("A", 1, s, message));
    pool.recordCost("A", 1.25);

    // 关键交错：B 的序号从 0 开始，**恒小于 A 当前的 5**。
    // per-session 闸门下 B 全部被接受；退化成全局闸门则 B 全被判「倒退」丢弃。
    pool.observeEnvelope(envelope("B", 1, 0, agentStart));
    pool.observeEnvelope(envelope("B", 1, 1, message));
    pool.observeEnvelope(envelope("B", 1, 2, agentSettled));
    pool.recordCost("B", 3.5);

    const snap = pool.snapshot();
    const a = snap.sessions.find((s) => s.sessionId === "A")!;
    const b = snap.sessions.find((s) => s.sessionId === "B")!;

    // B 的事件没有被 A 的序号污染（串台就红）。
    expect(b.listState).toBe("done");
    expect(pool.droppedEnvelopes).toBe(0);

    // 成本各归各：A 只有 A 的、B 只有 B 的（混算就红）。
    expect(a.costUsd).toBe(1.25);
    expect(b.costUsd).toBe(3.5);
    expect(snap.totalCostUsd).toBe(4.75);

    // 未读：前台 A 恒不未读；后台 B 有新进展 → 未读。
    expect(a.unread).toBe(false);
    expect(b.unread).toBe(true);
    // A 仍在 running（它没收到 settled），B 已 done —— 两个进度互不影响。
    expect(a.listState).toBe("running");
  });

  it("同会话内真正陈旧的信封才被丢弃（droppedEnvelopes 计到它头上）", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.onRuntimeReady("A", { runtimeId: "rt-A-1", generation: 1 }, 10);

    pool.observeEnvelope(envelope("A", 1, 3, agentStart));
    expect(pool.droppedEnvelopes).toBe(0);
    // 序号回退（上一代迟到 / 重复）→ 丢弃。
    pool.observeEnvelope(envelope("A", 1, 2, message));
    expect(pool.droppedEnvelopes).toBe(1);
    // 新代际 → 序号从 0 重新计数，被接受（不因数值更小而丢）。
    pool.onRuntimeReady("A", { runtimeId: "rt-A-2", generation: 2 }, 20);
    pool.observeEnvelope(envelope("A", 2, 0, agentStart));
    expect(pool.droppedEnvelopes).toBe(1);
  });
});

// ---------------------------------------------------------------- 资源上界

describe("资源上界与公平准入（防止开 100 个会话打爆机器）", () => {
  it("全局并发上界：超出的会话排队，不被拒绝；有位就 FIFO 准入", () => {
    const { host, calls } = makeHost();
    const pool = new AgentPoolCore({
      host,
      caps: { maxConcurrent: 2, maxPerWorkspace: 5, memoryCeilingMb: 9999, costCeilingUsd: 9999 },
    });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.requestSession({ sessionId: "B", workspaceId: "ws" });
    pool.requestSession({ sessionId: "C", workspaceId: "ws" });

    let snap = pool.snapshot();
    expect(snap.activeCount).toBe(2);
    expect(snap.queuedCount).toBe(1);
    expect(snap.sessions.find((s) => s.sessionId === "C")!.queued).toBe(true);
    // 只起了两个进程（上界拦住了第三个）。
    expect(calls.filter((c) => c.op === "launch").length).toBe(2);

    // 停掉一个 → 排队的 C 被公平准入。
    pool.stopSession("A");
    snap = pool.snapshot();
    expect(snap.sessions.find((s) => s.sessionId === "C")!.queued).toBe(false);
    expect(snap.activeCount).toBe(2);
  });

  it("每 workspace 并发上界独立于全局", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({
      host,
      caps: { maxConcurrent: 9, maxPerWorkspace: 1, memoryCeilingMb: 9999, costCeilingUsd: 9999 },
    });
    pool.requestSession({ sessionId: "A", workspaceId: "w1" });
    pool.requestSession({ sessionId: "B", workspaceId: "w1" });
    pool.requestSession({ sessionId: "C", workspaceId: "w2" });
    const snap = pool.snapshot();
    // w1 只准一个，w2 一个 → 共 2 活跃，B 排队。
    expect(snap.activeCount).toBe(2);
    expect(snap.sessions.find((s) => s.sessionId === "B")!.queued).toBe(true);
    expect(snap.sessions.find((s) => s.sessionId === "C")!.queued).toBe(false);
  });

  it("成本上界拦住新会话准入", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({
      host,
      caps: { maxConcurrent: 9, maxPerWorkspace: 9, memoryCeilingMb: 9999, costCeilingUsd: 5 },
    });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.recordCost("A", 6); // 已越过成本上界
    pool.requestSession({ sessionId: "B", workspaceId: "ws" });
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "B")!.queued).toBe(true);
  });

  it("RSS 回填驱动内存上界：采样越界拦准入，回落后同一拍放行", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({
      host,
      caps: { maxConcurrent: 9, maxPerWorkspace: 9, memoryCeilingMb: 1000, costCeilingUsd: 9999 },
    });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.onRuntimeReady("A", { runtimeId: "r1", generation: 1, pid: 4242 }, 10);
    expect(pool.livePids()).toEqual([{ sessionId: "A", pid: 4242 }]);

    // 采样到 1200 MB：越过 1000 的上界，新会话只能排队
    pool.recordMemoryBatch([{ sessionId: "A", memoryMb: 1200 }]);
    expect(pool.snapshot().totalMemoryMb).toBe(1200);
    pool.requestSession({ sessionId: "B", workspaceId: "ws" });
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "B")!.queued).toBe(true);

    // 下一拍回落到 300 MB：批量回填自己重跑准入，B 不必等别的事件
    pool.recordMemoryBatch([{ sessionId: "A", memoryMb: 300 }]);
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "B")!.queued).toBe(false);

    // 没有 pid 的会话（排队 / 假 client）不接受回填；停掉后 pid 与内存一并清零
    pool.recordMemoryBatch([{ sessionId: "B", memoryMb: 999 }]);
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "B")!.memoryMb).toBe(0);
    pool.stopSession("A");
    expect(pool.livePids()).toEqual([]);
    expect(pool.snapshot().totalMemoryMb).toBe(0);
  });

  it("永久崩溃释放并发位后立即准入队首会话", () => {
    const { host, calls } = makeHost();
    const pool = new AgentPoolCore({
      host,
      caps: { maxConcurrent: 1, maxPerWorkspace: 2, memoryCeilingMb: 9999, costCeilingUsd: 9999 },
      timing: { crashBudget: 0 },
    });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.requestSession({ sessionId: "B", workspaceId: "ws" });
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "B")!.queued).toBe(true);

    pool.onCrash("A", 100);

    expect(pool.snapshot().sessions.find((s) => s.sessionId === "A")!.runState).toBe("crashed");
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "B")!.queued).toBe(false);
    expect(calls.filter((c) => c.op === "launch").map((c) => c.sessionId)).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------- 崩溃预算

describe("崩溃预算：窗口内超预算才放弃自动恢复", () => {
  it("task 崩溃不走池通用重试；scheduler 保留唯一重试所有权", () => {
    const { host, calls } = makeHost();
    const pool = new AgentPoolCore({ host, timing: { crashBudget: 9 } });
    pool.requestSession({ sessionId: "task:run-1", workspaceId: "ws", origin: "task" });

    pool.handleExit("task:run-1", "crash", 100);

    expect(pool.snapshot().sessions[0].runState).toBe("crashed");
    expect(calls.filter((c) => c.op === "launch")).toEqual([
      { op: "launch", sessionId: "task:run-1", origin: "task" },
    ]);
  });

  it("child 崩溃不走池通用重试；同 ownership 的再次请求可重启终态记录", () => {
    const { host, calls } = makeHost();
    const pool = new AgentPoolCore({ host, timing: { crashBudget: 9 } });
    pool.requestSession({ sessionId: "C", workspaceId: "ws", origin: "child" });

    pool.handleExit("C", "crash", 100);
    expect(pool.snapshot().sessions[0].runState).toBe("crashed");
    expect(calls.filter((c) => c.op === "launch").map((c) => c.sessionId)).toEqual(["C"]);

    pool.requestSession({ sessionId: "C", workspaceId: "ws", origin: "child" });
    expect(pool.snapshot().sessions[0].runState).toBe("background");
    expect(calls.filter((c) => c.op === "launch").map((c) => c.sessionId)).toEqual(["C", "C"]);
  });

  it("同 sessionId 不能换 workspace 或 origin 复用", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "A", workspaceId: "ws-1", origin: "user" });
    expect(() =>
      pool.requestSession({ sessionId: "A", workspaceId: "ws-2", origin: "user" })
    ).toThrow(/POOL_SESSION_OWNERSHIP_MISMATCH/);
    expect(() =>
      pool.requestSession({ sessionId: "A", workspaceId: "ws-1", origin: "child" })
    ).toThrow(/POOL_SESSION_OWNERSHIP_MISMATCH/);
  });

  it("预算内崩溃 → 自动恢复（重新 launch）", () => {
    const { host, calls } = makeHost();
    const pool = new AgentPoolCore({ host, timing: { crashBudget: 2, crashWindowMs: 60_000 } });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    const before = calls.filter((c) => c.op === "launch").length;
    pool.onCrash("A", 1000);
    const after = calls.filter((c) => c.op === "launch").length;
    expect(after).toBe(before + 1); // 自动重起
    expect(pool.snapshot().sessions[0].runState).toBe("background");
    expect(pool.snapshot().sessions[0].listState).toBe("failed");
  });

  it("超预算崩溃 → 置 crashed，不再自动恢复", () => {
    const { host, calls } = makeHost();
    const pool = new AgentPoolCore({ host, timing: { crashBudget: 2, crashWindowMs: 60_000 } });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.onCrash("A", 1000);
    pool.onCrash("A", 2000);
    const launchesBefore = calls.filter((c) => c.op === "launch").length;
    pool.onCrash("A", 3000); // 第 3 次，越过预算 2
    expect(pool.snapshot().sessions[0].runState).toBe("crashed");
    // 越预算这次不再 launch。
    expect(calls.filter((c) => c.op === "launch").length).toBe(launchesBefore);
  });

  it("崩溃时间落在窗口外不计入预算", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host, timing: { crashBudget: 1, crashWindowMs: 1000 } });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.onCrash("A", 1000);
    pool.onCrash("A", 5000); // 距上次 4s，超出 1s 窗口 → 旧的不计，仍在预算内
    expect(pool.snapshot().sessions[0].runState).toBe("background");
  });
});

// ---------------------------------------------------------------- 空闲回收

describe("空闲回收：background → warm → stopped（running 永不回收）", () => {
  it("runtime ready 初始化并更新 lastActivityAt", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.onRuntimeReady("A", { runtimeId: "rt-A-1", generation: 1 }, 1234);
    expect(pool.snapshot().sessions[0].lastActivityAt).toBe(1234);
    pool.onRuntimeReady("A", { runtimeId: "rt-A-2", generation: 2 }, 5678);
    expect(pool.snapshot().sessions[0].lastActivityAt).toBe(5678);
  });

  it("按空闲时长逐级回收", () => {
    const { host, calls } = makeHost();
    const pool = new AgentPoolCore({
      host,
      timing: { idleToWarmMs: 1000, warmToStoppedMs: 2000 },
    });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.onRuntimeReady("A", { runtimeId: "rt-A-1", generation: 1 }, 10);
    pool.observeEnvelope(envelope("A", 1, 0, agentSettled)); // lastActivity = 某刻，done
    const activityAt = pool.snapshot().sessions[0].lastActivityAt;

    pool.tick(activityAt + 1000); // 到 warm 阈值
    expect(pool.snapshot().sessions[0].runState).toBe("warm");
    pool.tick(activityAt + 2000); // 到 stopped 阈值
    expect(pool.snapshot().sessions[0].runState).toBe("stopped");
    expect(calls.some((c) => c.op === "stop" && c.sessionId === "A")).toBe(true);
  });

  it("running 会话不被回收", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host, timing: { idleToWarmMs: 1 } });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.onRuntimeReady("A", { runtimeId: "rt-A-1", generation: 1 }, 10);
    pool.observeEnvelope(envelope("A", 1, 0, agentStart)); // running
    pool.tick(1_000_000);
    expect(pool.snapshot().sessions[0].runState).toBe("background");
  });
});

// ---------------------------------------------------------------- 权限 inbox

describe("统一权限 inbox：超时拒绝，绝不自动允许", () => {
  it("入队 → waiting_permission；超时 → 返回待拒办、从 inbox 移除、恢复列表态", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host, timing: { permissionTimeoutMs: 1000 } });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.onRuntimeReady("A", { runtimeId: "rt-A-1", generation: 1 }, 10);
    pool.observeEnvelope(envelope("A", 1, 0, agentStart)); // running

    pool.enqueuePermission({
      id: "p1",
      sessionId: "A",
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      now: 1000,
    });
    expect(pool.snapshot().sessions[0].listState).toBe("waiting_permission");
    expect(pool.snapshot().inbox.length).toBe(1);

    // 未到 deadline：不拒绝。
    expect(pool.tick(1500)).toHaveLength(0);
    expect(pool.snapshot().inbox.length).toBe(1);

    // 到 deadline：返回待拒办，inbox 清空，列表态恢复到 running。
    const expired = pool.tick(2000);
    expect(expired.map((i) => i.id)).toEqual(["p1"]);
    expect(pool.snapshot().inbox.length).toBe(0);
    expect(pool.snapshot().sessions[0].listState).toBe("running");
  });

  it("resolveInbox 只摘待办，不做裁决（核心没有任何 allow 路径）", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.enqueuePermission({
      id: "p1",
      sessionId: "A",
      capabilityId: "kernel.git-probe",
      permission: "process.git",
      now: 0,
    });
    const item = pool.resolveInbox("p1");
    expect(item?.id).toBe("p1");
    expect(pool.snapshot().inbox.length).toBe(0);
    // 不存在的 id → null（不误摘别的）。
    expect(pool.resolveInbox("nope")).toBeNull();
  });

  it("重复入队同一权限不叠两条；resolveMatchingInbox 按能力/权限摘掉", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "T", workspaceId: "ws", origin: "task" });
    const req = {
      id: "task:t1:process.git",
      sessionId: "T",
      capabilityId: "coding.git",
      permission: "process.git",
      now: 0,
    };
    pool.enqueuePermission(req);
    pool.enqueuePermission(req);
    expect(pool.snapshot().inbox).toHaveLength(1);
    expect(
      pool.resolveMatchingInbox({
        capabilityId: "coding.git",
        permission: "process.git",
        workspaceId: "ws",
      })
    ).toBe(1);
    expect(pool.snapshot().inbox).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 关闭语义

describe("关闭语义：窗口关闭 ≠ 停止；应用退出才全停", () => {
  it("hasLiveSessions 供退出时让用户选择", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    expect(pool.hasLiveSessions()).toBe(false);
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    expect(pool.hasLiveSessions()).toBe(true);
    pool.shutdownAll();
    expect(pool.hasLiveSessions()).toBe(false);
    expect(pool.snapshot().sessions.every((s) => s.runState === "stopped")).toBe(true);
  });
});

// ---------------------------------------------------------------- 聚焦会话集成

describe("adoptRunning：纳入已在跑的会话，不重复派生进程", () => {
  it("登记已运行会话时不调 host.launch，且置为 focused", () => {
    const { host, calls } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.adoptRunning({ sessionId: "A", workspaceId: "ws", runtimeId: "rt-A-1", generation: 1 });
    expect(calls.filter((c) => c.op === "launch").length).toBe(0);
    expect(pool.snapshot().sessions[0].runState).toBe("focused");
  });

  it("不能把 child ownership 的同名记录改由前台 adopt", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "A", workspaceId: "ws", origin: "child" });
    expect(() =>
      pool.adoptRunning({
        sessionId: "A",
        workspaceId: "ws",
        runtimeId: "rt-foreground",
        generation: 1,
      })
    ).toThrow(/POOL_SESSION_OWNERSHIP_MISMATCH/);
  });

  it("空闲计时从纳入时刻起：刚纳入的会话不会被第一次 tick 立即回收（真机边界）", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host, timing: { idleToWarmMs: 1000 } });
    // 纳入并降为后台（有第二个前台把它挤下去）。
    pool.adoptRunning({ sessionId: "A", workspaceId: "ws", runtimeId: "rt-A-1", generation: 1 }, 10_000);
    pool.adoptRunning({ sessionId: "B", workspaceId: "ws", runtimeId: "rt-B-1", generation: 1 }, 10_000);
    // A 已是后台；此刻 tick（距纳入仅 500ms < 1000ms）不该回收 A。
    pool.tick(10_500);
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "A")!.runState).toBe("background");
    // 过了空闲阈值才回收。
    pool.tick(11_500);
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "A")!.runState).toBe("warm");
  });

  it("handleExit：expected-stop 不计崩溃预算，其它 reason 走崩溃预算", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.adoptRunning({ sessionId: "A", workspaceId: "ws", runtimeId: "rt-A-1", generation: 1 });
    pool.handleExit("A", "expected-stop", 1000);
    expect(pool.snapshot().sessions[0].runState).toBe("stopped");
    expect(pool.snapshot().sessions[0].crashCount).toBe(0);

    pool.adoptRunning({ sessionId: "B", workspaceId: "ws", runtimeId: "rt-B-1", generation: 1 });
    pool.handleExit("B", "crash", 2000);
    expect(pool.snapshot().sessions.find((s) => s.sessionId === "B")!.crashCount).toBe(1);
  });
});

describe("inheritPermissions 决定 sessionGrantPolicy", () => {
  it("user 默认 inherit；child/task 默认 workspace-only", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "U", workspaceId: "ws" });
    pool.requestSession({ sessionId: "C", workspaceId: "ws", origin: "child" });
    pool.requestSession({ sessionId: "T", workspaceId: "ws", origin: "task" });
    expect(pool.sessionGrantPolicy("U")).toBe("inherit");
    expect(pool.sessionGrantPolicy("C")).toBe("workspace-only");
    expect(pool.sessionGrantPolicy("T")).toBe("workspace-only");
  });

  it("isInboxCandidate：child/task 恒进 inbox，focused user 不进", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({ sessionId: "U", workspaceId: "ws", focus: true });
    pool.requestSession({ sessionId: "C", workspaceId: "ws", origin: "child" });
    pool.requestSession({ sessionId: "T", workspaceId: "ws", origin: "task" });
    expect(pool.isInboxCandidate("U")).toBe(false);
    expect(pool.isInboxCandidate("C")).toBe(true);
    expect(pool.isInboxCandidate("T")).toBe(true);
    expect(pool.isInboxCandidate("missing")).toBe(false);
  });

  it("显式 inheritPermissions=true 的 child 仍可 inherit", () => {
    const { host } = makeHost();
    const pool = new AgentPoolCore({ host });
    pool.requestSession({
      sessionId: "C",
      workspaceId: "ws",
      origin: "child",
      inheritPermissions: true,
    });
    expect(pool.sessionGrantPolicy("C")).toBe("inherit");
  });
});

// ---------------------------------------------------------------- 快照序号

describe("快照 sequence 单调递增（snapshot + sequence 订阅的对齐点）", () => {
  it("每次状态变更 sequence 严格 +1", () => {
    const { host } = makeHost();
    const seqs: number[] = [];
    const pool = new AgentPoolCore({ host, onChange: (s) => seqs.push(s.sequence) });
    pool.requestSession({ sessionId: "A", workspaceId: "ws" });
    pool.setFocused("A");
    pool.recordCost("A", 1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    // 信封复用 PiEnvelope：sequence 与快照一致，generation 固定。
    const env = pool.snapshotEnvelope();
    expect(env.sequence).toBe(pool.snapshot().sequence);
    expect(env.generation).toBe(1);
  });
});
