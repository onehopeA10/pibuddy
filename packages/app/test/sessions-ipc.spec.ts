import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 裁定1 + 裁定5：IPC 注册面的**结构**断言。
 *
 * 这里刻意不引用任何 handler 文件路径 —— handler 从 ipc.ts 拆到各域的
 * *-ipc.ts 之后，「断言某个文件存在」会在下一次改名时空洞通过。真正的
 * 判据是 ipc-guard 记录的已注册通道表：它是运行时的唯一答案，而且只有
 * 经 registerHandler（四道闸写死在那里）才进得去。
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

const { CHANNELS, CHANNEL_CONTRACTS } = await import("@pibuddy/contract");
const { registeredChannels, __resetRegisteredChannels } = await import(
  "../src/main/ipc-guard.js"
);
const { SESSIONS_CHANNELS } = await import("../src/main/sessions/sessions-ipc.js");
const { registerAllIpc } = await import("../src/main/ipc-registry.js");

beforeAll(() => {
  __resetRegisteredChannels();
  handled.clear();
  registerAllIpc();
});

describe("会话中心恰 9 条通道（裁定5）", () => {
  it("SESSIONS_CHANNELS 的内容与顺序无关地等于那 9 个常量", () => {
    const expected = [
      "sessions:export-html",
      "sessions:get-draft",
      "sessions:purge",
      "sessions:query",
      "sessions:read-history",
      "sessions:rename",
      "sessions:save-draft",
      "sessions:set-pinned",
      "sessions:set-status",
    ];
    expect(SESSIONS_CHANNELS.length).toBe(9);
    expect([...SESSIONS_CHANNELS].sort()).toEqual(expected);
  });

  it("那条一次性全量枚举的 sessions:list 已经不存在", () => {
    expect(Object.values(CHANNELS)).not.toContain("sessions:list");
    expect(registeredChannels()).not.toContain("sessions:list");
  });
});

describe("registerAllIpc 之后的注册面（裁定1）", () => {
  it("9 条会话通道逐一出现在 ipc-guard 的已注册表里", () => {
    const table = registeredChannels();
    for (const channel of SESSIONS_CHANNELS) {
      expect(table).toContain(channel);
    }
    expect(table.length).toBeGreaterThanOrEqual(9);
  });

  it("已注册表里的每条通道在契约里都有 schema", () => {
    for (const channel of registeredChannels()) {
      expect(CHANNEL_CONTRACTS[channel]).toBeTruthy();
      expect(typeof CHANNEL_CONTRACTS[channel].request.parse).toBe("function");
    }
  });

  it("契约里声明的全部通道都被注册了（没有只写在契约里、没人实现的死通道）", () => {
    const table = new Set(registeredChannels());
    const missing = Object.values(CHANNELS).filter((c) => !table.has(c));
    expect(missing).toEqual([]);
  });

  it("registerHandler 是唯一入口：ipcMain.handle 收到的通道集合与注册表一致", () => {
    expect([...handled.keys()].sort()).toEqual(registeredChannels());
  });
});

describe("CT-15：跨进程只有不透明 sessionId", () => {
  it("sessions:read-history 的 schema 恰有 beforeOffset / limit / sessionId 三个键", async () => {
    const { readHistoryRequestSchema } = await import("@pibuddy/contract");
    expect(Object.keys(readHistoryRequestSchema.shape).sort()).toEqual([
      "beforeOffset",
      "limit",
      "sessionId",
    ]);
  });

  it("pi:switch-session 也只收 sessionId，不再收路径", async () => {
    const { piSwitchSessionRequestSchema } = await import("@pibuddy/contract");
    expect(Object.keys(piSwitchSessionRequestSchema.shape)).toEqual(["sessionId"]);
  });
});
