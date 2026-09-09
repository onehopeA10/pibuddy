import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const handled = new Map<string, (event: unknown, raw: unknown) => unknown>();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mcp-perm-data-"));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mcp-perm-home-"));
const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mcp-perm-a-"));
const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mcp-perm-b-"));

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

const {
  CHANNELS,
  MCP_CAPABILITY_ID,
  MCP_GATED_CHANNELS,
  MCP_PERMISSION,
  mcpConfigResource,
} = await import("@pibuddy/contract");
const { __resetRegisteredChannels, setPermissionGate } = await import(
  "../src/main/ipc-guard.js"
);
const { __setWorkspaceDataDir, registerWorkspace } = await import(
  "../src/main/workspace-registry.js"
);
const { __setWorkspaceStoreDataDir, workspaceStore } = await import(
  "../src/main/workspace/workspace-store.js"
);
const {
  registerMcpIpc,
  disposeMcpResources: deactivateMcpResources,
} = await import("../src/main/mcp/mcp-ipc.js");
const { disposeMcpResources } = await import("../src/main/mcp/mcp-service.js");
const {
  __resetMcpPermissionTargets,
  mcpExecutionFingerprint,
} = await import("../src/main/mcp/mcp-config.js");
const {
  currentProjectTrust,
  notifyProjectTrustChange,
  setSessionTrustDecision,
  __resetProjectTrustState,
} = await import("../src/main/pi-resources/project-trust.js");
const permissionStore = await import("../src/main/permission/permission-store.js");

const frame = {};
const event = { senderFrame: frame, sender: { id: 9, mainFrame: frame } };
const call = (channel: string, raw: unknown): unknown => handled.get(channel)!(event, raw);

