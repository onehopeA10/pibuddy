import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T1/T2 夹逼在三个落点上的接线对拍。
 *
 * 每个落点各问同一组问题，而且问法是可证伪的：
 *
 *   1. **正常路径**：账本上出现 `call → prepared → outcome_committed` 三行，
 *      且工具实现是在 `prepared` 已经落地之后才跑的。
 *   2. **T1 落不下去**：工具实现**一次都不跑**。这一条是整套机制的地基 ——
 *      「没有派发事实 ⇒ 断言 impl 没跑过」的反例只要存在一个，恢复流程就会
 *      把一次已经发生的副作用当成没发生，再做一遍。
 *   3. **tasks 的恢复判据**：崩在 T1 之前的 run 可以安全自动重跑；崩在 T1
 *      之后、T2 之前的 run 维持判死，并给出确切理由。
 *
 * 三个落点各自的执行面都用假实现（HA 出站 / 触发实现 / bridge 执行面），
 * 因为要测的是**夹逼的顺序**，不是那些实现自己的行为。
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-dispatch-wiring-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
}));

const { TaskStore } = await import("../src/main/tasks/task-store.js");
const { Scheduler } = await import("../src/main/tasks/scheduler.js");
const { ManualClock } = await import("../src/main/tasks/clock.js");
const { ToolRecoveryStore } = await import("../src/main/tool-recovery/recovery-store.js");
const { ToolDispatchBoundary } = await import("../src/main/tool-recovery/dispatch-guard.js");
const { toolFixture } = await import("../src/main/tool-recovery/ledger-fixtures.js");
const { HomeToolBridge, setBridgeDispatchGuard } = await import("../src/main/home/tool-bridge.js");
const { AutomationStore } = await import("../src/main/home-automation/automation-store.js");
const { AutomationService } = await import("../src/main/home-automation/automation-service.js");

import type { AgentRunTrigger } from "../src/main/tasks/task-trigger.js";
import type { NewTask } from "../src/main/tasks/task-store.js";
import type {
  ToolDispatchLedger,
  ToolDispatchRequest,
} from "../src/main/tool-recovery/dispatch-guard.js";
import type {
  AutomationHomePort,
  AutomationTaskPort,
} from "../src/main/home-automation/automation-service.js";
import type { HomeBridgeDispatchGuard } from "../src/main/home/tool-bridge.js";

let dir: string;
let ledger: InstanceType<typeof ToolRecoveryStore>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-dispatch-case-"));
  ledger = new ToolRecoveryStore(path.join(dir, "tool-recovery.db"));
});

