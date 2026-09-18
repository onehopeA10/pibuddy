import os from "node:os";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

import type { AgentEvent } from "@pibuddy/pi-sdk";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { createPoolRunTrigger } = await import("../src/main/tasks/pool-run-trigger.js");
const { AgentPoolCore } = await import("../src/main/agent-pool/pool-core.js");
import type { PoolTriggerPort } from "../src/main/tasks/pool-run-trigger.js";
import type { RuntimeTap } from "../src/main/agent-pool/pool-runtime-host.js";
import type { TriggerContext } from "../src/main/tasks/task-trigger.js";

/**
 * 池化触发实现（ISS-002）的可证伪判据：断言的是**具体的** sessionId / cost /
 * 状态 / 错误与「会话真的被申请、真的被停掉」，不是「trigger 被调用了」。
 *
 * 对拍方向：把 pool-run-trigger 里 `port.requestSession(...)` 一行拆掉（不真
 * 派生），全部用例卡在 ready 上（timeout 用例外）；把 finally 里的
 * `port.stopSession` 拆掉，「无论成败都停会话」的断言变红。
 */

class FakePort implements PoolTriggerPort {
  tap: RuntimeTap | null = null;
  requested: unknown[] = [];
  stopped: string[] = [];
  delivered: Array<{ sessionId: string; text: string }> = [];
  sent: Array<{ sessionId: string; message: unknown }> = [];
  deliverResult = true;
  sendImpl: (message: unknown) => Promise<unknown> = async (message) => {
    const type = (message as { type?: string }).type;
    if (type === "get_session_stats") return { success: true, data: { cost: 0.12 } };
    return { success: true };
  };

  requestSession(input: unknown): void {
    this.requested.push(input);
  }
  stopSession(sessionId: string): void {
    this.stopped.push(sessionId);
  }
  observe(_sessionId: string, tap: RuntimeTap): () => void {
    this.tap = tap;
    return () => {
      this.tap = null;
    };
  }
  deliver(sessionId: string, text: string): boolean {
    this.delivered.push({ sessionId, text });
    return this.deliverResult;
  }
  send(sessionId: string, message: unknown): Promise<unknown> {
    this.sent.push({ sessionId, message });
    return this.sendImpl(message);
  }
}

/**
 * 单测一律显式注入用量入账口：默认入账实现写的是真实 SQLite 文件，让它在
 * 单测里落盘既慢又会在 tmpdir 留渣。要断言入账行为的用例注入 capture。
 */
const noRecord = (): void => {};

