/**
 * 关机闸门：阻断项汇总 + 订阅式 idle 通知。
 *
 * 最关键的一条断言是「回调触发后 listenerCount 归 0」—— 每尝试一次安装就
 * 漏一个监听器的话，用户点上二十次「等任务结束后安装」，之后每一个
 * agent_settled 都会触发二十次安装尝试。这种泄漏不会报错，只会越来越慢。
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  agentActivity,
  createShutdownGate,
  defaultShutdownProbe,
  setShutdownSignals,
  type ShutdownProbe,
  type SettleEvents,
} from "./graceful-shutdown.js";

function probeOf(over: Partial<Record<keyof ShutdownProbe, unknown>> = {}): ShutdownProbe {
  return {
    activeAgents: () => 0,
    unsavedDrafts: () => 0,
    recording: () => false,
    pendingPermissions: () => 0,
    ...(over as Partial<ShutdownProbe>),
  };
}

class FakeSettleEvents extends EventEmitter implements SettleEvents {}

describe("collectBlockers", () => {
  it("四类阻断项都能被汇总，且带人类可读描述", () => {
    const gate = createShutdownGate(
      probeOf({
        activeAgents: () => 2,
        unsavedDrafts: () => 1,
        recording: () => true,
        pendingPermissions: () => 3,
      }),
      new FakeSettleEvents()
    );
    const blockers = gate.collectBlockers();
    expect(blockers.map((b) => b.kind).sort()).toEqual([
      "agent",
      "draft",
      "permission",
      "recording",
    ]);
    for (const b of blockers) expect(b.label.length).toBeGreaterThan(0);
    expect(blockers.find((b) => b.kind === "agent")?.count).toBe(2);
  });

  it("什么都没在跑时返回空数组", () => {
    const gate = createShutdownGate(probeOf(), new FakeSettleEvents());
    expect(gate.collectBlockers()).toEqual([]);
  });
});

describe("whenIdle 是订阅式的", () => {
  it("阻断项清空后回调触发一次，并且监听器被摘掉（listenerCount 归 0）", () => {
    let agents = 1;
    const events = new FakeSettleEvents();
    const gate = createShutdownGate(probeOf({ activeAgents: () => agents }), events);

    const cb = vi.fn();
    gate.whenIdle(cb);
    expect(events.listenerCount("agent_settled")).toBe(1);

    // 还没真的空 —— 不触发，监听器也还在
    events.emit("agent_settled");
    expect(cb).not.toHaveBeenCalled();
    expect(events.listenerCount("agent_settled")).toBe(1);

    agents = 0;
    events.emit("agent_settled");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(events.listenerCount("agent_settled")).toBe(0);

    // 再来事件也不会重复触发
    events.emit("agent_settled");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("本来就空时同步回调，一个监听器都不挂", () => {
    const events = new FakeSettleEvents();
    const gate = createShutdownGate(probeOf(), events);
    const cb = vi.fn();
    gate.whenIdle(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(events.listenerCount("agent_settled")).toBe(0);
  });

  it("提前放弃等待也会摘掉监听器", () => {
    const events = new FakeSettleEvents();
    const gate = createShutdownGate(probeOf({ activeAgents: () => 1 }), events);
    const cancel = gate.whenIdle(vi.fn());
    expect(events.listenerCount("agent_settled")).toBe(1);
    cancel();
    expect(events.listenerCount("agent_settled")).toBe(0);
  });

  it("连续 20 次等待与结束之后监听器不累积", () => {
    let agents = 0;
    const events = new FakeSettleEvents();
    const gate = createShutdownGate(probeOf({ activeAgents: () => agents }), events);
    for (let i = 0; i < 20; i++) {
      agents = 1;
      gate.whenIdle(vi.fn());
      agents = 0;
      events.emit("agent_settled");
    }
    expect(events.listenerCount("agent_settled")).toBe(0);
  });
});

describe("agentActivity", () => {
  it("agent_start / agent_settled 决定忙碌数，settle 时发事件", () => {
    agentActivity.reset();
    const seen = vi.fn();
    agentActivity.on("agent_settled", seen);

    agentActivity.markBusy("rt-1");
    agentActivity.markBusy("rt-2");
    expect(agentActivity.busyCount()).toBe(2);

    agentActivity.markSettled("rt-1");
    expect(agentActivity.busyCount()).toBe(1);
    expect(seen).toHaveBeenCalledTimes(1);

    // 重复 settle 不重复发事件
    agentActivity.markSettled("rt-1");
    expect(seen).toHaveBeenCalledTimes(1);

    // runtime 崩了要 forget，否则 busy 永久钉住、用户再也装不上更新
    agentActivity.forget("rt-2");
    expect(agentActivity.busyCount()).toBe(0);
    agentActivity.reset();
  });

  it("defaultShutdownProbe 读的是 agentActivity 与外部信号", () => {
    agentActivity.reset();
    setShutdownSignals({ unsavedDrafts: 0, recording: false, pendingPermissions: 0 });
    const probe = defaultShutdownProbe();
    expect(probe.activeAgents()).toBe(0);

    agentActivity.markBusy("rt-9");
    setShutdownSignals({ recording: true });
    expect(probe.activeAgents()).toBe(1);
    expect(probe.recording()).toBe(true);

    agentActivity.reset();
    setShutdownSignals({ recording: false });
  });
});
