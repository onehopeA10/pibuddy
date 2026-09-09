import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 终端能力包的第五道闸判据（ADR-0002 D3）——**第二个真实的 process.shell 消费者**。
 *
 * 与 permission-gate.spec 同一手法：把终端通道**穿过 registerHandler 的完整五道闸**
 * 跑一遍，不测「engine 被调用」（那容易恒真）。一对互斥证据：
 *
 *  - **拒绝**：未授权 process.shell 时 `terminal:open` 抛 IPC_PERMISSION_DENIED，
 *    PTY 根本没被 spawn；连只读的 `terminal:list` 也被挡。
 *  - **对拍**：临时摘掉第五道闸（setPermissionGate(null)），同一次未授权 `terminal:list`
 *    立刻放行——证明这道闸是真门槛，不是走过场。
 *  - **放行**：allow-session 授权后 `terminal:open` 真的 spawn 出一个 shell（meta.running
 *    为真），用完 kill 掉不留孤儿。
 */

const handled = new Map<string, (event: unknown, raw: unknown) => unknown>();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-term-perm-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-term-ws-"));
const otherWsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-term-other-ws-"));

vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  shell: { trashItem: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => {
      handled.set(channel, fn);
    },
  },
}));

const { CHANNELS, TERMINAL_CAPABILITY_ID, TERMINAL_PERMISSION } = await import("@pibuddy/contract");
const { __resetRegisteredChannels, setPermissionGate } = await import("../src/main/ipc-guard.js");
const { __setWorkspaceDataDir, registerWorkspace } = await import("../src/main/workspace-registry.js");
const { registerTerminalIpc, disposeTerminalResources } = await import(
  "../src/main/terminal/terminal-ipc.js"
);
const permStore = await import("../src/main/permission/permission-store.js");

const frame = {};
const event = { senderFrame: frame, sender: { id: 9, mainFrame: frame } };
const call = (channel: string, raw: unknown): unknown => handled.get(channel)!(event, raw);

let workspaceId = "";
let otherWorkspaceId = "";

beforeAll(() => {
  __setWorkspaceDataDir(userData);
  workspaceId = registerWorkspace(fs.realpathSync.native(wsDir)).workspaceId;
  otherWorkspaceId = registerWorkspace(fs.realpathSync.native(otherWsDir)).workspaceId;
  __resetRegisteredChannels();
  handled.clear();
  registerTerminalIpc();
  setPermissionGate(permStore.gateForChannel);
});

afterAll(() => {
  disposeTerminalResources();
  setPermissionGate(null);
});

describe("拒绝路径：未授权 process.shell，第五道闸把终端挡在 handler 之外", () => {
  it("terminal:open 未授权 → 抛 IPC_PERMISSION_DENIED（PTY 没被 spawn）", async () => {
    permStore.__resetPermissionStore();
    await expect(call(CHANNELS.terminalOpen, { workspaceId, profileId: null, cols: 80, rows: 24 })).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
  });

  it("连只读的 terminal:list 也被挡（终端会话本身就是敏感信息）", async () => {
    permStore.__resetPermissionStore();
    await expect(call(CHANNELS.terminalList, { workspaceId })).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });

  it("对拍：摘掉第五道闸后，同一次未授权 terminal:list 立刻放行（证明闸是真门槛）", async () => {
    permStore.__resetPermissionStore();
    setPermissionGate(null); // 拆掉
    await expect(call(CHANNELS.terminalList, { workspaceId })).resolves.toEqual({ tabs: [] });
    setPermissionGate(permStore.gateForChannel); // 装回
    await expect(call(CHANNELS.terminalList, { workspaceId })).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });
});

