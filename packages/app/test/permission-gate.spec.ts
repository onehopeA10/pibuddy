import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 第五道闸的**真流水线**判据（ADR-0002 D3）。
 *
 * ADR D3 明确引用 CodePilot 的教训：拦截点必须实测，不得靠架构图推断。因此
 * 这里不测「engine 被调用」（那容易恒真），而是把探针通道**穿过 registerHandler
 * 的完整五道闸**跑一遍：未授权时 handler 根本到不了（抛 IPC_PERMISSION_DENIED），
 * 授权后才被调到并返回。一对互斥证据落在真实注册面上。
 *
 * 另有一条**对拍**：临时把第五道闸摘掉（setPermissionGate(null)），同一次未授权
 * 调用立刻变成放行——证明这道闸是真门槛，不是走过场。
 */

const handled = new Map<string, (event: unknown, raw: unknown) => unknown>();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-perm-gate-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-perm-ws-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  shell: { trashItem: vi.fn(async () => undefined), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => {
      if (handled.has(channel)) throw new Error(`DUPLICATE_HANDLE: ${channel}`);
      handled.set(channel, fn);
    },
  },
}));

const { CHANNELS, PERMISSION_PROBE_CAPABILITY_ID, PERMISSION_PROBE_PERMISSION } = await import(
  "@pibuddy/contract"
);
const { __resetRegisteredChannels } = await import("../src/main/ipc-guard.js");
const { setPermissionGate } = await import("../src/main/ipc-guard.js");
const { __setCapabilityPrefsDir, saveCapabilityPrefs } = await import(
  "../src/main/capability/capability-prefs.js"
);
const { __setWorkspaceStoreDataDir, workspaceStore } = await import(
  "../src/main/workspace/workspace-store.js"
);
const permStore = await import("../src/main/permission/permission-store.js");

// 一个能通过第一道闸（senderFrame === mainFrame）的假事件。
const frame = {};
const event = { senderFrame: frame, sender: { id: 7, mainFrame: frame } };
const call = (channel: string, raw: unknown) => handled.get(channel)!(event, raw);

let workspaceId = "";

beforeAll(async () => {
  __setCapabilityPrefsDir(userData);
  saveCapabilityPrefs({ schemaVersion: 1, profileId: "lite", overrides: {} });
  __setWorkspaceStoreDataDir(userData);
  __resetRegisteredChannels();
  handled.clear();
  const { registerAllIpc } = await import("../src/main/ipc-registry.js");
  registerAllIpc();
  workspaceId = workspaceStore().open(wsDir).id;
});

describe("拒绝路径：未授权，第五道闸把探针挡在 handler 之外", () => {
  it("permission:probe 未授权 → 抛 IPC_PERMISSION_DENIED", async () => {
    permStore.__resetPermissionStore();
    await expect(call(CHANNELS.permissionProbe, {})).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });

  it("对拍：摘掉第五道闸后，同一次未授权调用立刻放行（证明闸是真门槛）", async () => {
    permStore.__resetPermissionStore();
    setPermissionGate(null); // 拆掉
    await expect(call(CHANNELS.permissionProbe, {})).resolves.toEqual({ ok: true });
    setPermissionGate(permStore.gateForChannel); // 装回
    await expect(call(CHANNELS.permissionProbe, {})).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });
});

describe("放行路径：授权后 handler 才被调到", () => {
  it("allow-session 之后，同一条探针放行；撤销后又变回拒绝（互斥）", async () => {
    permStore.__resetPermissionStore();
    await permStore.decidePermission({
      capabilityId: PERMISSION_PROBE_CAPABILITY_ID,
      permission: PERMISSION_PROBE_PERMISSION,
      resource: null,
      disposition: "allow-session",
      workspaceId: null,
    });
    await expect(call(CHANNELS.permissionProbe, {})).resolves.toEqual({ ok: true });

    permStore.revokePermission({
      capabilityId: PERMISSION_PROBE_CAPABILITY_ID,
      permission: PERMISSION_PROBE_PERMISSION,
      resource: null,
      scope: "session",
      workspaceId: null,
    });
    await expect(call(CHANNELS.permissionProbe, {})).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });
});

describe("上界：越过 manifest 声明的授权不被记录", () => {
  it("给一个未声明该权限的能力发 allow-session → 不产生任何 session 授权", async () => {
    permStore.__resetPermissionStore();
    // common.preview 不声明 process.git。
    const state = await permStore.decidePermission({
      capabilityId: "common.preview",
      permission: "process.git",
      resource: null,
      disposition: "allow-session",
      workspaceId: null,
    });
    expect(state.sessionGrants).toEqual([]);
    const denied = state.audit.filter((a) => a.kind === "denied");
    expect(denied.length).toBeGreaterThan(0);
  });
});

describe("危险权限的持久化授权必须过主进程原生确认框", () => {
  it("原生确认被取消 → 不落盘", async () => {
    permStore.__resetPermissionStore();
    permStore.setPermissionPrompter({ confirmPersistentGrant: async () => false });
    await permStore.decidePermission({
      capabilityId: PERMISSION_PROBE_CAPABILITY_ID,
      permission: PERMISSION_PROBE_PERMISSION,
      resource: null,
      disposition: "allow-workspace",
      workspaceId,
    });
    expect(workspaceStore().get(workspaceId)?.capabilityGrants ?? []).toEqual([]);
  });

  it("原生确认通过 → 落盘到 workspace，且带该 workspace 的探针放行", async () => {
    permStore.__resetPermissionStore();
    permStore.setPermissionPrompter({ confirmPersistentGrant: async () => true });
    await permStore.decidePermission({
      capabilityId: PERMISSION_PROBE_CAPABILITY_ID,
      permission: PERMISSION_PROBE_PERMISSION,
      resource: null,
      disposition: "allow-workspace",
      workspaceId,
    });
    const grants = workspaceStore().get(workspaceId)?.capabilityGrants ?? [];
    expect(grants.map((g) => [g.capabilityId, g.permission])).toEqual([
      [PERMISSION_PROBE_CAPABILITY_ID, PERMISSION_PROBE_PERMISSION],
    ]);
    // 该 workspace 上下文的探针因落盘授权而放行。
    await expect(call(CHANNELS.permissionProbe, { workspaceId })).resolves.toEqual({ ok: true });
    // 换一个没有该授权的上下文（无 workspace）仍被拒。
    await expect(call(CHANNELS.permissionProbe, {})).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });
});

describe("向后兼容：需求表外的通道不受第五道闸影响", () => {
  it("gateForChannel 对现有通道一律放行（无适用规则）", () => {
    setPermissionGate(permStore.gateForChannel);
    expect(() => permStore.gateForChannel(CHANNELS.settingsGet, {})).not.toThrow();
    expect(() => permStore.gateForChannel(CHANNELS.workspaceFileSave, { workspaceId })).not.toThrow();
    expect(() => permStore.gateForChannel(CHANNELS.piPrompt, {})).not.toThrow();
  });
});
