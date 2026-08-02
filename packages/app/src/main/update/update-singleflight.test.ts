/**
 * single-flight、取消能力与安装前校验。
 *
 * 「用户连点三下检查更新」和「自动检查与手动检查撞在一起」是同一件事：
 * 底层必须只跑一次。跑多次的表现是进度条来回跳、下载文件互相覆盖，
 * 而这两种表现在人工点测里都被当成「网络有点慢」。
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
import type { UpdateServiceDeps } from "./update-types.js";

function build(over: Partial<UpdateServiceDeps> = {}): {
  svc: UpdateService;
  updater: FakeUpdater;
  blockers: FakeBlockers;
} {
  const updater = new FakeUpdater();
  const blockers = new FakeBlockers();
  const deps: UpdateServiceDeps = {
    updater,
    currentVersion: "1.0.0",
    isPackaged: true,
    prefs: new MemoryPrefs(),
    logger: silentLogger,
    blockers,
    broadcast: () => {},
    cancelSupported: true,
    createCancellationToken: () => new FakeCancellationToken(),
    verifyBeforeInstall: () => ({ ok: true }),
    timers: new RecordingTimers(),
    ...over,
  };
  deps.updater = updater;
  deps.blockers = blockers;
  return { svc: new UpdateService(deps), updater, blockers };
}

describe("single-flight", () => {
  it("并发 3 次 checkForUpdates，底层只被调用 1 次", async () => {
    const { svc, updater } = build();
    let release: () => void = () => {};
    updater.onCheck = () => new Promise<void>((r) => (release = r));

    const all = Promise.all([
      svc.checkForUpdates("manual"),
      svc.checkForUpdates("manual"),
      svc.checkForUpdates("manual"),
    ]);
    release();
    await all;

    expect(updater.checkCalls).toBe(1);
  });

  it("并发 3 次 downloadUpdate，底层只被调用 1 次", async () => {
    const { svc, updater } = build();
    let release: () => void = () => {};
    updater.onDownload = () => new Promise<void>((r) => (release = r));

    const all = Promise.all([svc.downloadUpdate(), svc.downloadUpdate(), svc.downloadUpdate()]);
    release();
    await all;

    expect(updater.downloadCalls).toBe(1);
  });

  it("并发 3 次 installAndRestart，quitAndInstall 只被调用 1 次", async () => {
    const { svc, updater } = build();
    updater.emit("update-downloaded", { version: "2.0.0" });

    await Promise.all([
      svc.installAndRestart("now"),
      svc.installAndRestart("now"),
      svc.installAndRestart("now"),
    ]);

    expect(updater.quitCalls).toBe(1);
  });
});

describe("下载取消", () => {
  it("cancelSupported=true 时取消一次令牌并回到 idle", async () => {
    const spy = vi.spyOn(FakeCancellationToken.prototype, "cancel");
    spy.mockClear();

    const { svc, updater } = build();
    let release: () => void = () => {};
    updater.onDownload = () => new Promise<void>((r) => (release = r));

    const p = svc.downloadUpdate();
    expect(svc.getState().status).toBe("downloading");

    const after = svc.cancelDownload();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(after.status).toBe("idle");

    release();
    await p;
    spy.mockRestore();
  });

  it("cancelSupported=false 时 cancelDownload 是空操作（界面上也不会有那个按钮）", async () => {
    const { svc, updater } = build({
      cancelSupported: false,
      createCancellationToken: undefined,
    });
    let release: () => void = () => {};
    updater.onDownload = () => new Promise<void>((r) => (release = r));

    const p = svc.downloadUpdate();
    const after = svc.cancelDownload();
    expect(after.status).toBe("downloading");
    expect(svc.getState().cancelSupported).toBe(false);

    release();
    await p;
  });
});

describe("安装前校验真的会中止", () => {
  it("版本不是严格更新时进 error(metadata)，quitAndInstall 一次都不调", async () => {
    const { svc, updater } = build({
      verifyBeforeInstall: () => ({ ok: false, errorCode: "metadata", reason: "降级" }),
    });
    updater.emit("update-downloaded", { version: "0.9.0" });

    const state = await svc.installAndRestart("now");

    expect(state.status).toBe("error");
    expect(state.errorCode).toBe("metadata");
    expect(updater.quitCalls).toBe(0);
  });

  it("sha512 不符时进 error(signature)，quitAndInstall 一次都不调", async () => {
    const { svc, updater } = build({
      verifyBeforeInstall: () => ({ ok: false, errorCode: "signature", reason: "校验不过" }),
    });
    updater.emit("update-downloaded", { version: "2.0.0" });

    const state = await svc.installAndRestart("now");

    expect(state.status).toBe("error");
    expect(state.errorCode).toBe("signature");
    expect(updater.quitCalls).toBe(0);
  });
});

describe("安装前的阻断项", () => {
  it("有正在跑的任务时 mode=now 不安装，只把清单回给界面", async () => {
    const { svc, updater, blockers } = build();
    blockers.blockers = [{ kind: "agent", count: 1, label: "有 1 个任务正在运行" }];
    updater.emit("update-downloaded", { version: "2.0.0" });

    const state = await svc.installAndRestart("now");

    expect(state.status).toBe("downloaded");
    expect(state.blockers).toHaveLength(1);
    expect(updater.quitCalls).toBe(0);
  });

  it("mode=wait 进 waiting-for-agent，收到真实 settle 事件后才安装", async () => {
    const { svc, updater, blockers } = build();
    blockers.blockers = [{ kind: "agent", count: 1, label: "有 1 个任务正在运行" }];
    updater.emit("update-downloaded", { version: "2.0.0" });

    await svc.installAndRestart("wait");
    expect(svc.getState().status).toBe("waiting-for-agent");
    expect(updater.quitCalls).toBe(0);

    blockers.settle();
    await vi.waitFor(() => expect(updater.quitCalls).toBe(1));
    expect(svc.getState().status).toBe("installing");
  });

  it("mode=force 直接安装", async () => {
    const { svc, updater, blockers } = build();
    blockers.blockers = [{ kind: "recording", count: 1, label: "正在录音" }];
    updater.emit("update-downloaded", { version: "2.0.0" });

    await svc.installAndRestart("force");
    expect(updater.quitCalls).toBe(1);
  });
});
