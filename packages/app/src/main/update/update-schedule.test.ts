/**
 * 检查调度：首检延迟、抖动区间、unref、失败退避、手动防连点。
 *
 * 这些数字全部是「错了也不会报错」的那一类：抖动写成 0 只会让同一批装机的
 * 用户在同一秒集体敲发布源；忘了 unref 只会让用户点关闭之后主进程赖着不退；
 * 退避写反了只会让断网时每 15 分钟重试一次直到天荒地老。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKOFF_MS,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UpdateService,
} from "./update-service.js";
import {
  FakeBlockers,
  FakeUpdater,
  MemoryPrefs,
  RecordingTimers,
  silentLogger,
} from "./update-test-fakes.js";
import type { UpdateServiceDeps } from "./update-types.js";

function build(random = () => 0.5): {
  svc: UpdateService;
  updater: FakeUpdater;
  timers: RecordingTimers;
} {
  const updater = new FakeUpdater();
  const timers = new RecordingTimers();
  const deps: UpdateServiceDeps = {
    updater,
    currentVersion: "1.0.0",
    isPackaged: true,
    prefs: new MemoryPrefs(),
    logger: silentLogger,
    blockers: new FakeBlockers(),
    broadcast: () => {},
    cancelSupported: true,
    verifyBeforeInstall: () => ({ ok: true }),
    timers,
    random,
  };
  return { svc: new UpdateService(deps), updater, timers };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("首次检查", () => {
  it("主窗口 ready 后 30_000ms 才触发", async () => {
    const { svc, updater, timers } = build();
    svc.onWindowReady();

    expect(timers.delays[0]).toBe(FIRST_CHECK_DELAY_MS);
    expect(updater.checkCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(updater.checkCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkCalls).toBe(1);
  });

  it("定时器对象上调用过 unref（否则用户点关闭后主进程要等 4 小时才肯退）", () => {
    const { svc, timers } = build();
    svc.onWindowReady();
    expect(timers.unrefCount).toBeGreaterThanOrEqual(1);
  });

  it("onWindowReady 重复调用不重复排期", () => {
    const { svc, timers } = build();
    svc.onWindowReady();
    svc.onWindowReady();
    svc.onWindowReady();
    expect(timers.delays).toHaveLength(1);
  });
});

describe("静默间隔", () => {
  it("成功之后每次间隔都落在 [4h*1.10, 4h*1.20)", async () => {
    const randoms = [0, 0.25, 0.5, 0.75, 0.999];
    let i = 0;
    const { svc, updater, timers } = build(() => randoms[i++ % randoms.length]);
    updater.onCheck = () => void updater.emit("update-not-available");

    svc.onWindowReady();

    for (let n = 0; n < 5; n++) {
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 1.25);
    }

    // delays[0] 是 30s 首检，之后每一项都是静默间隔
    const intervals = timers.delays.slice(1);
    expect(intervals.length).toBeGreaterThanOrEqual(5);
    for (const d of intervals) {
      expect(d).toBeGreaterThanOrEqual(CHECK_INTERVAL_MS * 1.1);
      expect(d).toBeLessThan(CHECK_INTERVAL_MS * 1.2);
    }
  });
});

describe("网络失败退避", () => {
  it("连续失败的重试间隔是 15min → 1h → 4h，成功后回到 4h 基线", async () => {
    const { svc, updater, timers } = build(() => 0);
    updater.onCheck = () => void updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));

    await svc.checkForUpdates("manual");
    expect(timers.delays.at(-1)).toBe(BACKOFF_MS[0]);

    await svc.checkForUpdates("auto");
    expect(timers.delays.at(-1)).toBe(BACKOFF_MS[1]);

    await svc.checkForUpdates("auto");
    expect(timers.delays.at(-1)).toBe(BACKOFF_MS[2]);

    // 第四次仍停在 4h，不再继续拉长
    await svc.checkForUpdates("auto");
    expect(timers.delays.at(-1)).toBe(BACKOFF_MS[2]);

    // 成功一次就清零：回到抖动后的 4h 基线
    updater.onCheck = () => void updater.emit("update-not-available");
    await svc.checkForUpdates("auto");
    expect(timers.delays.at(-1)).toBeCloseTo(CHECK_INTERVAL_MS * 1.1, 0);
  });
});

describe("手动检查", () => {
  it("不受静默节流约束，但 500ms 内连点只触发一次", async () => {
    const { svc, updater } = build();
    updater.onCheck = () => void updater.emit("update-not-available");

    await svc.checkForUpdates("manual");
    expect(updater.checkCalls).toBe(1);

    // 同一时刻再点（fake timer 下 Date.now 没走）
    await svc.checkForUpdates("manual");
    await svc.checkForUpdates("manual");
    expect(updater.checkCalls).toBe(1);

    // 过了防连点窗口就照常放行
    await vi.advanceTimersByTimeAsync(600);
    await svc.checkForUpdates("manual");
    expect(updater.checkCalls).toBe(2);
  });

  it("关掉自动检查后静默检查不再发生，手动检查照常", async () => {
    const { svc, updater } = build();
    updater.onCheck = () => void updater.emit("update-not-available");

    svc.setAutoCheck(false);
    await svc.checkForUpdates("auto");
    expect(updater.checkCalls).toBe(0);

    await svc.checkForUpdates("manual");
    expect(updater.checkCalls).toBe(1);
  });
});
