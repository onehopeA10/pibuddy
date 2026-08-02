import { describe, expect, it, vi } from "vitest";

/**
 * 裁定1 的结构断言，落在**注册面**上而不是某个 handler 文件上（OBS-101）。
 *
 * 断言三件事：
 *   (a) 本任务新增的三条 diagnostics 通道确实出现在 ipc-guard 的已注册表里
 *   (b) 表里每条通道在契约的 CHANNEL_CONTRACTS 里都有 schema
 *   (c) 表长度 >= 3
 *
 * 不引用任何 handler 文件路径：handler 换目录、改文件名之后本断言依然成立，
 * 这正是 CT-05 里「assertMainFrame 钉死在 ipc.ts」那个教训的反面。
 */

const handled: string[] = [];

vi.mock("electron", () => {
  const win = {
    isDestroyed: () => false,
    webContents: { id: 1, send: vi.fn() },
  };
  return {
    ipcMain: {
      handle: (channel: string) => {
        handled.push(channel);
      },
    },
    app: {
      getPath: (name: string) => `/tmp/pibuddy-test/${name}`,
      getVersion: () => "0.1.0",
      getLocale: () => "zh-CN",
      isPackaged: false,
      on: vi.fn(),
      whenReady: () => Promise.resolve(),
    },
    BrowserWindow: Object.assign(
      function BrowserWindow() {
        return win;
      },
      { getAllWindows: () => [win], fromWebContents: () => win }
    ),
    dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
    shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(), openPath: vi.fn() },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s),
      decryptString: (b: Buffer) => b.toString(),
    },
    session: { defaultSession: { setPermissionRequestHandler: vi.fn() } },
    net: { fetch: vi.fn() },
  };
});

const { registerDiagnosticsIpc } = await import("../src/main/diagnostics/diagnostics-ipc.js");
const { registeredChannels, __resetRegisteredChannels } = await import(
  "../src/main/ipc-guard.js"
);
const { CHANNELS, CHANNEL_CONTRACTS, isKnownChannel } = await import("@pibuddy/contract");

/** 本任务新增的三条通道。 */
const NEW_CHANNELS = [
  CHANNELS.diagnosticsPreviewBundle,
  CHANNELS.diagnosticsExportBundle,
  CHANNELS.diagnosticsGetReport,
];

describe("diagnostics 通道经 ipc-guard 注册", () => {
  it("三条通道逐一出现在已注册表里，且每条在契约里有 schema", () => {
    __resetRegisteredChannels();
    handled.length = 0;

    registerDiagnosticsIpc();

    const registered = registeredChannels();
    for (const channel of NEW_CHANNELS) {
      expect(registered).toContain(channel);
      // 契约里有对应条目 —— 没有 schema 的通道等于没有第二道闸
      expect(isKnownChannel(channel)).toBe(true);
      expect(CHANNEL_CONTRACTS[channel]).toBeDefined();
      expect(typeof CHANNEL_CONTRACTS[channel].request.parse).toBe("function");
    }
    expect(registered.length).toBeGreaterThanOrEqual(3);

    // 注册确实落到了 ipcMain 上（而不是只进了那张表）
    for (const channel of NEW_CHANNELS) expect(handled).toContain(channel);
  });

  it("表里的每一条通道在 CHANNEL_CONTRACTS 里都有 schema", () => {
    for (const channel of registeredChannels()) {
      expect(CHANNEL_CONTRACTS[channel]).toBeDefined();
    }
  });
});
