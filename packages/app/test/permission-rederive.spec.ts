import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **落库之后被篡改的授权记录，读回时必须被拒**（SEC-003 硬化 / 交付 1）。
 *
 * `WorkspaceProfile.capabilityGrants` 落在 sqlite 的一列 JSON 文本里，
 * `workspace-store` 用 `JSON.parse` 原样交回。也就是说：`decidePermission` 在
 * 写入前做的全部校验，对一条**绕过写入路径**直接改进去的记录，一条都没生效过。
 * 本文件的每个用例都走同一条路——直接改库，再走真流水线（第五道闸 + 探针通道），
 * 断言那条记录**不起作用**且留下了审计。
 *
 * 每个「被拒」用例都配一条互斥对照：把那条记录的毛病修掉，同一次调用立刻放行。
 * 没有对照的话，「被拒」可能只是因为别的原因恒假。
 */

const handled = new Map<string, (event: unknown, raw: unknown) => unknown>();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-perm-rederive-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-perm-rederive-ws-"));

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
const { __setCapabilityPrefsDir, saveCapabilityPrefs } = await import(
  "../src/main/capability/capability-prefs.js"
);
const { __setWorkspaceStoreDataDir, workspaceStore } = await import(
  "../src/main/workspace/workspace-store.js"
);
const permStore = await import("../src/main/permission/permission-store.js");

const frame = {};
const event = { senderFrame: frame, sender: { id: 7, mainFrame: frame } };
const call = (channel: string, raw: unknown) => handled.get(channel)!(event, raw);

let workspaceId = "";

/** 直接把任意形状写进 capability_grants 那一列（绕开 decidePermission）。 */
function tamper(...records: unknown[]): void {
  workspaceStore().update(workspaceId, {
    capabilityGrants: records as never,
  });
}

/** 一条**合法**的探针授权：对照组用它证明「拒绝」不是恒假。 */
const validProbeGrant = {
  capabilityId: PERMISSION_PROBE_CAPABILITY_ID,
  permission: PERMISSION_PROBE_PERMISSION,
  resource: null,
  grantedAt: 1,
};

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

beforeEach(() => {
  permStore.__resetPermissionStore();
  tamper();
});

describe("对照组：未经篡改的落库授权照常生效", () => {
  it("合法记录 → 探针放行（证明后面的「拒绝」不是恒假）", async () => {
    tamper(validProbeGrant);
    await expect(call(CHANNELS.permissionProbe, { workspaceId })).resolves.toEqual({ ok: true });
    expect(permStore.describePermissions(workspaceId).workspaceGrants).toEqual([validProbeGrant]);
  });
});

describe("篡改后的记录读回即被拒（再推导边界）", () => {
  it("多余字段：同一条授权加一个键就不再可用", async () => {
    tamper({ ...validProbeGrant, sneaky: true });
    await expect(call(CHANNELS.permissionProbe, { workspaceId })).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
    const state = permStore.describePermissions(workspaceId);
    expect(state.workspaceGrants).toEqual([]);
    expect(
      state.audit.some((a) => a.kind === "denied" && /落库授权再推导失败/.test(a.detail ?? ""))
    ).toBe(true);
  });

  it("非法权限原子：permission 里塞了一整条命令", async () => {
    tamper({ ...validProbeGrant, permission: "process.git; rm -rf /" });
    await expect(call(CHANNELS.permissionProbe, { workspaceId })).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
    expect(permStore.describePermissions(workspaceId).workspaceGrants).toEqual([]);
  });

  it("能力未声明该权限：手改 capabilityId 换一个够不到 process.git 的能力", () => {
    tamper({ ...validProbeGrant, capabilityId: "common.preview" });
    const state = permStore.describePermissions(workspaceId);
    expect(state.workspaceGrants).toEqual([]);
    expect(
      state.audit.some((a) => a.kind === "denied" && /未声明权限/.test(a.detail ?? ""))
    ).toBe(true);
  });

  it("network.local 的通配授权：一行手改就等于「放开整个内网」——读回时被挡", () => {
    tamper({
      capabilityId: "home.assistant",
      permission: "network.local",
      resource: null,
      grantedAt: 1,
    });
    const denied = permStore.describePermissions(workspaceId);
    expect(denied.workspaceGrants).toEqual([]);
    expect(
      denied.audit.some((a) => a.kind === "denied" && /未绑定具体 host:port/.test(a.detail ?? ""))
    ).toBe(true);

    // 对照：同一条记录绑上具体端点即被接受——差别只在 resource 形态。
    permStore.__resetPermissionStore();
    tamper({
      capabilityId: "home.assistant",
      permission: "network.local",
      resource: "10.0.0.2:8123",
      grantedAt: 1,
    });
    expect(permStore.describePermissions(workspaceId).workspaceGrants).toHaveLength(1);
  });

  it("resource 里的 BiDi 覆写字符：视觉伪装的授权不可用", () => {
    tamper({ ...validProbeGrant, resource: "/tmp/‮evil" });
    const state = permStore.describePermissions(workspaceId);
    expect(state.workspaceGrants).toEqual([]);
    expect(state.audit.some((a) => /BiDi/.test(a.detail ?? ""))).toBe(true);
  });

  it("坏记录不会让整张表读不出来：好坏混排时好的那条照常可用", async () => {
    tamper({ ...validProbeGrant, sneaky: true }, validProbeGrant);
    expect(permStore.describePermissions(workspaceId).workspaceGrants).toEqual([validProbeGrant]);
    await expect(call(CHANNELS.permissionProbe, { workspaceId })).resolves.toEqual({ ok: true });
  });
});

describe("审计留痕本身也被净化（BiDi 不得进日志）", () => {
  it("坏记录的 resource 进审计时，覆写码位已被替换成可见转义", () => {
    tamper({ ...validProbeGrant, resource: "/tmp/‮evil" });
    const state = permStore.describePermissions(workspaceId);
    const entry = state.audit.find((a) => a.resource !== null && a.resource.includes("/tmp/"));
    expect(entry).toBeDefined();
    expect(entry!.resource).not.toContain("‮");
    expect(entry!.resource).toContain("\\u{202E}");
  });

  it("decidePermission 收到带覆写字符的申请：拒绝记录，且审计里不留原始码位", async () => {
    const state = await permStore.decidePermission({
      capabilityId: PERMISSION_PROBE_CAPABILITY_ID,
      permission: PERMISSION_PROBE_PERMISSION,
      resource: "/tmp/‮evil",
      disposition: "allow-session",
      workspaceId,
    });
    expect(state.sessionGrants).toEqual([]);
    const denied = state.audit.filter((a) => a.kind === "denied");
    expect(denied.length).toBeGreaterThan(0);
    for (const a of state.audit) {
      expect(a.resource ?? "").not.toContain("‮");
      expect(a.detail ?? "").not.toContain("‮");
    }
  });
});
