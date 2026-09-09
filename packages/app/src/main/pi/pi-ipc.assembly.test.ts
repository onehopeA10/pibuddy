import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * registerPiIpc 的装配行为测（F-004）。
 * kernel-boundary 只点名这个函数；这里断言它真的把 pi:start / pi:stop
 * 写进 ipc-guard 注册表。
 */
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/pibuddy-pi-ipc-assembly", isPackaged: false, getVersion: () => "0.0.0" },
  shell: { trashItem: vi.fn(async () => undefined), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

const { CHANNELS } = await import("@pibuddy/contract");
const { registeredChannels, __resetRegisteredChannels } = await import("../ipc-guard.js");
const { registerPiIpc } = await import("./pi-ipc.js");

beforeAll(() => {
  __resetRegisteredChannels();
  registerPiIpc();
});

describe("registerPiIpc assembly", () => {
  it("registers pi:start and pi:stop via ipc-guard", () => {
    const table = registeredChannels();
    expect(table).toContain(CHANNELS.piStart);
    expect(table).toContain(CHANNELS.piStop);
    expect(CHANNELS.piStart).toBe("pi:start");
  });
});
