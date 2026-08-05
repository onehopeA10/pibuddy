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
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  return new Scheduler({
    store,
    clock,
    trigger: () => opts.trigger ?? okTrigger,
    workspaceGrants: () => opts.grants ?? [],
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
}

/** 恒失败的触发实现：`fail` 决定这一次以什么形态失败。 */
function failingTrigger(fail: () => never | Promise<never>): AgentRunTrigger {
  return { async trigger() { return fail(); } };
}

/** 抛出一个带 provider 证据字段的错误（statusCode / responseHeaders）。 */
function providerError(message: string, fields: Record<string, unknown> = {}): never {
  throw Object.assign(new Error(message), fields);
}

const RETRY_3: NewTask["failurePolicy"] = { retry: true, maxAttempts: 3, backoffMs: 0 };

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

/**
 * MDL-101 接线：任务级重试改成**按错误类别**决策。
 *
 * 从前这里只认「maxAttempts 用完没有」，于是 401 / 402 / 上下文溢出都要把三次
 * 尝试烧完才收尾 —— 三次全都必然再失败。下面每一条都断言**没有耗尽 maxAttempts**
 * （`attempt` 停在 1），而不只是断言最终 failed：只断言 failed 的话，把判据拆掉
 * 恢复成照常重试，用例依然全绿。
 */
describe("按错误类别决策：不可重试的类别当场停，不耗尽 maxAttempts", () => {
  const CASES: { name: string; fail: () => never; hint: string }[] = [
    {
      name: "auth（401）：改 key 才有用",
      fail: () => providerError("Unauthorized", { statusCode: 401 }),
      hint: "Provider 中心",
    },
    {
      name: "provider_billing（402）：充值才有用",
      fail: () => providerError("Insufficient credits", { statusCode: 402 }),
      hint: "充值",
    },
    {
      name: "context_overflow：重试必然再溢出",
      fail: () => providerError("prompt is too long: 213462 tokens > 200000 maximum"),
      hint: "上下文窗口",
    },
  ];

  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const now = Date.now();
      const t = store.createTask({ ...baseTask, failurePolicy: RETRY_3 }, now, null);
      const sched = makeScheduler(new ManualClock(now), {
        trigger: failingTrigger(testCase.fail),
      });
      const run = await sched.runNow(t);

      expect(run?.status).toBe("failed");
      // 核心断言：**没有**耗尽 maxAttempts（3 次），第一次就停了
      expect(run?.attempt).toBe(1);
      expect(run?.log.join(" ")).not.toContain("已达最大尝试次数");
      expect(run?.log.join(" ")).not.toContain("将重试");
      // 停下来的理由必须可操作
      expect(run?.error).toContain(testCase.hint);
    });
  }

  it("对照：分不出类别的失败沿用用户的 failurePolicy，照样重试到 maxAttempts", async () => {
    const now = Date.now();
    const t = store.createTask({ ...baseTask, failurePolicy: RETRY_3 }, now, null);
    const sched = makeScheduler(new ManualClock(now), {
      trigger: failingTrigger(() => providerError("触发实现自己炸了")),
    });
    const run = await sched.runNow(t);
    expect(run?.status).toBe("failed");
    expect(run?.attempt).toBe(3);
    expect(run?.log.join(" ")).toContain("已达最大尝试次数");
  });
});