const STUB = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1); nl = buf.indexOf("\\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "permission-stub", version: "1.0.0" },
        capabilities: {},
      } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [{ name: "echo", description: "" }],
      } }) + "\\n");
    }
  }
});
`;

const stubA = path.join(wsA, "stub.cjs");
const stubB = path.join(wsB, "stub.cjs");
let workspaceA = "";
let workspaceB = "";

function projectConfig(stub: string, command = process.execPath): Record<string, unknown> {
  return {
    mcpServers: {
      alpha: { command, args: [stub] },
      beta: { command: process.execPath, args: [stub] },
    },
  };
}

function writeProjectConfig(root: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "mcp.json"), JSON.stringify(value), "utf8");
}

async function list(workspaceId: string): Promise<{
  servers: Array<{
    id: string;
    name: string;
    runPermissionResource: string | null;
    command?: string;
    args: string[];
    running: boolean;
  }>;
}> {
  return (await call(CHANNELS.mcpList, { workspaceId })) as never;
}

function findServer(result: Awaited<ReturnType<typeof list>>, name: string) {
  return result.servers.find((server) => server.name === name)!;
}

async function grantRun(
  workspaceId: string,
  resource: string,
  disposition: "allow-once" | "allow-session" = "allow-session"
): Promise<void> {
  await permissionStore.decidePermission({
    capabilityId: MCP_CAPABILITY_ID,
    permission: MCP_PERMISSION,
    resource,
    disposition,
    workspaceId,
  });
}

beforeAll(() => {
  fs.writeFileSync(stubA, STUB, "utf8");
  fs.writeFileSync(stubB, STUB, "utf8");
  writeProjectConfig(wsA, projectConfig(stubA));
  writeProjectConfig(wsB, projectConfig(stubB));
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);

  __setWorkspaceDataDir(userData);
  __setWorkspaceStoreDataDir(userData);
  workspaceA = registerWorkspace(fs.realpathSync.native(wsA)).workspaceId;
  workspaceB = registerWorkspace(fs.realpathSync.native(wsB)).workspaceId;
  expect(workspaceStore().open(fs.realpathSync.native(wsA)).id).toBe(workspaceA);
  expect(workspaceStore().open(fs.realpathSync.native(wsB)).id).toBe(workspaceB);

  __resetRegisteredChannels();
  handled.clear();
  registerMcpIpc();
  setPermissionGate(permissionStore.gateForChannel);
});

afterAll(() => {
  deactivateMcpResources();
  setPermissionGate(null);
  __resetProjectTrustState();
  __setWorkspaceStoreDataDir(null);
  vi.restoreAllMocks();
  for (const dir of [userData, homeDir, wsA, wsB]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  permissionStore.__resetPermissionStore();
  disposeMcpResources();
  __resetMcpPermissionTargets();
  setSessionTrustDecision(workspaceA, "allow");
  setSessionTrustDecision(workspaceB, "allow");
  writeProjectConfig(wsA, projectConfig(stubA));
  writeProjectConfig(wsB, projectConfig(stubB));
});

describe("MCP permission requirement surface", () => {
  it("gates save/test/start/stop/remove and leaves list ungated", async () => {
    await list(workspaceA);
    const table = permissionStore.CHANNEL_PERMISSION_REQUIREMENTS;
    expect([...MCP_GATED_CHANNELS]).toEqual([
      CHANNELS.mcpSave,
      CHANNELS.mcpTest,
      CHANNELS.mcpStart,
      CHANNELS.mcpStop,
      CHANNELS.mcpRemove,
    ]);
    for (const channel of MCP_GATED_CHANNELS) {
      expect(table[channel]).toMatchObject({
        capabilityId: MCP_CAPABILITY_ID,
        permission: MCP_PERMISSION,
      });
      expect(typeof table[channel]?.resource).toBe("function");
    }
    expect(table[CHANNELS.mcpList]).toBeUndefined();
  });

  it("blocks start and test before the spawn handler", async () => {
    const alpha = findServer(await list(workspaceA), "alpha");
    await expect(call(CHANNELS.mcpStart, { workspaceId: workspaceA, id: alpha.id })).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
    await expect(call(CHANNELS.mcpTest, { workspaceId: workspaceA, id: alpha.id })).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
  });

  it("blocks stop and remove before the handler", async () => {
    const alpha = findServer(await list(workspaceA), "alpha");
    await expect(call(CHANNELS.mcpStop, { workspaceId: workspaceA, id: alpha.id })).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
    await expect(
      call(CHANNELS.mcpRemove, { workspaceId: workspaceA, scope: "project", name: "alpha" })
    ).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });

  it("allows the exact server/config and keeps another server denied", async () => {
    const current = await list(workspaceA);
    const alpha = findServer(current, "alpha");
    const beta = findServer(current, "beta");
    await grantRun(workspaceA, alpha.runPermissionResource!);

    const started = (await call(CHANNELS.mcpStart, {
      workspaceId: workspaceA,
      id: alpha.id,
    })) as { ok: boolean; running: boolean };
    expect(started).toMatchObject({ ok: true, running: true });
    await expect(call(CHANNELS.mcpStart, { workspaceId: workspaceA, id: beta.id })).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
    await call(CHANNELS.mcpStop, { workspaceId: workspaceA, id: alpha.id });
  });

  it("does not share a same-named project server grant across workspaces", async () => {
    const alphaA = findServer(await list(workspaceA), "alpha");
    const alphaB = findServer(await list(workspaceB), "alpha");
    expect(alphaA.id).not.toBe(alphaB.id);
    expect(alphaA.runPermissionResource).not.toBe(alphaB.runPermissionResource);
    await grantRun(workspaceA, alphaA.runPermissionResource!);
    await expect(call(CHANNELS.mcpStart, { workspaceId: workspaceB, id: alphaB.id })).rejects.toThrow(
      /IPC_PERMISSION_DENIED/
    );
  });

  it("a config mutation invalidates the old id and old grant", async () => {
    const old = findServer(await list(workspaceA), "alpha");
    await grantRun(workspaceA, old.runPermissionResource!);

    writeProjectConfig(wsA, projectConfig(stubA, "definitely-not-a-real-command"));
    const stale = (await call(CHANNELS.mcpStart, {
      workspaceId: workspaceA,
      id: old.id,
    })) as { ok: boolean; diagnostics: string[] };
    expect(stale.ok).toBe(false);
    expect(stale.diagnostics.join(" ")).toContain("未找到");

    const changed = findServer(await list(workspaceA), "alpha");
    expect(changed.id).not.toBe(old.id);
    expect(changed.runPermissionResource).not.toBe(old.runPermissionResource);
    await expect(
      call(CHANNELS.mcpStart, { workspaceId: workspaceA, id: changed.id })
    ).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });

  it("project trust remains an independent pre-spawn requirement", async () => {
    const alpha = findServer(await list(workspaceA), "alpha");
    await grantRun(workspaceA, alpha.runPermissionResource!);
    setSessionTrustDecision(workspaceA, "deny");
    const result = (await call(CHANNELS.mcpStart, {
      workspaceId: workspaceA,
      id: alpha.id,
    })) as { ok: boolean; diagnostics: string[] };
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join(" ")).toContain("尚未受信");
  });

  it("revoking project trust stops an already-running project MCP", async () => {
    const alpha = findServer(await list(workspaceA), "alpha");
    await grantRun(workspaceA, alpha.runPermissionResource!);
    await call(CHANNELS.mcpStart, { workspaceId: workspaceA, id: alpha.id });
    expect(findServer(await list(workspaceA), "alpha").running).toBe(true);

    setSessionTrustDecision(workspaceA, "deny");
    const state = await currentProjectTrust(workspaceA);
    await notifyProjectTrustChange(workspaceA, state);

    const refreshed = await list(workspaceA);
    expect(refreshed.servers.find((server) => server.id === alpha.id)?.running).toBe(false);
  });

  it("HTTP save is not treated as shell execution", async () => {
    await expect(
      call(CHANNELS.mcpSave, {
        workspaceId: workspaceA,
        scope: "user",
        config: {
          name: "remote",
          transport: "http",
          url: "https://mcp.example.com",
          args: [],
          env: {},
          headers: {},
          oauth: false,
        },
      })
    ).resolves.toBeTruthy();
  });

  it("stdio save binds the proposed executable configuration", async () => {
    const config = {
      name: "gamma",
      transport: "stdio" as const,
      command: process.execPath,
      args: [stubA],
      env: {},
      headers: {},
      oauth: false,
    };
    const payload = { workspaceId: workspaceA, scope: "user" as const, config };
    await expect(call(CHANNELS.mcpSave, payload)).rejects.toThrow(/IPC_PERMISSION_DENIED/);

    const fingerprint = mcpExecutionFingerprint(config);
    await permissionStore.decidePermission({
      capabilityId: MCP_CAPABILITY_ID,
      permission: MCP_PERMISSION,
      resource: mcpConfigResource(workspaceA, "user", config.name, fingerprint),
      disposition: "allow-session",
      workspaceId: workspaceA,
    });
    await expect(call(CHANNELS.mcpSave, payload)).resolves.toBeTruthy();

    await expect(
      call(CHANNELS.mcpSave, {
        ...payload,
        config: { ...config, command: "different-command" },
      })
    ).rejects.toThrow(/IPC_PERMISSION_DENIED/);
  });
});
