import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 调度器核心的可证伪测试：lease / idempotency / 并发策略 / 崩溃恢复 /
 * pause-runNow-cancel-retry。
 *
 * 全部用 `ManualClock` 制造时序、用一个可控 `AgentRunTrigger` 制造成功 / 失败，
 * 断言的是**具体的 run 状态与条数**，不是「函数被调用了」。
 */

// task-store.ts 顶层 import electron 只为默认 dbPath；测试直接 new TaskStore(file)
// 绕过它，因此给一个最小桩即可。
vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

const { TaskStore } = await import("../src/main/tasks/task-store.js");
const { Scheduler, nextRunAfter } = await import("../src/main/tasks/scheduler.js");
const { ManualClock } = await import("../src/main/tasks/clock.js");
import type { AgentRunTrigger } from "../src/main/tasks/task-trigger.js";
import type { CapabilityGrant, TaskSchedule } from "@pibuddy/contract";
import type { NewTask } from "../src/main/tasks/task-store.js";

let dir: string;
let store: InstanceType<typeof TaskStore>;

function tmpDb(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-tasks-"));
  return path.join(dir, "tasks.db");
}

const baseTask: NewTask = {
  workspaceId: "ws1",
  name: "t",
  schedule: { kind: "daily", time: "09:00" },
  timezone: "Asia/Shanghai",
  agent: { provider: "openai", model: "gpt", prompt: "hi" },
  requiredPermissions: [],
  budgetUsd: null,
  timeoutMs: null,
  misfirePolicy: "skip",
  concurrencyPolicy: "forbid",
  failurePolicy: { retry: false, maxAttempts: 1, backoffMs: 0 },
};

const okTrigger: AgentRunTrigger = {
  async trigger() {
    return { status: "succeeded", sessionId: null, artifactIds: [], costUsd: null, error: null, note: "stub ok" };
  },
};

function makeScheduler(clock: InstanceType<typeof ManualClock>, opts: {
  trigger?: AgentRunTrigger;
  grants?: CapabilityGrant[];
} = {}) {
  return new Scheduler({
    store,
    clock,
    trigger: () => opts.trigger ?? okTrigger,
    workspaceGrants: () => opts.grants ?? [],
  });
}

