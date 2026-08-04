import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 触发 Agent run 的**契约测试**（FEAT-tasks.md §4 / §8-1「触发未接后台池」）。
 *
 * 后台池的真实后台派生本身也尚未落地（agent-pool/pool.ts：launch 走记账占位），
 * 因此现在把 tasks 接到池上只是 stub 接 stub、徒增耦合。诚实的做法是：把
 * `AgentRunTrigger` 这个可注入窄接口的**形状**用替身钉死——一旦后台池（或任何
 * 真实触发）就位，只要它按此接口返回 sessionId / artifactIds / costUsd / error，
 * scheduler 就会把这些字段正确落进 run 记录。这样「接真实凭据/后台池时的形状」
 * 现在就测对了，替换实现时 scheduler 一行不动（task-trigger.ts 的设计承诺）。
 *
 * ## 可证伪
 *
 * 断言的是 run 记录里**具体的** sessionId / cost / artifact / 状态 / 错误，以及
 * 触发时拿到的**冻结输入快照**，不是「trigger 被调用了」。
 */

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

const { TaskStore } = await import("../src/main/tasks/task-store.js");
const { Scheduler } = await import("../src/main/tasks/scheduler.js");
const { ManualClock } = await import("../src/main/tasks/clock.js");
import type { AgentRunTrigger, TriggerContext } from "../src/main/tasks/task-trigger.js";
import type { NewTask } from "../src/main/tasks/task-store.js";

let dir: string;
let store: InstanceType<typeof TaskStore>;

const baseTask: NewTask = {
  workspaceId: "ws1",
  name: "t",
  schedule: { kind: "daily", time: "09:00" },
  timezone: "Asia/Shanghai",
  agent: { provider: "openai", model: "gpt-x", prompt: "巡检一次" },
  requiredPermissions: [],
  budgetUsd: 5,
  timeoutMs: 30_000,
  misfirePolicy: "skip",
  concurrencyPolicy: "forbid",
  failurePolicy: { retry: false, maxAttempts: 1, backoffMs: 0 },
};

function makeScheduler(clock: InstanceType<typeof ManualClock>, trigger: AgentRunTrigger) {
  return new Scheduler({ store, clock, trigger: () => trigger, workspaceGrants: () => [] });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-trig-"));
  store = new TaskStore(path.join(dir, "tasks.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentRunTrigger 契约：真实触发的产出如实落进 run 记录", () => {
  it("成功 outcome 的 sessionId / artifactIds / costUsd 原样落库", async () => {
    const now = Date.UTC(2026, 5, 1, 1, 0, 0);
    const task = store.createTask(baseTask, now, now);
    const realish: AgentRunTrigger = {
      async trigger() {
        return {
          status: "succeeded",
          sessionId: "sess-real-42",
          artifactIds: ["art-1", "art-2"],
          costUsd: 0.031,
          error: null,
          note: "后台会话完成",
        };
      },
    };
    const run = await makeScheduler(new ManualClock(now), realish).runNow(task);

    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");
    expect(run!.sessionId).toBe("sess-real-42");
    expect(run!.artifactIds).toEqual(["art-1", "art-2"]);
    expect(run!.costUsd).toBe(0.031);
  });

  it("失败 outcome 的 error 落库、状态为 failed（不谎称成功）", async () => {
    const now = Date.UTC(2026, 5, 1, 1, 0, 0);
    const task = store.createTask(baseTask, now, now);
    const failing: AgentRunTrigger = {
      async trigger() {
        return {
          status: "failed",
          sessionId: null,
          artifactIds: [],
          costUsd: null,
          error: "上游模型 503",
          note: "触发失败",
        };
      },
    };
    const run = await makeScheduler(new ManualClock(now), failing).runNow(task);
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("上游模型 503");
  });

  it("触发时拿到的是**冻结的输入快照**（provider/model/prompt）+ 预算/超时", async () => {
    const now = Date.UTC(2026, 5, 1, 1, 0, 0);
    const task = store.createTask(baseTask, now, now);
    let seen: TriggerContext | null = null;
    const capture: AgentRunTrigger = {
      async trigger(ctx) {
        seen = ctx;
        return { status: "succeeded", sessionId: null, artifactIds: [], costUsd: null, error: null, note: "ok" };
      },
    };
    await makeScheduler(new ManualClock(now), capture).runNow(task);

    expect(seen).not.toBeNull();
    expect(seen!.input).toEqual({ provider: "openai", model: "gpt-x", prompt: "巡检一次" });
    expect(seen!.budgetUsd).toBe(5);
    expect(seen!.timeoutMs).toBe(30_000);
    expect(seen!.taskId).toBe(task.id);
    expect(seen!.workspaceId).toBe("ws1");
  });

  it("触发实现抛异常 → run 判为 failed，不外泄为未捕获错误", async () => {
    const now = Date.UTC(2026, 5, 1, 1, 0, 0);
    const task = store.createTask(baseTask, now, now);
    const thrower: AgentRunTrigger = {
      async trigger() {
        throw new Error("触发内部炸了");
      },
    };
    const run = await makeScheduler(new ManualClock(now), thrower).runNow(task);
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("触发内部炸了");
  });
});
