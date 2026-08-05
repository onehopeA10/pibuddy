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
  it("命名空间集合与 api/*.ts 一一对应，一个不多一个不少", () => {
    // update 是 UPD-001 加进来的第八个命名空间（九个动作 + 一个事件订阅）；
    // piResources 是 EXT-102（资源中心 + project trust）；
    // diagnostics 是 OBS-101（诊断包预览 / 导出 / 健康报告）；
    // providers 是 PROV-101（Provider 与模型中心 + 用量统计）；
    // workspace 是 FS-101 / FS-102（文件树 / 搜索 / 读写 / Agent 变更集）；
    // preview 与 artifacts 是 ART-101 / ART-102（沙箱预览 + 产物库）。
    // 新增命名空间 = 新增 api/<ns>.ts + 在 index.ts 加一行 + 在这里加一行，
    // 三处对不上就说明有人绕过了那条唯一的接口面定义。
    // capabilities 是 ADR-0002 第一阶段（能力包与 Profile）。
    expect(Object.keys(api).sort()).toEqual([
      "agentPool",
      "artifacts",
      "capabilities",
      "childAgent",
      "connector",
      "dashboard",
      "diagnostics",
      "dialog",
      "edu",
      "file",
      "git",
      "home",
      "homeAdvisor",
      "homeAutomation",
      "mcp",
      "memory",
      "officeSkills",
      "permission",
      "pi",
      "piResources",
      "preview",
      "promptLibrary",
      "providers",
      "remote",
      "sessions",
      "settings",
      "shell",
      "stt",
      "tasks",
      "terminal",
      "update",
      "workflow",
      "workspace",
    ]);
  });

  it("sessions 命名空间的每个方法都各自打到自己那条通道，一条不漏", async () => {
    await api.sessions.query("ws");
    await api.sessions.rename("ws", "s", "n");
    await api.sessions.setPinned("ws", "s", true);
    await api.sessions.setStatus("ws", "s", "archived");
    await api.sessions.purge("ws", "s");
    await api.sessions.getDraft("ws", "s");
    await api.sessions.saveDraft("ws", "s", {
      text: "",
      attachments: [],
      queue: { steering: [], followUp: [] },
      updatedAt: 0,
    });
    await api.sessions.exportHtml("ws", "s");
    await api.sessions.readHistoryBefore({
      workspaceId: "ws",
      sessionId: "s",
      beforeOffset: 10,
      limit: 5,
    });
    // tree() 是 common.session-tree 能力的归一化视图，无参、打到 session-tree:graph
    // （不是 sessions:*）——它挂在 sessions 命名空间下，但通道归会话树能力所有。
    await api.sessions.tree();

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
        CHANNELS.sessionTreeGraph,
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
