/**
 * 渲染侧 update store：先快照后订阅、传输层丢弃、快照对账。
 *
 * 「刷新后进度条回到 idle」是这一块唯一会被用户直接看到的 bug，
 * 而它在人工点测里只有在「恰好刷新时正在下载」才复现。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useUpdateStore, emptyUpdateState } from "./update";

type Sub = (payload: unknown) => void;

function makeState(over: Partial<ReturnType<typeof emptyUpdateState>> = {}) {
  return { ...emptyUpdateState(), stateSequence: 0, currentVersion: "1.0.0", ...over };
}

function envelope(seq: number, generation: number, payload: unknown) {
  return { protocolVersion: 1, generation, sequence: seq, occurredAt: 0, payload };
}

let subscriber: Sub | null = null;
const api = {
  getState: vi.fn(async () => makeState()),
  checkForUpdates: vi.fn(async () => makeState({ status: "checking", stateSequence: 1 })),
  downloadUpdate: vi.fn(async () => makeState({ status: "downloading", stateSequence: 2 })),
  cancelDownload: vi.fn(async () => makeState({ status: "idle", stateSequence: 3 })),
  installAndRestart: vi.fn(async () => makeState({ status: "installing", stateSequence: 4 })),
  setUpdateChannel: vi.fn(async () => makeState({ channel: "beta", stateSequence: 5 })),
  setAutoCheck: vi.fn(async () => makeState({ autoCheck: false, stateSequence: 6 })),
  setAutoDownload: vi.fn(async () => makeState({ autoDownload: true, stateSequence: 7 })),
  dismissVersion: vi.fn(async () => makeState({ dismissedVersion: "2.0.0", stateSequence: 8 })),
  onEvent: vi.fn((cb: Sub) => {
    subscriber = cb;
    return () => {
      subscriber = null;
    };
  }),
};

beforeEach(() => {
  setActivePinia(createPinia());
  subscriber = null;
  for (const fn of Object.values(api)) (fn as { mockClear?: () => void }).mockClear?.();
  api.getState.mockResolvedValue(makeState());
  (globalThis as unknown as { window: unknown }).window = { piBuddy: { update: api } };
});

describe("挂载顺序", () => {
  it("先取快照再订阅（顺序反了会漏掉两者之间的事件）", async () => {
    const store = useUpdateStore();
    const order: string[] = [];
    api.getState.mockImplementation(async () => {
      order.push("getState");
      return makeState();
    });
    api.onEvent.mockImplementation((cb: Sub) => {
      order.push("onEvent");
      subscriber = cb;
      return () => {};
    });

    await store.init();
    expect(order).toEqual(["getState", "onEvent"]);
  });

  it("reload 后进度从 main 的快照原样恢复，而不是回到 idle", async () => {
    api.getState.mockResolvedValue(
      makeState({
        status: "downloading",
        stateSequence: 42,
        percent: 62,
        bytesTransferred: 62_000_000,
        totalBytes: 100_000_000,
        candidateVersion: "2.0.0",
      })
    );
    const store = useUpdateStore();
    await store.init();

    expect(store.state.status).toBe("downloading");
    expect(store.state.percent).toBe(62);
  });
});

describe("传输层丢弃（shouldAcceptEnvelope）", () => {
  it("同代际内序号必须严格递增", async () => {
    const store = useUpdateStore();
    await store.init();

    subscriber?.(envelope(0, 1, makeState({ status: "checking", stateSequence: 1 })));
    expect(store.state.status).toBe("checking");

    // 重复 / 回退的帧一律丢弃
    subscriber?.(envelope(0, 1, makeState({ status: "error", stateSequence: 99 })));
    expect(store.state.status).toBe("checking");
  });

  it("代际前进的帧一律接受（新代际序号从 0 重新计数）", async () => {
    const store = useUpdateStore();
    await store.init();

    subscriber?.(envelope(5, 1, makeState({ status: "downloading", stateSequence: 5 })));
    expect(store.state.status).toBe("downloading");

    subscriber?.(envelope(0, 2, makeState({ status: "available", stateSequence: 6 })));
    expect(store.state.status).toBe("available");
  });

  it("代际回退的帧一律丢弃", async () => {
    const store = useUpdateStore();
    await store.init();

    subscriber?.(envelope(0, 3, makeState({ status: "downloaded", stateSequence: 9 })));
    expect(store.state.status).toBe("downloaded");

    subscriber?.(envelope(9, 2, makeState({ status: "error", stateSequence: 99 })));
    expect(store.state.status).toBe("downloaded");
  });

  it("不是对象 / 缺字段的推送被忽略而不是炸掉", async () => {
    const store = useUpdateStore();
    await store.init();
    expect(() => {
      subscriber?.(null);
      subscriber?.("nope");
      subscriber?.({ payload: {} });
    }).not.toThrow();
  });
});

describe("快照对账（stateSequence）", () => {
  it("比已知快照更旧的状态被丢弃", async () => {
    api.getState.mockResolvedValue(makeState({ status: "downloaded", stateSequence: 10 }));
    const store = useUpdateStore();
    await store.init();

    // 订阅建立之前发出的在途事件，传输层序号是新的但状态更旧
    subscriber?.(envelope(0, 1, makeState({ status: "checking", stateSequence: 3 })));
    expect(store.state.status).toBe("downloaded");
  });
});

describe("动作转发", () => {
  it("九个动作各自打到对应的 preload 方法上", async () => {
    const store = useUpdateStore();
    await store.init();

    await store.checkNow();
    await store.download();
    await store.cancelDownload();
    await store.setChannel("beta");
    await store.setAutoCheck(false);
    await store.setAutoDownload(true);

    expect(api.checkForUpdates).toHaveBeenCalledWith("manual");
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(api.cancelDownload).toHaveBeenCalledTimes(1);
    expect(api.setUpdateChannel).toHaveBeenCalledWith("beta");
    expect(api.setAutoCheck).toHaveBeenCalledWith(false);
    expect(api.setAutoDownload).toHaveBeenCalledWith(true);
  });

  it("install 收到阻断清单时打开对话框，mode=wait/force 时关闭", async () => {
    api.installAndRestart.mockResolvedValue(
      makeState({
        status: "downloaded",
        stateSequence: 20,
        blockers: [{ kind: "agent", count: 1, label: "有 1 个任务正在运行" }],
      })
    );
    const store = useUpdateStore();
    await store.init();

    await store.install("now");
    expect(store.blockerDialogOpen).toBe(true);

    await store.install("wait");
    expect(store.blockerDialogOpen).toBe(false);
  });

  it("「稍后」既关掉本次会话的横幅，也让 main 记 24 小时", async () => {
    api.getState.mockResolvedValue(
      makeState({ status: "available", stateSequence: 1, candidateVersion: "2.0.0" })
    );
    const store = useUpdateStore();
    await store.init();
    expect(store.bannerVisible).toBe(true);

    await store.dismiss();
    expect(api.dismissVersion).toHaveBeenCalledWith("2.0.0");
    expect(store.bannerVisible).toBe(false);
  });
});

describe("不碰浏览器存储", () => {
  it("store 源码里没有 localStorage / sessionStorage", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./update.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/localStorage|sessionStorage/);
  });
});