describe("退避：指数 + 抖动取代固定 backoffMs，retry-after 优先", () => {
  it("network 类：两次退避落在 1000~1250 / 2000~2500（指数 + 25% 抖动上界）", async () => {
    const now = Date.now();
    // backoffMs 故意设成一个显眼的固定值：它不该再出现在退避里
    const t = store.createTask(
      { ...baseTask, failurePolicy: { retry: true, maxAttempts: 3, backoffMs: 777 } },
      now,
      null
    );
    const waited: number[] = [];
    const sched = makeScheduler(new ManualClock(now), {
      trigger: failingTrigger(() => providerError("fetch failed")),
      sleep: async (ms) => { waited.push(ms); },
    });
    const run = await sched.runNow(t);

    expect(run?.attempt).toBe(3);
    expect(waited.length).toBe(2);
    expect(waited[0]).toBeGreaterThanOrEqual(1000);
    expect(waited[0]).toBeLessThanOrEqual(1250);
    expect(waited[1]).toBeGreaterThanOrEqual(2000);
    expect(waited[1]).toBeLessThanOrEqual(2500);
    expect(waited).not.toContain(777);
  });

  it("服务端给了 retry-after 就用它，不用本地曲线", async () => {
    const now = Date.now();
    const t = store.createTask({ ...baseTask, failurePolicy: RETRY_3 }, now, null);
    const waited: number[] = [];
    const sched = makeScheduler(new ManualClock(now), {
      trigger: failingTrigger(() =>
        providerError("Too Many Requests", {
          statusCode: 429,
          responseHeaders: { "retry-after": "7" },
        })
      ),
      sleep: async (ms) => { waited.push(ms); },
    });
    await sched.runNow(t);
    // 7 秒，逐点相等——本地曲线在这两步分别是 ~1000 / ~2000，混不进来
    expect(waited).toEqual([7_000, 7_000]);
  });
});

describe("四条合取前置条件里的另外两条", () => {
  it("本次尝试已产生可见输出（assistant 说过话）→ 不重试", async () => {
    const now = Date.now();
    const t = store.createTask({ ...baseTask, failurePolicy: RETRY_3 }, now, null);
    const spoke: AgentRunTrigger = {
      async trigger() {
        return {
          status: "failed", sessionId: "sess-1", artifactIds: [], costUsd: null,
          error: "助手回复以错误结束（stopReason=error）", note: "跑过了但以错误收场",
          observableOutput: true,
        };
      },
    };
    const sched = makeScheduler(new ManualClock(now), { trigger: spoke });
    const run = await sched.runNow(t);
    expect(run?.status).toBe("failed");
    expect(run?.attempt).toBe(1);
    expect(run?.error).toContain("已经产出过可见结果");
  });

  it("同样的失败但一个字都没说出去 → 照常重试（可见输出这一条真的在起作用）", async () => {
    const now = Date.now();
    const t = store.createTask({ ...baseTask, failurePolicy: RETRY_3 }, now, null);
    const silent: AgentRunTrigger = {
      async trigger() {
        return {
          status: "failed", sessionId: "sess-1", artifactIds: [], costUsd: null,
          error: "提示词投递失败：会话无活跃 runtime", note: "deliver 落空",
          observableOutput: false,
        };
      },
    };
    const sched = makeScheduler(new ManualClock(now), { trigger: silent });
    const run = await sched.runNow(t);
    expect(run?.attempt).toBe(3);
  });

  it("预算已用尽 → 不再消耗剩余的重试次数", async () => {
    const now = Date.now();
    const t = store.createTask(
      { ...baseTask, budgetUsd: 0.5, failurePolicy: RETRY_3 },
      now,
      null
    );
    const pricey: AgentRunTrigger = {
      async trigger() {
        return {
          status: "failed", sessionId: null, artifactIds: [], costUsd: 0.8,
          error: "跑完了但失败", note: "花了钱的失败",
        };
      },
    };
    const sched = makeScheduler(new ManualClock(now), { trigger: pricey });
    const run = await sched.runNow(t);
    expect(run?.attempt).toBe(1);
    expect(run?.error).toContain("预算已用尽");
  });
});

describe("nextRunAfter 供 create/resume 复用", () => {
  it("daily 09:00 上海从 08:00 起算下一次是 01:00 UTC", () => {
    const from = Date.UTC(2026, 5, 1, 0, 0, 0);
    const schedule: TaskSchedule = { kind: "daily", time: "09:00" };
    expect(nextRunAfter({ schedule, timezone: "Asia/Shanghai" }, from)).toBe(Date.UTC(2026, 5, 1, 1, 0, 0));
  });
});
