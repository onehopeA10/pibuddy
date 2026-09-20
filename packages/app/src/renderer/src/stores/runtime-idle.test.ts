import { describe, expect, it } from "vitest";
import {
  CONVERSATION_IDLE_SLEEP_MS,
  isRuntimeGoneError,
  nextSleepDelayMs,
  shouldRetryWake,
  shouldSleepRuntime,
  shouldWakeOnActivate,
  shouldWakeRuntime,
  sleepRetryDelayMs,
  type RuntimeIdleSnapshot,
} from "./runtime-idle";

function snap(over: Partial<RuntimeIdleSnapshot> = {}): RuntimeIdleSnapshot {
  return {
    now: 20_000,
    lastConversationAt: 0,
    idleSleepMs: 10_000,
    started: true,
    streaming: false,
    aborting: false,
    asleep: false,
    waking: false,
    pendingUi: false,
    ...over,
  };
}

describe("runtime idle 判据", () => {
  it("空闲超过阈值且在跑、不忙，才睡", () => {
    expect(shouldSleepRuntime(snap())).toBe(true);
    expect(shouldSleepRuntime(snap({ now: 9_999 }))).toBe(false);
    expect(shouldSleepRuntime(snap({ streaming: true }))).toBe(false);
    expect(shouldSleepRuntime(snap({ aborting: true }))).toBe(false);
    expect(shouldSleepRuntime(snap({ pendingUi: true }))).toBe(false);
    expect(shouldSleepRuntime(snap({ asleep: true }))).toBe(false);
    expect(shouldSleepRuntime(snap({ waking: true }))).toBe(false);
    expect(shouldSleepRuntime(snap({ started: false }))).toBe(false);
  });

  it("忙着响铃时重排一整段空闲，不按上次对话算出 0", () => {
    expect(sleepRetryDelayMs(snap({ streaming: true, now: 20_000, lastConversationAt: 19_000 }))).toBe(
      10_000
    );
    expect(sleepRetryDelayMs(snap({ asleep: true }))).toBeNull();
    expect(sleepRetryDelayMs(snap({ started: false }))).toBeNull();
    expect(sleepRetryDelayMs(snap({ now: 12_000, lastConversationAt: 5_000 }))).toBe(3_000);
  });

  it("延迟不会小于 0", () => {
    expect(nextSleepDelayMs({ now: 50, lastConversationAt: 0, idleSleepMs: 10 })).toBe(0);
  });

  it("休眠或断连才在发送路径上拉活", () => {
    expect(shouldWakeRuntime({ asleep: true, startError: "" })).toBe(true);
    expect(shouldWakeRuntime({ asleep: false, startError: "崩了" })).toBe(true);
    expect(shouldWakeRuntime({ asleep: false, startError: "" })).toBe(false);
  });

  it("聚焦时：休眠、断连、或有会话却未启动，都拉活", () => {
    expect(
      shouldWakeOnActivate({ asleep: true, started: false, startError: "", hasSession: true })
    ).toBe(true);
    expect(
      shouldWakeOnActivate({ asleep: false, started: false, startError: "x", hasSession: true })
    ).toBe(true);
    expect(
      shouldWakeOnActivate({ asleep: false, started: false, startError: "", hasSession: true })
    ).toBe(true);
    expect(
      shouldWakeOnActivate({ asleep: false, started: false, startError: "", hasSession: false })
    ).toBe(false);
    expect(
      shouldWakeOnActivate({ asleep: false, started: true, startError: "", hasSession: true })
    ).toBe(false);
  });

  it("发送总是允许再试；聚焦失败后要过冷却", () => {
    expect(
      shouldRetryWake({ reason: "send", now: 1, lastFailedWakeAt: 1, cooldownMs: 8_000 })
    ).toBe(true);
    expect(
      shouldRetryWake({ reason: "focus", now: 3_000, lastFailedWakeAt: 1, cooldownMs: 8_000 })
    ).toBe(false);
    expect(
      shouldRetryWake({ reason: "health", now: 9_000, lastFailedWakeAt: 1, cooldownMs: 8_000 })
    ).toBe(true);
    expect(
      shouldRetryWake({ reason: "focus", now: 100, lastFailedWakeAt: 0, cooldownMs: 8_000 })
    ).toBe(true);
  });

  it("认出主进程的 runtime 已死句子", () => {
    expect(isRuntimeGoneError(new Error("智能体运行时不可用（phase=stopping）"))).toBe(true);
    expect(isRuntimeGoneError("尚未启动，请先选择工作文件夹")).toBe(true);
    expect(isRuntimeGoneError("Error invoking remote method 'pi:start': Error: SESSION_UNKNOWN: abc")).toBe(
      true
    );
    expect(
      isRuntimeGoneError(
        new Error("Error invoking remote method 'pi:switch-session': Error: 客户端已停止")
      )
    ).toBe(true);
    expect(isRuntimeGoneError("进程已退出")).toBe(true);
    expect(isRuntimeGoneError("网络超时")).toBe(false);
  });

  it("产品默认空闲时长是 15 分钟", () => {
    expect(CONVERSATION_IDLE_SLEEP_MS).toBe(15 * 60_000);
  });
});
