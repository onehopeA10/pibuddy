/**
 * 切换更新通道时，旧通道的在途任务必须被作废。
 *
 * 这是「看起来一切正常、直到用户装上一个他已经切走的通道的版本」那一类
 * 缺陷。人工点测发现不了：切换之后界面确实回到了 idle，只有当旧请求恰好
 * 在那几秒里返回时，候选版本才会被悄悄写回去。
 *
 * 两道闸门各自独立可失效，因此分别断言：
 *   A. **代际闸门** —— 切换之后、新任务开始之前回来的事件一律丢掉；
 *   B. **通道闸门** —— 新任务已经开始（代际追平）时，stable 通道仍然拒绝
 *      带 prerelease 标记的候选。
 */
import { describe, expect, it, vi } from "vitest";

import { UpdateService } from "./update-service.js";
import {
  FakeBlockers,
  FakeCancellationToken,
  FakeUpdater,
  MemoryPrefs,
  RecordingTimers,
  silentLogger,
} from "./update-test-fakes.js";
import { DEFAULT_UPDATE_PREFS, type UpdateServiceDeps } from "./update-types.js";

function build(): { svc: UpdateService; updater: FakeUpdater } {
  const updater = new FakeUpdater();
  const deps: UpdateServiceDeps = {
    updater,
    currentVersion: "1.0.0",
    isPackaged: true,
    // 从 beta 出发：本组用例全部是「beta → stable」这个方向
    prefs: new MemoryPrefs({ ...DEFAULT_UPDATE_PREFS, channel: "beta" }),
    logger: silentLogger,
    blockers: new FakeBlockers(),
    broadcast: () => {},
    cancelSupported: true,
    createCancellationToken: () => new FakeCancellationToken(),
    verifyBeforeInstall: () => ({ ok: true }),
    timers: new RecordingTimers(),
  };
  return { svc: new UpdateService(deps), updater };
}

describe("A. 代际闸门：切换之后回来的旧事件被丢弃", () => {
  /**
   * 刻意走 **stable → beta** 这个方向，候选版本是正式版 `2.0.0`。
   *
   * 反方向（beta→stable + beta 候选）会同时踩中通道闸门，那样这条用例
   * 在代际闸门被拆掉之后**依然是绿的** —— 它测的就不再是代际了。
   * beta 通道按定义接受正式版，因此这里只剩代际一条判据。
   */
  it("切换通道后，旧请求带回的候选版本不再写进状态（纯代际判据）", async () => {
    const { svc, updater } = build();
    svc.setChannel("stable");

    let release: () => void = () => {};
    updater.onCheck = () => new Promise<void>((r) => (release = r));

    const inflight = svc.checkForUpdates("manual");
    expect(svc.getState().status).toBe("checking");

    svc.setChannel("beta");
    expect(svc.getState().status).toBe("idle");

    // 切换之前那次 stable 请求现在才返回
    updater.emit("update-available", { version: "2.0.0", files: [{ size: 100 }] });
    release();
    await inflight;

    expect(svc.getState().candidateVersion).toBeNull();
    expect(svc.getState().status).toBe("idle");
    expect(svc.getState().channel).toBe("beta");
  });

  it("切到 stable 后，旧 beta 下载的 update-downloaded 不再把状态推到 downloaded", async () => {
    const spy = vi.spyOn(FakeCancellationToken.prototype, "cancel");
    spy.mockClear();

    const { svc, updater } = build();
    let release: () => void = () => {};
    updater.onDownload = () => new Promise<void>((r) => (release = r));

    const inflight = svc.downloadUpdate();
    expect(svc.getState().status).toBe("downloading");

    svc.setChannel("stable");
    // 切换必须**取消**在途下载，而不只是把界面改回 idle
    expect(spy).toHaveBeenCalledTimes(1);

    updater.emit("download-progress", { percent: 90, transferred: 90, total: 100 });
    updater.emit("update-downloaded", {
      version: "1.3.0-beta.4",
      downloadedFile: "/tmp/PiBuddy-Setup-1.3.0-beta.4.exe",
    });
    release();
    await inflight;

    expect(svc.getState().status).toBe("idle");
    expect(svc.getState().percent).toBe(0);
    expect(svc.getState().candidateVersion).toBeNull();
    spy.mockRestore();
  });

  it("旧通道的错误不染红新通道的界面", async () => {
    const { svc, updater } = build();
    let release: () => void = () => {};
    updater.onCheck = () => new Promise<void>((r) => (release = r));

    const inflight = svc.checkForUpdates("manual");
    svc.setChannel("stable");

    updater.emit("error", new Error("ENOTFOUND beta.example.com"));
    release();
    await inflight;

    expect(svc.getState().status).toBe("idle");
    expect(svc.getState().errorCode).toBeNull();
  });

  it("被作废的旧下载收尾时，不解开新一次下载的 single-flight 锁", async () => {
    const releases: Array<() => void> = [];
    const { svc, updater } = build();
    updater.onDownload = () => new Promise<void>((r) => releases.push(r));

    const first = svc.downloadUpdate(); // 代际 0
    svc.setChannel("stable"); // 代际 1，first 作废

    const second = svc.downloadUpdate(); // 代际 1
    expect(updater.downloadCalls).toBe(2);

    // 旧下载现在才收尾。如果它照常复位 downloadInFlight，
    // 下面这次调用就会穿透 single-flight，底层被调第三次。
    releases[0]();
    await first;

    const third = svc.downloadUpdate();
    expect(updater.downloadCalls).toBe(2);

    releases[1]();
    await Promise.all([second, third]);
  });
});

