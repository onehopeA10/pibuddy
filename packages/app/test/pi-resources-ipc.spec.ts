import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 裁定1：本任务新增的通道必须经 ipc-guard 注册并在契约里有 schema。
 *
 * 这里刻意不引用任何 handler 文件路径 —— handler 换个目录之后，「断言某个
 * 文件存在」会空洞通过。真正的判据是 ipc-guard 记录的已注册通道表：它是
 * 运行时的唯一答案，而且只有经 registerHandler（四道闸写死在那里）
 * 才进得去。
 */

const handled = new Map<string, unknown>();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/pibuddy-test", isPackaged: false, getVersion: () => "0.0.0" },
  shell: { trashItem: vi.fn(async () => undefined), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: unknown) => {
      handled.set(channel, fn);
    },
  },
}));

const { CHANNELS, CHANNEL_CONTRACTS, PUSH_CONTRACTS, PUSH_CHANNELS } = await import(
  "@pibuddy/contract"
);
const { registeredChannels, __resetRegisteredChannels } = await import(
  "../src/main/ipc-guard.js"
);
const { PI_RESOURCES_CHANNELS } = await import(
  "../src/main/pi-resources/pi-resources-ipc.js"
);
const { registerAllIpc } = await import("../src/main/ipc-registry.js");

beforeAll(() => {
  __resetRegisteredChannels();
  handled.clear();
  registerAllIpc();
});

describe("EXT-102 的资源 / trust 通道注册面", () => {
  it("7 条资源通道逐一出现在已注册表里，且表长 >= 6", () => {
    const table = registeredChannels();
    for (const channel of PI_RESOURCES_CHANNELS) {
      expect(table).toContain(channel);
    }
    expect(PI_RESOURCES_CHANNELS.length).toBeGreaterThanOrEqual(6);
    expect(table.length).toBeGreaterThanOrEqual(6);
  });

  it("扩展 UI 的两条通道（respond / pending）也在表里", () => {
    const table = registeredChannels();
    expect(table).toContain(CHANNELS.piUiRespond);
    expect(table).toContain(CHANNELS.piUiPending);
  });

  it("已注册表里的每条通道在契约里都有 schema", () => {
    for (const channel of registeredChannels()) {
      expect(CHANNEL_CONTRACTS[channel]).toBeTruthy();
      expect(typeof CHANNEL_CONTRACTS[channel].request.parse).toBe("function");
    }
  });

  it("契约里声明的全部通道都被注册了（没有只写在契约里、没人实现的死通道）", () => {
    const table = new Set(registeredChannels());
    expect(Object.values(CHANNELS).filter((c) => !table.has(c))).toEqual([]);
  });

  it("registerHandler 是唯一入口：ipcMain.handle 收到的集合与注册表一致", () => {
    expect([...handled.keys()].sort()).toEqual(registeredChannels());
  });

  it("两条新推送通道在 PUSH_CONTRACTS 里有 payload schema", () => {
    expect(PUSH_CONTRACTS[PUSH_CHANNELS.piUiExpire]).toBeTruthy();
    expect(PUSH_CONTRACTS[PUSH_CHANNELS.piUiExpireAll]).toBeTruthy();
    // 形状也要对：id + reason / generation + reason
    expect(
      PUSH_CONTRACTS[PUSH_CHANNELS.piUiExpire].safeParse({ id: "a", reason: "timeout" }).success
    ).toBe(true);
    expect(
      PUSH_CONTRACTS[PUSH_CHANNELS.piUiExpire].safeParse({ id: "a", reason: "nope" }).success
    ).toBe(false);
  });
});

describe("CT-15 同一条纪律：资源通道也只收不透明标识", () => {
  it("open-dir 的 schema 恰有 workspaceId / id 两个键，没有 path", async () => {
    const { piResourceIdRequestSchema } = await import("@pibuddy/contract");
    expect(Object.keys(piResourceIdRequestSchema.shape).sort()).toEqual(["id", "workspaceId"]);
  });

  it("install / remove 的 schema 没有任何命令或参数数组形参", async () => {
    const { piPackageCommandRequestSchema } = await import("@pibuddy/contract");
    expect(Object.keys(piPackageCommandRequestSchema.shape).sort()).toEqual([
      "scope",
      "spec",
      "workspaceId",
    ]);
  });
});
