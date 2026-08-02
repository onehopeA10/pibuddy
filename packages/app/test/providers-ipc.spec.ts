/**
 * [裁定1] Provider / 用量通道的注册面（PROV-101）。
 *
 * 断言的是 **ipc-guard 记录的运行时注册表**，不是任何一个 handler 文件的
 * 存在。后者在文件改名后会空洞通过 —— 而「文件还在但没人调 register」正是
 * 三大门禁全绿、功能却是死的那一类故障。
 *
 * 三条：
 *   (a) 本任务新增的通道逐一出现在注册表里；
 *   (b) 注册表里的每个通道在契约的 CHANNEL_CONTRACTS 里都有 schema；
 *   (c) 新增通道数 >= 5。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CHANNEL_CONTRACTS, CHANNELS, type InvokeChannel } from "@pibuddy/contract";

/** ipcMain.handle 的调用记录：channel → handler。 */
const handled = new Map<string, unknown>();

vi.mock("electron", () => ({
  app: { getPath: () => process.cwd() },
  ipcMain: {
    handle: (channel: string, handler: unknown) => handled.set(channel, handler),
    on: vi.fn(),
  },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {},
  nativeTheme: { on: vi.fn() },
}));

/** 本任务新增的通道（PROV-101 恰 10 条：7 provider + 3 usage）。 */
const NEW_CHANNELS: InvokeChannel[] = [
  CHANNELS.providersList,
  CHANNELS.providersSaveKey,
  CHANNELS.providersRemove,
  CHANNELS.providersAddCustom,
  CHANNELS.providersTest,
  CHANNELS.providersDiscoverModels,
  CHANNELS.providersSetScopeDefault,
  CHANNELS.usageQuery,
  CHANNELS.usageExport,
  CHANNELS.usageRecord,
];

let registeredChannels: () => InvokeChannel[];

beforeAll(async () => {
  const guard = await import("../src/main/ipc-guard.js");
  guard.__resetRegisteredChannels();
  registeredChannels = guard.registeredChannels;
  const providersIpc = await import("../src/main/providers/providers-ipc.js");
  providersIpc.registerProvidersIpc();
  providersIpc.registerUsageIpc();
});

describe("注册面", () => {
  it("(a) 本任务的 10 个通道逐一出现在 ipc-guard 的注册表里", () => {
    const registered = new Set(registeredChannels());
    for (const channel of NEW_CHANNELS) {
      expect(registered.has(channel), `未注册：${channel}`).toBe(true);
    }
  });

  it("(b) 注册表里的每个通道在契约里都有 schema", () => {
    for (const channel of registeredChannels()) {
      expect(
        Object.prototype.hasOwnProperty.call(CHANNEL_CONTRACTS, channel),
        `契约缺 schema：${channel}`
      ).toBe(true);
      expect(CHANNEL_CONTRACTS[channel].request).toBeDefined();
      expect(CHANNEL_CONTRACTS[channel].response).toBeDefined();
    }
  });

  it("(c) 注册表长度 >= 5", () => {
    expect(registeredChannels().length).toBeGreaterThanOrEqual(5);
  });

  it("注册确实经 ipcMain.handle 落地（不是只往 Set 里塞了个名字）", () => {
    for (const channel of NEW_CHANNELS) {
      expect(handled.has(channel), `ipcMain.handle 未收到：${channel}`).toBe(true);
    }
  });
});

describe("[裁定1] 全仓 ipcMain 直接注册点为 0", () => {
  it("providers-ipc.ts 里不出现 ipcMain.handle / ipcMain.on", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../src/main/providers/providers-ipc.ts"),
      "utf8"
    );
    expect(/ipcMain\.(handle|on)\(/.test(source)).toBe(false);
    expect(source.includes("registerHandler(")).toBe(true);
  });
});