describe("B. 通道闸门：代际追平后仍然拒绝错通道的候选", () => {
  it("新一次 stable 检查已经开始时，迟到的 beta 候选仍被拒绝", async () => {
    const { svc, updater } = build();
    let releaseOld: () => void = () => {};
    updater.onCheck = () => new Promise<void>((r) => (releaseOld = r));

    const stale = svc.checkForUpdates("auto"); // 代际 0（beta）
    svc.setChannel("stable"); // 代际 1

    // 用户切完之后又点了一次检查：opGeneration 追平到 1，代际闸门失效
    updater.onCheck = null;
    const fresh = svc.checkForUpdates("auto");

    // 旧 beta 响应此刻才回来，代际对得上，只能靠通道闸门拦
    updater.emit("update-available", {
      version: "1.3.0-beta.4",
      files: [{ size: 100, sha512: "BETA" }],
    });
    releaseOld();
    await Promise.all([stale, fresh]);

    expect(svc.getState().candidateVersion).toBeNull();
  });

  it("stable 通道收到正式版候选时照常接受（闸门不能误伤正常路径）", async () => {
    const { svc, updater } = build();
    svc.setChannel("stable");

    await svc.checkForUpdates("auto");
    updater.emit("update-available", { version: "2.0.0", files: [{ size: 100 }] });

    expect(svc.getState().candidateVersion).toBe("2.0.0");
    expect(svc.getState().status).toBe("available");
  });

  it("beta 通道是 stable 的超集：切到 beta 后正式版候选照收", async () => {
    const { svc, updater } = build();
    svc.setChannel("stable");
    svc.setChannel("beta");

    await svc.checkForUpdates("auto");
    updater.emit("update-available", { version: "2.0.0", files: [{ size: 100 }] });

    expect(svc.getState().candidateVersion).toBe("2.0.0");
  });
});

/**
 * 这一组钉的是 setChannel 的**状态复位**，而不是 abortInFlight 里那两行
 * `downloadedPath = null` —— 后者是同一件事的第二层保险，走公开 API 无法
 * 让它单独失效（对拍确认：只拆那两行，本组仍然全绿）。断言必须说它真正
 * 验证的那个机制的名字。
 */
describe("C. 切换后，旧通道已下载的包不再是可安装状态", () => {
  it("切到 stable 后，切换前下好的 beta 包装不上去", async () => {
    const { svc, updater } = build();

    await svc.checkForUpdates("auto");
    updater.emit("update-downloaded", {
      version: "1.3.0-beta.4",
      downloadedFile: "/tmp/PiBuddy-Setup-1.3.0-beta.4.exe",
    });
    expect(svc.getState().status).toBe("downloaded");
    expect(svc.getState().candidateVersion).toBe("1.3.0-beta.4");

    svc.setChannel("stable");
    expect(svc.getState().status).toBe("idle");

    // force 是最强的那条安装路径（跳过全部阻断项）。它都进不去，
    // 说明「已下载」这个可安装状态确实被切换收走了。
    const state = await svc.installAndRestart("force");
    expect(state.status).toBe("idle");
    expect(updater.quitCalls).toBe(0);
  });
});
