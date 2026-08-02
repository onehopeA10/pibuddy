import { describe, expect, it, vi } from "vitest";

/**
 * preload 分层不留悬空调用。
 *
 * `Object.keys(api)` 必须**恰好**等于那八个命名空间：多挂一个不会有任何
 * 报错（只是接口面悄悄变大），漏挂一个则要等到用户点到那个功能才暴露成
 * 一句 "Cannot read properties of undefined"。
 */

const invoked: string[] = [];
const listeners: string[] = [];

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(async (channel: string) => {
      invoked.push(channel);
      return null;
    }),
    on: vi.fn((channel: string) => {
      listeners.push(channel);
    }),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn(() => "/tmp/dropped.png") },
}));

// preload 运行在渲染进程上下文里，bridge.ts 会挂 pagehide 监听
(globalThis as unknown as { window: unknown }).window = { addEventListener: vi.fn() };

const { api } = await import("../src/preload/api/index.js");
const { CHANNELS } = await import("@pibuddy/contract/channels");

describe("api 聚合对象", () => {
  it("恰含 pi / sessions / settings / dialog / file / shell / stt / update 八个键", () => {
    // update 是 UPD-001 加进来的第八个命名空间（九个动作 + 一个事件订阅）。
    expect(Object.keys(api).sort()).toEqual([
      "dialog",
      "file",
      "pi",
      "sessions",
      "settings",
      "shell",
      "stt",
      "update",
    ]);
    expect(Object.keys(api).length).toBe(8);
  });

  it("sessions 命名空间覆盖全部 9 条通道，一条不漏", async () => {
    await api.sessions.query("ws");
    await api.sessions.rename("s", "n");
    await api.sessions.setPinned("s", true);
    await api.sessions.setStatus("s", "archived");
    await api.sessions.purge("s");
    await api.sessions.getDraft("s");
    await api.sessions.saveDraft("s", {
      text: "",
      attachments: [],
      queue: { steering: [], followUp: [] },
      updatedAt: 0,
    });
    await api.sessions.exportHtml("s");
    await api.sessions.readHistoryBefore({ sessionId: "s", beforeOffset: 10, limit: 5 });

    expect(invoked.sort()).toEqual(
      [
        CHANNELS.sessionsQuery,
        CHANNELS.sessionsRename,
        CHANNELS.sessionsSetPinned,
        CHANNELS.sessionsSetStatus,
        CHANNELS.sessionsPurge,
        CHANNELS.sessionsGetDraft,
        CHANNELS.sessionsSaveDraft,
        CHANNELS.sessionsExportHtml,
        CHANNELS.sessionsReadHistory,
      ].sort()
    );
  });

  it("pi 上没有任何形式的通用命令转发口", () => {
    const keys = Object.keys(api.pi);
    expect(keys).not.toContain("command");
    expect(keys).not.toContain("send");
    expect(keys).not.toContain("invoke");
  });

  it("三条 push 通道由 pi.events 订阅", () => {
    api.pi.events.onEvent(() => undefined);
    api.pi.events.onUiRequest(() => undefined);
    api.pi.events.onExit(() => undefined);
    expect(listeners).toEqual(["pi:event", "pi:ui-request", "pi:exit"]);
  });
});
