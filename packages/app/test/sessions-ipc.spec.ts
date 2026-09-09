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
const { BUILT_IN_CAPABILITIES } = await import(
  "../src/main/capability/capability-manifests.js"
);
const { enabledCapabilityIds } = await import("../src/main/capability/capability-state.js");

beforeAll(() => {
  __resetRegisteredChannels();
  handled.clear();
  registerAllIpc();
});

describe("会话中心恰 11 条通道（裁定5）", () => {
  it("SESSIONS_CHANNELS 的内容与顺序无关地等于那 11 个常量", () => {
    const expected = [
      "sessions:export-html",
      "sessions:get-draft",
      "sessions:import-run",
      "sessions:import-scan",
      "sessions:purge",
      "sessions:query",
      "sessions:read-history",
      "sessions:rename",
      "sessions:save-draft",
      "sessions:set-pinned",
      "sessions:set-status",
    ];
    expect(SESSIONS_CHANNELS.length).toBe(11);
    expect([...SESSIONS_CHANNELS].sort()).toEqual(expected);
  });

  it("那条一次性全量枚举的 sessions:list 已经不存在", () => {
    expect(Object.values(CHANNELS)).not.toContain("sessions:list");
    expect(registeredChannels()).not.toContain("sessions:list");
  });
});

describe("registerAllIpc 之后的注册面（裁定1）", () => {
  it("11 条会话通道逐一出现在 ipc-guard 的已注册表里", () => {
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
    // 默认 Profile 下**未启用**的能力（如第一个垂直包 coding.git，默认只在
    // 「编码」Profile 启用）合法地不注册它的通道——那不是「死通道」，是
    // feature gate 生效的结果。把这些通道排除后，剩下的 missing 才是真正
    // 「写在契约里却没人实现」的判据（对拍：capability-gate.spec 在 lite 下
    // 反过来断言这些通道一条都不在）。
    const enabled = new Set(enabledCapabilityIds());
    const disabledChannels = new Set(
      BUILT_IN_CAPABILITIES.filter((m) => !enabled.has(m.id)).flatMap((m) => [...m.channels])
    );
    const missing = Object.values(CHANNELS).filter(
      (c) => !table.has(c) && !disabledChannels.has(c)
    );
    expect(missing).toEqual([]);
  });

  it("registerHandler 是唯一入口：ipcMain.handle 收到的通道集合与注册表一致", () => {
    expect([...handled.keys()].sort()).toEqual(registeredChannels());
  });
});

describe("CT-15：跨进程只有不透明标识", () => {
  it("sessions:read-history 的 schema 恰有 beforeOffset / limit / sessionId / workspaceId 四个键", async () => {
    const { readHistoryRequestSchema } = await import("@pibuddy/contract");
    expect(Object.keys(readHistoryRequestSchema.shape).sort()).toEqual([
      "beforeOffset",
      "limit",
      "sessionId",
      "workspaceId",
    ]);
  });

  /**
   * sessionId 只在一个工作区之内唯一。复制一份 .jsonl、从备份恢复、或两个
   * 工作区共用一个自定义 session-dir，都能让同一个 id 在索引里出现两行 ——
   * 少了 workspaceId，rename / set-status / purge / 草稿读写就可能落到另一个
   * 工作区的会话上，而 purge 那一条不可逆。
   */
  it("会动到具体会话的通道，入参一律带 workspaceId", async () => {
    const contract = await import("@pibuddy/contract");
    const scoped = [
      contract.sessionRenameRequestSchema,
      contract.sessionSetPinnedRequestSchema,
      contract.sessionSetStatusRequestSchema,
      contract.sessionIdRequestSchema,
      contract.sessionSaveDraftRequestSchema,
      contract.readHistoryRequestSchema,
    ];
    for (const schema of scoped) {
      expect(Object.keys(schema.shape)).toContain("workspaceId");
      // 必填而不是可选：漏传要在编译/校验期就炸，不能等到会话被改到别处
      expect(schema.safeParse({ sessionId: "s", name: "n" }).success).toBe(false);
    }
  });

  it("pi:switch-session 也只收 sessionId，不再收路径", async () => {
    const { piSwitchSessionRequestSchema } = await import("@pibuddy/contract");
    expect(Object.keys(piSwitchSessionRequestSchema.shape)).toEqual(["workspaceId", "sessionId"]);
  });
});
