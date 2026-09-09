import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "a".repeat(32);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-pi-res-perm-"));
const handled = new Map<string, (event: unknown, raw: unknown) => unknown>();
const { execFileMock, trustState } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  trustState: { effective: "allow" as "allow" | "deny" },
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.0.0" },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw: unknown) => unknown) => {
      handled.set(channel, handler);
    },
  },
}));
vi.mock("../src/main/workspace-registry.js", () => ({
  requireWorkspaceRoot: () => "/tmp/pibuddy-workspace",
}));
vi.mock("../src/main/pi-launcher.js", () => ({
  buildPiSpawn: () => ({ command: process.execPath, prefixArgs: [], env: process.env }),
}));
vi.mock("../src/main/settings.js", () => ({ loadSettings: () => ({}) }));
vi.mock("../src/main/pi-resources/project-trust.js", () => ({
  currentProjectTrust: async () => ({
    workspaceId: WORKSPACE_ID,
    effective: trustState.effective,
    defaultProjectTrust: "ask",
    saved: "none",
    needsPrompt: false,
    hasProjectResources: true,
    resources: [],
    note: "",
  }),
  __resetProjectTrustState: vi.fn(),
  setSessionTrustDecision: vi.fn(),
}));
vi.mock("../src/main/pi-resources/resource-scanner.js", () => ({
  scanResources: async () => ({
    resources: [],
    trust: {
      workspaceId: WORKSPACE_ID,
      effective: trustState.effective,
      defaultProjectTrust: "ask",
      saved: "none",
      needsPrompt: false,
      hasProjectResources: true,
      resources: [],
      note: "",
    },
    mcp: { implemented: false, note: "" },
    scannedAt: 1,
    errors: [],
  }),
}));

const {
  CHANNELS,
  PI_RESOURCES_CAPABILITY_ID,
  PI_RESOURCES_GATED_CHANNELS,
  PI_RESOURCES_PERMISSION,
  piPackagePermissionResource,
} = await import("@pibuddy/contract");
const { __resetRegisteredChannels } = await import("../src/main/ipc-guard.js");
const { registerPermissionIpc } = await import("../src/main/permission/permission-ipc.js");
const permissionStore = await import("../src/main/permission/permission-store.js");
const { __setWorkspaceStoreDataDir } = await import(
  "../src/main/workspace/workspace-store.js"
);
const { CHANNEL_PERMISSION_REQUIREMENTS } = await import(
  "../src/main/permission/channel-permission-requirements.js"
);
const { registerPiResourcesIpc } = await import(
  "../src/main/pi-resources/pi-resources-ipc.js"
);

const frame = {};
const event = { senderFrame: frame, sender: { id: 1, mainFrame: frame } };
const call = (channel: string, payload: unknown) => handled.get(channel)!(event, payload);

beforeAll(() => {
  __setWorkspaceStoreDataDir(userData);
  __resetRegisteredChannels();
  handled.clear();
  registerPermissionIpc();
  registerPiResourcesIpc();
});

afterAll(() => {
  __setWorkspaceStoreDataDir(null);
  fs.rmSync(userData, { recursive: true, force: true });
});

beforeEach(() => {
  permissionStore.__resetPermissionStore();
  trustState.effective = "allow";
  execFileMock.mockReset();
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
    callback(null, "ok", "");
    return {};
  });
});

function resource(
  action: "install" | "remove",
  scope: "user" | "project" = "user",
  spec = "npm:@scope/tool@1.0.0"
): string {
  return piPackagePermissionResource(action, scope, WORKSPACE_ID, spec);
}

async function grant(
  action: "install" | "remove",
  disposition: "allow-once" | "allow-session" = "allow-session",
  scope: "user" | "project" = "user",
  spec = "npm:@scope/tool@1.0.0"
): Promise<void> {
  await permissionStore.decidePermission({
    capabilityId: PI_RESOURCES_CAPABILITY_ID,
    permission: PI_RESOURCES_PERMISSION,
    resource: resource(action, scope, spec),
    disposition,
    workspaceId: WORKSPACE_ID,
  });
}

describe("pi-resources permission requirement surface", () => {
  it("gates exactly install and remove", () => {
    expect([...PI_RESOURCES_GATED_CHANNELS]).toEqual([
      CHANNELS.piResourcesInstall,
      CHANNELS.piResourcesRemove,
    ]);
    expect(CHANNEL_PERMISSION_REQUIREMENTS[CHANNELS.piResourcesInstall]).toMatchObject({
      capabilityId: PI_RESOURCES_CAPABILITY_ID,
      permission: PI_RESOURCES_PERMISSION,
    });
    expect(CHANNEL_PERMISSION_REQUIREMENTS[CHANNELS.piResourcesRemove]).toBeTruthy();
    for (const channel of [
      CHANNELS.piResourcesScan,
      CHANNELS.piResourcesSetEnabled,
      CHANNELS.piResourcesOpenDir,
      CHANNELS.trustDescribe,
      CHANNELS.trustDecide,
    ]) {
      expect(CHANNEL_PERMISSION_REQUIREMENTS[channel]).toBeUndefined();
    }
  });

  it("blocks install before handler and execFile", async () => {
    await expect(
      call(CHANNELS.piResourcesInstall, {
        workspaceId: WORKSPACE_ID,
        spec: "npm:@scope/tool@1.0.0",
        scope: "user",
      })
    ).rejects.toThrow(/IPC_PERMISSION_DENIED/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("allows the exact tuple after grant", async () => {
    await grant("install");
    await expect(
      call(CHANNELS.piResourcesInstall, {
        workspaceId: WORKSPACE_ID,
        spec: "npm:@scope/tool@1.0.0",
        scope: "user",
      })
    ).resolves.toMatchObject({ ok: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("separates action, scope and spec", async () => {
    await grant("install");
    await expect(
      call(CHANNELS.piResourcesRemove, {
        workspaceId: WORKSPACE_ID,
        spec: "npm:@scope/tool@1.0.0",
        scope: "user",
      })
    ).rejects.toThrow(/IPC_PERMISSION_DENIED/);
    await expect(
      call(CHANNELS.piResourcesInstall, {
        workspaceId: WORKSPACE_ID,
        spec: "npm:@scope/other@1.0.0",
        scope: "user",
      })
    ).rejects.toThrow(/IPC_PERMISSION_DENIED/);
    await expect(
      call(CHANNELS.piResourcesInstall, {
        workspaceId: WORKSPACE_ID,
        spec: "npm:@scope/tool@1.0.0",
        scope: "project",
      })
    ).rejects.toThrow(/IPC_PERMISSION_DENIED/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("consumes allow-once only once", async () => {
    await grant("install", "allow-once");
    const payload = {
      workspaceId: WORKSPACE_ID,
      spec: "npm:@scope/tool@1.0.0",
      scope: "user" as const,
    };
    await expect(call(CHANNELS.piResourcesInstall, payload)).resolves.toMatchObject({ ok: true });
    await expect(call(CHANNELS.piResourcesInstall, payload)).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("project trust still blocks exec after shell permission", async () => {
    await grant("install", "allow-session", "project");
    trustState.effective = "deny";
    await expect(
      call(CHANNELS.piResourcesInstall, {
        workspaceId: WORKSPACE_ID,
        spec: "npm:@scope/tool@1.0.0",
        scope: "project",
      })
    ).resolves.toMatchObject({ ok: false, reason: "not-trusted" });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
