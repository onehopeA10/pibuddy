/**
 * 初始化顺序、监听器计数与 dev 保护。
 *
 * 这三件事的共同点：错了不会有编译错误、不会有运行时报错，人工点测也看不
 * 出来，只会在某次真实发布之后变成「一批用户被降级」或「进度条按 3 倍
 * 频率跳」或「开发机指向了生产 feed」。
 */
import { describe, expect, it, vi } from "vitest";

import { UpdateService } from "./update-service.js";
import {
  FakeBlockers,
  FakeUpdater,
  MemoryPrefs,
  RecordingTimers,
  silentLogger,
} from "./update-test-fakes.js";
import type { UpdateServiceDeps } from "./update-types.js";

function makeDeps(over: Partial<UpdateServiceDeps> = {}): {
  deps: UpdateServiceDeps;
  updater: FakeUpdater;
  prefs: MemoryPrefs;
} {
  const updater = (over.updater as FakeUpdater) ?? new FakeUpdater();
  const prefs = (over.prefs as MemoryPrefs) ?? new MemoryPrefs();
  const deps: UpdateServiceDeps = {
    updater,
    currentVersion: "1.0.0",
    isPackaged: true,
    prefs,
    logger: silentLogger,
    blockers: new FakeBlockers(),
    broadcast: () => {},
    cancelSupported: true,
    verifyBeforeInstall: () => ({ ok: true }),
    timers: new RecordingTimers(),
    ...over,
  };
  // updater / prefs 在上面已经取过一次；这里回填，确保返回的 deps 与返回的
  // 实例是同一个对象（否则断言看的是另一个替身）。
  deps.updater = updater;
  deps.prefs = prefs;
  return { deps, updater, prefs };
}