afterEach(() => {
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** T1 恒失败的账本：用来证明「T1 没成功 ⇒ 实现零调用」。 */
function brokenLedger(): ToolDispatchLedger {
  return {
    readLedger: (workspaceId) => ledger.readLedger(workspaceId),
    commitToolPrepared: () => Promise.reject(new Error("账本写不进去")),
    commitToolOutcome: () => Promise.reject(new Error("不该走到这里")),
  };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: 等待超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------- tasks

const baseTask: NewTask = {
  workspaceId: "ws1",
  name: "夜间备份",
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

function countingTrigger(counter: { calls: number }): AgentRunTrigger {
  return {
    async trigger() {
      counter.calls += 1;
      return {
        status: "succeeded",
        sessionId: null,
        artifactIds: [],
        costUsd: null,
        error: null,
        note: "stub ok",
      };
    },
  };
}

describe("落点一：tasks 的 run —— 崩溃恢复第一次有了判据", () => {
  let tasks: InstanceType<typeof TaskStore>;
  const now = 1_800_000_000_000;

  beforeEach(() => {
    tasks = new TaskStore(path.join(dir, "tasks.db"));
  });
  afterEach(() => tasks.close());

  function scheduler(counter: { calls: number }, ledgerImpl: ToolDispatchLedger = ledger) {
    const clock = new ManualClock(now);
    return new Scheduler({
      store: tasks,
      clock,
      trigger: () => countingTrigger(counter),
      workspaceGrants: () => [],
      recovery: {
        boundary: new ToolDispatchBoundary(ledgerImpl, () => clock.now()),
        ledger: ledgerImpl,
      },
    });
  }

  /** 造一条孤儿 run（lease 已过期），并把它的开始时刻钉在 `startedAt`。 */
  function orphanRun(taskId: string, key: string, startedAt: number): string {
    const run = tasks.createRun({
      taskId,
      workspaceId: "ws1",
      scheduledFor: 1,
      idempotencyKey: key,
      attempt: 1,
      input: baseTask.agent,
      status: "running",
      now,
    })!;
    tasks.updateRun(run.id, { startedAt, leaseOwner: "dead", leaseExpiresAt: now - 1 });
    return run.id;
  }

  it("正常执行：触发实现跑在 prepared 之后，收尾后账本三行齐全", async () => {
    const counter = { calls: 0 };
    const task = tasks.createTask(baseTask, now, null);
    await scheduler(counter).runNow(task);

    expect(counter.calls).toBe(1);
    expect(ledger.readJournal("ws1").map((row) => row.state)).toEqual([
      "call",
      "prepared",
      "outcome_committed",
    ]);
  });

  it("T1 落不下去 ⇒ 触发实现零调用，run 判失败", async () => {
    const counter = { calls: 0 };
    const task = tasks.createTask(baseTask, now, null);
    const run = await scheduler(counter, brokenLedger()).runNow(task);

    // 这一条就是「没有派发事实 ⇒ impl 没跑过」这个断言的护身符。
    expect(counter.calls).toBe(0);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("派发事实落地失败");
  });

  it("崩在 T1 之前（账本已盖章、查无此条）→ 判定可安全自动重跑，并真的重跑", async () => {
    const counter = { calls: 0 };
    const task = tasks.createTask(baseTask, now, null);
    // 先跑一次真实的 run：它把协议标记盖在这个工作区账本的首位。
    await scheduler(counter).runNow(task);
    expect(counter.calls).toBe(1);

    const markerTs = ledger.readLedger("ws1")[0]!.ts;
    const orphan = orphanRun(task.id, "orphan-before-t1", markerTs + 1);

    const sched = scheduler(counter);
    expect(sched.recover(now)).toBe(1);
    await until(() => tasks.getRun(orphan)?.status === "succeeded");
    // 自动重跑真的发生了（而不是只把状态改了改）。
    expect(counter.calls).toBe(2);
    expect(tasks.getRun(orphan)?.log.join("\n")).toContain("自动重跑");
  });

  it("崩在 T1 之后、T2 之前 → 维持判死，并把确切理由写进 run", async () => {
    const counter = { calls: 0 };
    const task = tasks.createTask(baseTask, now, null);
    await scheduler(counter).runNow(task); // 盖章
    const orphan = orphanRun(task.id, "orphan-after-t1", now);

    // 造出「派发事实已落地、结算事实没落地」的账本状态。
    const crashed = toolFixture({
      workspaceId: "ws1",
      invocationId: `task-run:${orphan}`,
      providerToolCallId: "attempt-1",
      withProtocolMarker: false,
    });
    await ledger.commitToolPrepared(crashed.preparedCommit());

    const sched = scheduler(counter);
    expect(sched.recover(now)).toBe(1);
    const run = tasks.getRun(orphan);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("派发事实已经落地但没有结算");
    // 关键：没有自动重跑（那次可能已经产生过副作用）。
    expect(counter.calls).toBe(1);
  });

  it("未接账本时行为与从前一字不变：孤儿 run 一律判死", () => {
    const task = tasks.createTask(baseTask, now, null);
    const orphan = orphanRun(task.id, "orphan-no-ledger", now);
    const clock = new ManualClock(now);
    const sched = new Scheduler({
      store: tasks,
      clock,
      trigger: () => countingTrigger({ calls: 0 }),
      workspaceGrants: () => [],
    });
    expect(sched.recover(now)).toBe(1);
    expect(tasks.getRun(orphan)?.status).toBe("failed");
    expect(tasks.getRun(orphan)?.error).toContain("进程中断");
  });
});

// ------------------------------------------------------- home.automation

describe("落点二：home.automation 的确定性动作 —— 开灯关锁不许做两遍", () => {
  let store: InstanceType<typeof AutomationStore>;

  beforeEach(() => {
    store = new AutomationStore(path.join(dir, "automation.db"));
  });
  afterEach(() => store.close());

  function homePort(calls: string[], fail = false): AutomationHomePort {
    return {
      async callService(_workspaceId, args) {
        if (fail) throw new Error("端点拒绝");
        calls.push(`${args.domain}.${args.service}`);
      },
      async getStates() {
        return [];
      },
      onStateChanged() {
        return () => {};
      },
      acquireConsumer() {
        return () => {};
      },
    };
  }

  const noTasks: AutomationTaskPort = {
    ensureTask: () => "task-x",
    deleteTask: () => {},
    deliver: async () => {},
  };

  function service(calls: string[], ledgerImpl: ToolDispatchLedger = ledger, fail = false) {
    return new AutomationService({
      store,
      home: homePort(calls, fail),
      tasks: noTasks,
      recovery: new ToolDispatchBoundary(ledgerImpl, () => Date.now()),
    });
  }

  function lightRule(svc: InstanceType<typeof AutomationService>): void {
    svc.upsert("ws-auto", null, {
      name: "回家开灯",
      trigger: { kind: "state", entityId: "binary_sensor.door", to: "on" },
      actions: [{ kind: "service", domain: "light", service: "turn_on", entityId: "light.a" }],
      timezone: "Asia/Shanghai",
    });
  }

  it("命中执行：动作跑在 prepared 之后，账本三行齐全", async () => {
    const calls: string[] = [];
    const svc = service(calls);
    lightRule(svc);
    svc.__engine("ws-auto")!.handleStateChanged({ entityId: "binary_sensor.door", state: "on" });

    await until(() => calls.length === 1);
    expect(calls).toEqual(["light.turn_on"]);
    expect(ledger.readJournal("ws-auto").map((row) => row.state)).toEqual([
      "call",
      "prepared",
      "outcome_committed",
    ]);
    svc.dispose();
  });

  it("T1 落不下去 ⇒ 一个字节都不出站，规则记下失败", async () => {
    const calls: string[] = [];
    const svc = service(calls, brokenLedger());
    lightRule(svc);
    svc.__engine("ws-auto")!.handleStateChanged({ entityId: "binary_sensor.door", state: "on" });

    await until(() => svc.list("ws-auto")[0]?.lastFiredAt !== null);
    expect(calls).toEqual([]);
    expect(svc.list("ws-auto")[0]?.lastError).toContain("派发事实落地失败");
    svc.dispose();
  });
});

// ------------------------------------------------------------ tool bridge

describe("落点三：tool bridge 的派发路径", () => {
  let bridge: InstanceType<typeof HomeToolBridge> | null = null;

  afterEach(async () => {
    setBridgeDispatchGuard(null);
    await bridge?.stop();
    bridge = null;
  });

  function guardOn(ledgerImpl: ToolDispatchLedger): HomeBridgeDispatchGuard {
    const boundary = new ToolDispatchBoundary(ledgerImpl, () => Date.now());
    let seq = 0;
    return (request, impl) => {
      const dispatch: ToolDispatchRequest = {
        workspaceId: "ws-bridge",
        sessionId: "bridge-session",
        invocationId: "bridge-invocation",
        runId: "bridge-run",
        turnId: "bridge",
        providerToolCallId: `req-${++seq}`,
        toolName: request.tool,
        args: request.args ?? null,
      };
      return boundary.run(dispatch, impl);
    };
  }

  /** 发一行请求、收一行响应（bridge 的线协议就是这么简单）。 */
  function call(
    pipePath: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(pipePath, () => {
        socket.write(`${JSON.stringify({ token, ...body })}\n`);
      });
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        socket.end();
        resolve(JSON.parse(line) as { ok: boolean; result?: unknown; error?: string });
      });
      socket.on("error", reject);
    });
  }

  it("正常路径：执行面跑在 prepared 之后，回包之前账本已经结算", async () => {
    const seen: string[] = [];
    bridge = new HomeToolBridge(async () => {
      seen.push(...ledger.readJournal("ws-bridge").map((row) => row.state));
      return { ok: 1 };
    });
    const pipePath = await bridge.start();
    setBridgeDispatchGuard(guardOn(ledger));

    const response = await call(pipePath, bridge.__token(), {
      id: 1,
      tool: "home.call_service",
      args: { domain: "light", service: "turn_on" },
      cwd: "/w",
    });
    expect(response.ok).toBe(true);
    // 执行面看到的账本：call + prepared 已在，结算还没落（④ 的顺序）。
    expect(seen).toEqual(["call", "prepared"]);
    // 回包时结算已经落地。
    expect(ledger.readJournal("ws-bridge").map((row) => row.state)).toEqual([
      "call",
      "prepared",
      "outcome_committed",
    ]);
  });

  it("T1 落不下去 ⇒ 执行面零调用，回包是失败", async () => {
    let calls = 0;
    bridge = new HomeToolBridge(async () => {
      calls += 1;
      return { ok: 1 };
    });
    const pipePath = await bridge.start();
    setBridgeDispatchGuard(guardOn(brokenLedger()));

    const response = await call(pipePath, bridge.__token(), {
      id: 2,
      tool: "home.call_service",
      args: {},
      cwd: "/w",
    });
    expect(calls).toBe(0);
    expect(response.ok).toBe(false);
    expect(response.error).toContain("派发事实落地失败");
  });

  it("没装闸时行为与从前一字不变（零账本行、正常回包）", async () => {
    bridge = new HomeToolBridge(async () => ({ ok: 1 }));
    const pipePath = await bridge.start();

    const response = await call(pipePath, bridge.__token(), {
      id: 3,
      tool: "home.call_service",
      args: {},
      cwd: "/w",
    });
    expect(response).toMatchObject({ ok: true, result: { ok: 1 } });
    expect(ledger.readJournal("ws-bridge")).toHaveLength(0);
  });
});
