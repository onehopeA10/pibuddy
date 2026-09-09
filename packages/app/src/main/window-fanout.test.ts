import { afterEach, describe, expect, it, vi } from "vitest";

const windows: Array<{
  isDestroyed: () => boolean;
  webContents: { id: number; send: ReturnType<typeof vi.fn> };
}> = [];

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => windows,
  },
}));

const { fanoutToSubscribed, unsubscribeWindow, subscribeWindow, __resetWindowFanout } =
  await import("./window-fanout.js");

function fakeWin(id: number) {
  return {
    isDestroyed: () => false,
    webContents: { id, send: vi.fn() },
  };
}

afterEach(() => {
  windows.length = 0;
  __resetWindowFanout();
});

describe("window-fanout", () => {
  it("单窗口时 send 次数与 getAllWindows 全发相等", () => {
    const a = fakeWin(1);
    windows.push(a);
    fanoutToSubscribed("agent-pool:event", { n: 1 });
    expect(a.webContents.send).toHaveBeenCalledTimes(1);
    expect(a.webContents.send).toHaveBeenCalledWith("agent-pool:event", { n: 1 });
  });

  it("两窗口默认都收到；退订后只剩订阅者", () => {
    const a = fakeWin(1);
    const b = fakeWin(2);
    windows.push(a, b);
    fanoutToSubscribed("terminal:event", { n: 1 });
    expect(a.webContents.send).toHaveBeenCalledTimes(1);
    expect(b.webContents.send).toHaveBeenCalledTimes(1);

    unsubscribeWindow(2);
    fanoutToSubscribed("terminal:event", { n: 2 });
    expect(a.webContents.send).toHaveBeenCalledTimes(2);
    expect(b.webContents.send).toHaveBeenCalledTimes(1);

    subscribeWindow(2);
    fanoutToSubscribed("terminal:event", { n: 3 });
    expect(b.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("跳过已销毁窗口", () => {
    const dead = {
      isDestroyed: () => true,
      webContents: { id: 9, send: vi.fn() },
    };
    windows.push(dead);
    fanoutToSubscribed("agent-pool:event", {});
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });
});