describe("initAutoUpdater 的属性赋值顺序", () => {
  it("恰好是 autoDownload → autoInstallOnAppQuit → channel → allowPrerelease → allowDowngrade", () => {
    const { deps, updater } = makeDeps();
    new UpdateService(deps);

    expect(updater.assigned).toEqual([
      "autoDownload",
      "autoInstallOnAppQuit",
      "channel",
      "allowPrerelease",
      "allowDowngrade",
    ]);
    // allowDowngrade 必须是最后一个：channel / allowPrerelease 的 setter 在
    // electron-updater 内部可能联动 downgrade，先写就会被覆盖掉。
    expect(updater.assigned[updater.assigned.length - 1]).toBe("allowDowngrade");
  });

  it("末值恒为 autoDownload=false / autoInstallOnAppQuit=false / allowDowngrade=false", () => {
    const { deps, updater } = makeDeps();
    new UpdateService(deps);

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("stable 通道映射到 feed 的 latest，且不允许预发布", () => {
    const prefs = new MemoryPrefs({
      channel: "stable",
      autoCheck: true,
      autoDownload: false,
      dismissedVersion: null,
      dismissedUntil: null,
    });
    const { deps, updater } = makeDeps({ prefs });
    new UpdateService(deps);

    expect(updater.channel).toBe("latest");
    expect(updater.allowPrerelease).toBe(false);
  });

  it("beta 通道映射到 feed 的 beta，且允许预发布", () => {
    const prefs = new MemoryPrefs({
      channel: "beta",
      autoCheck: true,
      autoDownload: false,
      dismissedVersion: null,
      dismissedUntil: null,
    });
    const { deps, updater } = makeDeps({ prefs });
    new UpdateService(deps);

    expect(updater.channel).toBe("beta");
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
  });
});

describe("监听器注册", () => {
  const EVENTS = [
    "checking-for-update",
    "update-available",
    "update-not-available",
    "download-progress",
    "update-downloaded",
    "error",
  ];

  it("每个 updater 事件的 listenerCount 恒为 1", () => {
    const { deps, updater } = makeDeps();
    new UpdateService(deps);
    for (const e of EVENTS) expect(updater.listenerCount(e)).toBe(1);
  });

  it("重复初始化（切换通道会触发）不叠加监听器", () => {
    const { deps, updater } = makeDeps();
    const svc = new UpdateService(deps);
    svc.setChannel("beta");
    svc.setChannel("stable");
    for (const e of EVENTS) expect(updater.listenerCount(e)).toBe(1);
  });
});

describe("dev 保护", () => {
  it("未打包且无 fake feed 时状态恒为 unsupported，且一次都不碰生产更新源", async () => {
    const { deps, updater } = makeDeps({ isPackaged: false, fakeFeedUrl: null });
    const svc = new UpdateService(deps);

    expect(svc.getState().status).toBe("unsupported");

    // 就算有人硬调，也不许发出任何请求
    await svc.checkForUpdates("manual");
    await svc.downloadUpdate();
    svc.onWindowReady();

    expect(updater.setFeedCalls).toBe(0);
    expect(updater.checkCalls).toBe(0);
    expect(updater.downloadCalls).toBe(0);
    // 连监听器都不挂：unsupported 环境下这个子系统整体不存在
    expect(updater.listenerCount("error")).toBe(0);
  });

  it("仅当 PIBUDDY_FAKE_UPDATE_FEED 存在时才注入 fake provider", () => {
    const { deps, updater } = makeDeps({
      isPackaged: false,
      fakeFeedUrl: "https://127.0.0.1:8443/",
    });
    const svc = new UpdateService(deps);

    expect(svc.getState().status).toBe("idle");
    expect(updater.setFeedCalls).toBe(1);
  });

  it("打包环境不调用 setFeedURL（feed 由 app-update.yml 决定）", () => {
    const { deps, updater } = makeDeps({ isPackaged: true, fakeFeedUrl: null });
    new UpdateService(deps);
    expect(updater.setFeedCalls).toBe(0);
  });
});

describe("状态快照与 stateSequence", () => {
  it("没有任何订阅者时状态也不丢：连推 5 次后快照是第 5 个状态", () => {
    const { deps, updater } = makeDeps();
    const svc = new UpdateService(deps);

    for (let i = 1; i <= 5; i++) {
      updater.emit("download-progress", { percent: i * 10, transferred: i, total: 100 });
    }

    expect(svc.getState().stateSequence).toBe(5);
    expect(svc.getState().percent).toBe(50);
    expect(svc.getState().status).toBe("downloading");
  });

  it("连续 50 次状态变更的 stateSequence 严格递增，且终值为 50", () => {
    const seen: number[] = [];
    const { deps, updater } = makeDeps({
      broadcast: (env) => seen.push((env as { payload: { stateSequence: number } }).payload.stateSequence),
    });
    const svc = new UpdateService(deps);

    for (let i = 1; i <= 50; i++) {
      updater.emit("download-progress", { percent: i, transferred: i, total: 100 });
    }

    expect(seen).toHaveLength(50);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(svc.getState().stateSequence).toBe(50);
  });

  it("信封的传输层 sequence 与状态的 stateSequence 是两个计数器", () => {
    const frames: Array<{ generation: number; sequence: number }> = [];
    const { deps, updater } = makeDeps({
      broadcast: (env) => frames.push(env as { generation: number; sequence: number }),
    });
    new UpdateService(deps, 7);

    updater.emit("update-not-available");
    updater.emit("update-not-available");

    expect(frames.map((f) => f.sequence)).toEqual([0, 1]);
    expect(frames.every((f) => f.generation === 7)).toBe(true);
  });
});

describe("dismiss 归 main 持久化", () => {
  it("重建 service（模拟重启）后同一 candidate 在 24h 内不再主动提示", () => {
    const prefs = new MemoryPrefs();
    const now = vi.fn(() => 1_000_000);
    const { deps } = makeDeps({ prefs, now });
    const svc = new UpdateService(deps);

    svc.dismissVersion("2.0.0");
    expect(svc.shouldAnnounce("2.0.0")).toBe(false);

    // 重启：新实例从同一份磁盘偏好重建
    const svc2 = new UpdateService(makeDeps({ prefs, now }).deps);
    expect(svc2.shouldAnnounce("2.0.0")).toBe(false);
    // 但设置页始终看得到这个版本可用 —— dismiss 只压横幅，不改状态
    expect(svc2.getState().dismissedVersion).toBe("2.0.0");
    // 别的版本照常提示
    expect(svc2.shouldAnnounce("2.1.0")).toBe(true);
  });

  it("超过 24 小时后重新提示", () => {
    const prefs = new MemoryPrefs();
    let clock = 1_000_000;
    const { deps } = makeDeps({ prefs, now: () => clock });
    const svc = new UpdateService(deps);

    svc.dismissVersion("2.0.0");
    expect(svc.shouldAnnounce("2.0.0")).toBe(false);

    clock += 24 * 60 * 60 * 1000 + 1;
    expect(svc.shouldAnnounce("2.0.0")).toBe(true);
  });
});