function ctxOf(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    runId: "run-1",
    taskId: "t1",
    workspaceId: "ws1",
    signal: new AbortController().signal,
    input: { provider: "openai", model: "gpt-x", prompt: "巡检一次" },
    timeoutMs: null,
    budgetUsd: null,
    ...overrides,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("池化 Agent run 触发（ISS-002）", () => {
  it("成功路径：申请会话 → 冻结 model 下发 → prompt 投递 → settle → 成本落库 → 会话被停", async () => {
    const port = new FakePort();
    const p = createPoolRunTrigger(port, noRecord).trigger(ctxOf());
    await flush();

    // task origin 把崩溃重试所有权留给 scheduler，键为 task:{runId}。
    expect(port.requested).toEqual([
      { sessionId: "task:run-1", workspaceId: "ws1", origin: "task", focus: false },
    ]);

    port.tap!.onReady!("pi-sess-42");
    await flush();
    // 冻结的 provider/model 已作为 set_model 下发。
    expect(port.sent[0]).toEqual({
      sessionId: "task:run-1",
      message: { type: "set_model", provider: "openai", modelId: "gpt-x" },
    });
    expect(port.delivered).toEqual([{ sessionId: "task:run-1", text: "巡检一次" }]);

    port.tap!.onEvent!({ type: "agent_settled" } as unknown as AgentEvent);
    const outcome = await p;

    expect(outcome.status).toBe("succeeded");
    expect(outcome.sessionId).toBe("pi-sess-42"); // 真实 pi sessionId，历史用它定位
    expect(outcome.costUsd).toBe(0.12);
    expect(port.stopped).toEqual(["task:run-1"]); // 跑完释放并发位
  });

  it("派生即崩（ready 前 exit）→ failed 且会话仍被收尾", async () => {
    const port = new FakePort();
    const p = createPoolRunTrigger(port, noRecord).trigger(ctxOf());
    await flush();
    port.tap!.onExit!("crash");
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("crash");
    expect(port.stopped).toEqual(["task:run-1"]);
  });

  it("执行中崩溃 → failed（不谎称成功）", async () => {
    const port = new FakePort();
    const p = createPoolRunTrigger(port, noRecord).trigger(ctxOf());
    await flush();
    port.tap!.onReady!("pi-sess-1");
    await flush();
    port.tap!.onExit!("crash");
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("退出");
  });

  it("超时：deadline 内未就绪 → failed + 会话被停（不留排队幽灵）", async () => {
    const port = new FakePort();
    const outcome = await createPoolRunTrigger(port, noRecord).trigger(ctxOf({ timeoutMs: 20 }));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("超时");
    expect(port.stopped).toEqual(["task:run-1"]);
  });

  it("set_model 被拒 → failed，prompt 绝不投递（不默默用错模型跑）", async () => {
    const port = new FakePort();
    port.sendImpl = async () => ({ success: false, error: "no such model" });
    const p = createPoolRunTrigger(port, noRecord).trigger(ctxOf());
    await flush();
    port.tap!.onReady!("pi-sess-1");
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("no such model");
    expect(port.delivered).toEqual([]);
  });

  it("助手回复以错误结束 → failed，但成本仍如实记录", async () => {
    const port = new FakePort();
    const p = createPoolRunTrigger(port, noRecord).trigger(ctxOf());
    await flush();
    port.tap!.onReady!("pi-sess-1");
    await flush();
    port.tap!.onEvent!({
      type: "message_end",
      message: { role: "assistant", stopReason: "error" },
    } as unknown as AgentEvent);
    port.tap!.onEvent!({ type: "agent_settled" } as unknown as AgentEvent);
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("错误结束");
    expect(outcome.costUsd).toBe(0.12);
  });

  it("等待 ready 时取消：立即停止精确 task session，等待本身同步收口", async () => {
    const port = new FakePort();
    const controller = new AbortController();
    const p = createPoolRunTrigger(port, noRecord).trigger(
      ctxOf({ signal: controller.signal })
    );
    await flush();

    controller.abort();
    const outcome = await p;

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("取消");
    expect(port.stopped).toEqual(["task:run-1"]);
  });

  it("等待 agent_settled 时取消：停止当前 run 的会话且不等待 runtime 再发事件", async () => {
    const port = new FakePort();
    const controller = new AbortController();
    const p = createPoolRunTrigger(port, noRecord).trigger(
      ctxOf({ signal: controller.signal })
    );
    await flush();
    port.tap!.onReady!("pi-sess-1");
    await flush();
    expect(port.delivered).toHaveLength(1);

    controller.abort();
    const outcome = await p;

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("取消");
    expect(port.stopped).toEqual(["task:run-1"]);
  });

  it("task runtime 崩溃由 scheduler 持有重试权，真实 PoolCore 不自动重启", async () => {
    let tap: RuntimeTap | null = null;
    const launches: Array<{ sessionId: string; workspaceId: string | null; origin: string }> = [];
    let core!: InstanceType<typeof AgentPoolCore>;
    core = new AgentPoolCore({
      host: {
        launch(req) {
          launches.push(req);
          queueMicrotask(() => tap?.onReady?.("pi-task-session"));
        },
        stop() {},
      },
    });
    const port: PoolTriggerPort = {
      requestSession: (input) => core.requestSession(input),
      stopSession: (sessionId) => core.stopSession(sessionId),
      observe: (_sessionId, nextTap) => {
        tap = nextTap;
        return () => {
          if (tap === nextTap) tap = null;
        };
      },
      deliver: () => true,
      send: async (_sessionId, message) =>
        (message as { type?: string }).type === "get_session_stats"
          ? { success: true, data: { cost: 0 } }
          : { success: true },
    };

    const p = createPoolRunTrigger(port, noRecord).trigger(ctxOf());
    await flush();
    core.handleExit("task:run-1", "crash", Date.now());
    expect(core.snapshot().sessions[0]?.runState).toBe("crashed");
    tap!.onExit?.("crash");
    const outcome = await p;

    expect(outcome.status).toBe("failed");
    expect(launches).toEqual([
      {
        sessionId: "task:run-1",
        workspaceId: "ws1",
        origin: "task",
        inheritPermissions: false,
      },
    ]);
  });
});

describe("后台会话用量入账（R5.2）", () => {
  /** 真实形状的 get_session_stats data（tokens/cost 与 rpc.md 口径一致）。 */
  const STATS_DATA = {
    sessionId: "pi-sess-42",
    tokens: { input: 22319, output: 512, cacheRead: 0, cacheWrite: 0, total: 22831 },
    cost: 0.1117,
  };

  it("settle 后按真实 sessionId + 冻结 provider/model + workspace 分区入账恰一次", async () => {
    const port = new FakePort();
    port.sendImpl = async (message) => {
      const type = (message as { type?: string }).type;
      if (type === "get_session_stats") return { success: true, data: STATS_DATA };
      return { success: true };
    };
    const recorded: unknown[] = [];
    const p = createPoolRunTrigger(port, (input) => recorded.push(input)).trigger(
      ctxOf({ workspaceId: "ws-partition" })
    );
    await flush();
    port.tap!.onReady!("pi-sess-42");
    await flush();
    port.tap!.onEvent!({ type: "agent_settled" } as unknown as AgentEvent);
    await p;

    expect(recorded).toEqual([
      {
        sessionId: "pi-sess-42",
        workspaceId: "ws-partition",
        provider: "openai",
        modelId: "gpt-x",
        inputTokens: 22319,
        outputTokens: 512,
        cost: 0.1117,
        failed: false,
      },
    ]);
  });

  it("助手以错误收场时仍入账，且带 failed 标记", async () => {
    const port = new FakePort();
    port.sendImpl = async (message) => {
      const type = (message as { type?: string }).type;
      if (type === "get_session_stats") return { success: true, data: STATS_DATA };
      return { success: true };
    };
    const recorded: Array<{ failed?: boolean }> = [];
    const p = createPoolRunTrigger(port, (input) =>
      recorded.push(input as { failed?: boolean })
    ).trigger(ctxOf());
    await flush();
    port.tap!.onReady!("pi-sess-42");
    await flush();
    port.tap!.onEvent!({
      type: "message_end",
      message: { role: "assistant", stopReason: "error" },
    } as unknown as AgentEvent);
    port.tap!.onEvent!({ type: "agent_settled" } as unknown as AgentEvent);
    await p;

    expect(recorded).toHaveLength(1);
    expect(recorded[0].failed).toBe(true);
  });

  it("统计拉不到就不入账（不造数）", async () => {
    const port = new FakePort();
    port.sendImpl = async (message) => {
      const type = (message as { type?: string }).type;
      if (type === "get_session_stats") return { success: false };
      return { success: true };
    };
    const recorded: unknown[] = [];
    const p = createPoolRunTrigger(port, (input) => recorded.push(input)).trigger(ctxOf());
    await flush();
    port.tap!.onReady!("pi-sess-42");
    await flush();
    port.tap!.onEvent!({ type: "agent_settled" } as unknown as AgentEvent);
    await p;

    expect(recorded).toEqual([]);
  });
});