beforeEach(() => {
  store = new TaskStore(tmpDb());
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("idempotency：同一墙钟槽位绝不重复执行", () => {
  it("对同一槽位触发两次，只产生一条 run（UNIQUE 约束兜底）", async () => {
    const slot = Date.UTC(2026, 5, 1, 1, 0, 0);
    const now = slot + 5000; // 准点（grace 窗口内），skip 也会触发
    const clock = new ManualClock(now);
    const t = store.createTask(baseTask, now, slot);
    const sched = makeScheduler(clock);

    await sched.tick(now);
    // 人为把 nextRunAt 拨回同一个已跑过的槽位（模拟时钟回拨 / 调度 bug）。
    store.updateTask(t.id, { nextRunAt: slot }, now);
    await sched.tick(now);

    const runsForSlot = store.listRuns(t.id).filter((r) => r.scheduledFor === slot);
    expect(runsForSlot.length).toBe(1);
  });

  it("对拍：createRun 同 key 第二次返回 null（拆掉它就会重复执行）", () => {
    const now = Date.now();
    const t = store.createTask(baseTask, now, null);
    const first = store.createRun({
      taskId: t.id, workspaceId: "ws1", scheduledFor: 100, idempotencyKey: "k#1",
      attempt: 1, input: baseTask.agent, status: "pending", now,
    });
    const second = store.createRun({
      taskId: t.id, workspaceId: "ws1", scheduledFor: 100, idempotencyKey: "k#1",
      attempt: 1, input: baseTask.agent, status: "pending", now,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe("并发策略", () => {
  it("forbid：上一次还在跑，本槽位记为 skipped 而不是又开一个", async () => {
    const slot = Date.UTC(2026, 5, 1, 1, 0, 0);
    const now = slot + 5000; // 准点，让槽位真的进到并发判定
    const clock = new ManualClock(now);
    const t = store.createTask({ ...baseTask, concurrencyPolicy: "forbid" }, now, slot);
    // 手动塞一条「还在跑」的 run，制造 hasActiveRun。
    store.createRun({
      taskId: t.id, workspaceId: "ws1", scheduledFor: now - 10000, idempotencyKey: "inflight",
      attempt: 1, input: baseTask.agent, status: "running", now,
    });
    const sched = makeScheduler(clock);
    await sched.tick(now);

    const run = store.listRuns(t.id).find((r) => r.scheduledFor === slot);
    expect(run?.status).toBe("skipped");
    expect(run?.error).toContain("并发被禁止");
  });
});

describe("崩溃恢复：孤儿 run（lease 过期）被判死，不盲目重跑", () => {
  it("running 且 lease 过期的 run → failed", () => {
    const now = 1_000_000;
    const t = store.createTask(baseTask, now, null);
    const run = store.createRun({
      taskId: t.id, workspaceId: "ws1", scheduledFor: 1, idempotencyKey: "orphan",
      attempt: 1, input: baseTask.agent, status: "running", now,
    })!;
    // lease 已过期（很久以前）。
    store.updateRun(run.id, { leaseOwner: "dead", leaseExpiresAt: now - 1 });

    const clock = new ManualClock(now);
    const sched = makeScheduler(clock);
    const recovered = sched.recover(now);

    expect(recovered).toBe(1);
    expect(store.getRun(run.id)?.status).toBe("failed");
    expect(store.getRun(run.id)?.error).toContain("进程中断");
  });

  it("lease 未过期的 running run 不被判死", () => {
    const now = 1_000_000;
    const t = store.createTask(baseTask, now, null);
    const run = store.createRun({
      taskId: t.id, workspaceId: "ws1", scheduledFor: 1, idempotencyKey: "alive",
      attempt: 1, input: baseTask.agent, status: "running", now,
    })!;
    store.updateRun(run.id, { leaseOwner: "me", leaseExpiresAt: now + 100000 });

    const sched = makeScheduler(new ManualClock(now));
    expect(sched.recover(now)).toBe(0);
    expect(store.getRun(run.id)?.status).toBe("running");
  });
});

describe("pause / run-now / cancel / retry", () => {
  it("runNow 立即产生一条 run 并跑成功（stub）", async () => {
    const now = Date.now();
    const t = store.createTask(baseTask, now, null);
    const sched = makeScheduler(new ManualClock(now));
    const run = await sched.runNow(t);
    expect(run?.status).toBe("succeeded");
    expect(run?.sessionId).toBeNull();
    expect(run?.attempt).toBe(1);
    expect(run?.log.join(" ")).toContain("开始执行");
  });

  it("cancelRun 把 pending 的 run 置为 cancelled", () => {
    const now = Date.now();
    const t = store.createTask(baseTask, now, null);
    const run = store.createRun({
      taskId: t.id, workspaceId: "ws1", scheduledFor: 1, idempotencyKey: "p",
      attempt: 1, input: baseTask.agent, status: "pending", now,
    })!;
    const sched = makeScheduler(new ManualClock(now));
    const after = sched.cancelRun(run.id);
    expect(after?.status).toBe("cancelled");
  });

  it("retryRun 建一条新 run（attempt+1、新 key），不撞原槽位的幂等键", async () => {
    const now = Date.now();
    const t = store.createTask(baseTask, now, null);
    const failed = store.createRun({
      taskId: t.id, workspaceId: "ws1", scheduledFor: 500, idempotencyKey: `${t.id}#500`,
      attempt: 1, input: baseTask.agent, status: "failed", now,
    })!;
    const sched = makeScheduler(new ManualClock(now));
    const retried = await sched.retryRun(failed.id);
    expect(retried).not.toBeNull();
    expect(retried!.id).not.toBe(failed.id);
    expect(retried!.attempt).toBe(2);
    expect(retried!.status).toBe("succeeded");
  });

  it("paused 任务的 tick 不触发（nextRunAt 为 null）", async () => {
    const now = Date.UTC(2026, 5, 1, 2, 0, 0);
    const t = store.createTask({ ...baseTask, misfirePolicy: "catch-up" }, now, Date.UTC(2026, 5, 1, 1, 0, 0));
    store.updateTask(t.id, { status: "paused", nextRunAt: null }, now);
    const sched = makeScheduler(new ManualClock(now));
    await sched.tick(now);
    expect(store.listRuns(t.id).length).toBe(0);
  });
});

describe("失败重试（同一条 run 上递增 attempt）", () => {
  it("always-fail + maxAttempts 3 → 最终 failed、attempt=3", async () => {
    const now = Date.now();
    const t = store.createTask(
      { ...baseTask, failurePolicy: { retry: true, maxAttempts: 3, backoffMs: 0 } },
      now,
      null
    );
    const failTrigger: AgentRunTrigger = {
      async trigger() {
        return { status: "failed", sessionId: null, artifactIds: [], costUsd: null, error: "boom", note: "fail" };
      },
    };
    const sched = makeScheduler(new ManualClock(now), { trigger: failTrigger });
    const run = await sched.runNow(t);
    expect(run?.status).toBe("failed");
    expect(run?.attempt).toBe(3);
  });

  it("fail-once-then-succeed → succeeded、attempt=2", async () => {
    const now = Date.now();
    const t = store.createTask(
      { ...baseTask, failurePolicy: { retry: true, maxAttempts: 3, backoffMs: 0 } },
      now,
      null
    );
    let n = 0;
    const flaky: AgentRunTrigger = {
      async trigger() {
        n++;
        return n === 1
          ? { status: "failed", sessionId: null, artifactIds: [], costUsd: null, error: "once", note: "f" }
          : { status: "succeeded", sessionId: null, artifactIds: [], costUsd: null, error: null, note: "ok" };
      },
    };
    const sched = makeScheduler(new ManualClock(now), { trigger: flaky });
    const run = await sched.runNow(t);
    expect(run?.status).toBe("succeeded");
    expect(run?.attempt).toBe(2);
  });
});

describe("nextRunAfter 供 create/resume 复用", () => {
  it("daily 09:00 上海从 08:00 起算下一次是 01:00 UTC", () => {
    const from = Date.UTC(2026, 5, 1, 0, 0, 0);
    const schedule: TaskSchedule = { kind: "daily", time: "09:00" };
    expect(nextRunAfter({ schedule, timezone: "Asia/Shanghai" }, from)).toBe(Date.UTC(2026, 5, 1, 1, 0, 0));
  });
});