describe("放行路径：授权后 terminal:open 真的 spawn 出 shell", () => {
  it("allow-session 之后 open 出一个在运行的 tab；撤销后再 open 又被拒（互斥）", async () => {
    permStore.__resetPermissionStore();
    await permStore.decidePermission({
      capabilityId: TERMINAL_CAPABILITY_ID,
      permission: TERMINAL_PERMISSION,
      resource: null,
      disposition: "allow-session",
      workspaceId: null,
    });

    const meta = (await call(CHANNELS.terminalOpen, {
      workspaceId,
      profileId: null,
      cols: 80,
      rows: 24,
    })) as { tabId: string; running: boolean };
    expect(meta.running).toBe(true);
    expect(meta.tabId).toBeTruthy();

    // 用完即杀，不留孤儿。
    await call(CHANNELS.terminalKill, { workspaceId, tabId: meta.tabId });

    // 撤销 session 授权后，同一条 open 又被第五道闸挡下（互斥闭环）。
    permStore.revokePermission({
      capabilityId: TERMINAL_CAPABILITY_ID,
      permission: TERMINAL_PERMISSION,
      resource: null,
      scope: "session",
      workspaceId: null,
    });
    await expect(
      call(CHANNELS.terminalOpen, { workspaceId, profileId: null, cols: 80, rows: 24 })
    ).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });

  it("workspace B 不能经 IPC 操作 A 的 tab，A 的七种操作仍全部可用", async () => {
    permStore.__resetPermissionStore();
    await permStore.decidePermission({
      capabilityId: TERMINAL_CAPABILITY_ID,
      permission: TERMINAL_PERMISSION,
      resource: null,
      disposition: "allow-session",
      workspaceId: null,
    });

    const meta = (await call(CHANNELS.terminalOpen, {
      workspaceId,
      profileId: null,
      cols: 80,
      rows: 24,
    })) as { tabId: string; generation: number };

    await expect(
      call(CHANNELS.terminalInput, { workspaceId: otherWorkspaceId, tabId: meta.tabId, data: "blocked" })
    ).resolves.toMatchObject({ ok: false });
    await expect(
      call(CHANNELS.terminalResize, { workspaceId: otherWorkspaceId, tabId: meta.tabId, cols: 100, rows: 30 })
    ).resolves.toMatchObject({ ok: false });
    await expect(
      call(CHANNELS.terminalSnapshot, { workspaceId: otherWorkspaceId, tabId: meta.tabId })
    ).resolves.toMatchObject({ found: false });
    await expect(
      call(CHANNELS.terminalClear, { workspaceId: otherWorkspaceId, tabId: meta.tabId })
    ).resolves.toMatchObject({ ok: false });
    await expect(
      call(CHANNELS.terminalKill, { workspaceId: otherWorkspaceId, tabId: meta.tabId })
    ).resolves.toMatchObject({ ok: false });
    await expect(
      call(CHANNELS.terminalRestart, { workspaceId: otherWorkspaceId, tabId: meta.tabId })
    ).rejects.toThrow(/TERMINAL_TAB_UNKNOWN/);
    await expect(
      call(CHANNELS.terminalRename, { workspaceId: otherWorkspaceId, tabId: meta.tabId, title: "blocked" })
    ).rejects.toThrow(/TERMINAL_TAB_UNKNOWN/);

    await expect(
      call(CHANNELS.terminalInput, { workspaceId, tabId: meta.tabId, data: "" })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      call(CHANNELS.terminalResize, { workspaceId, tabId: meta.tabId, cols: 120, rows: 40 })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      call(CHANNELS.terminalSnapshot, { workspaceId, tabId: meta.tabId })
    ).resolves.toMatchObject({ found: true, generation: meta.generation });
    await expect(
      call(CHANNELS.terminalClear, { workspaceId, tabId: meta.tabId })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      call(CHANNELS.terminalRename, { workspaceId, tabId: meta.tabId, title: "allowed" })
    ).resolves.toMatchObject({ title: "allowed" });
    await expect(
      call(CHANNELS.terminalRestart, { workspaceId, tabId: meta.tabId })
    ).resolves.toMatchObject({ generation: meta.generation + 1, running: true });
    await expect(
      call(CHANNELS.terminalKill, { workspaceId, tabId: meta.tabId })
    ).resolves.toMatchObject({ ok: true });
  });
});
