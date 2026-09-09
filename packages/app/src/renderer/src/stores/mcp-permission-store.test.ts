import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mcpRunResource,
  parseMcpGrantResource,
  type McpListResult,
  type McpServerInput,
} from "@pibuddy/contract";
import { useMcpStore } from "./mcp.js";
import { usePermissionStore } from "./permission.js";

const WORKSPACE_ID = "a".repeat(32);
const OTHER_WORKSPACE_ID = "c".repeat(32);
const FINGERPRINT = "b".repeat(64);
const RUN_RESOURCE = mcpRunResource(WORKSPACE_ID, "project", "alpha", FINGERPRINT);

const listResult: McpListResult = {
  servers: [
    {
      id: "server-id",
      name: "alpha",
      scope: "project",
      transport: "stdio",
      source: "D:/project/.pi/mcp.json",
      command: "node",
      args: ["server.mjs"],
      envKeys: [],
      headerKeys: [],
      oauthRequired: false,
      running: false,
      runPermissionResource: RUN_RESOURCE,
      diagnostics: [],
    },
  ],
  errors: [],
  scannedAt: 1,
};

const listSpy = vi.fn();
const startSpy = vi.fn();
const testSpy = vi.fn();
const saveSpy = vi.fn();

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  setActivePinia(createPinia());
  listSpy.mockReset();
  startSpy.mockReset();
  testSpy.mockReset();
  saveSpy.mockReset();
  listSpy.mockResolvedValue(listResult);
  (globalThis as Record<string, unknown>).window = {
    piBuddy: {
      mcp: {
        list: listSpy,
        start: startSpy,
        test: testSpy,
        save: saveSpy,
      },
    },
  };
});

describe("MCP renderer permission requests", () => {
  it("start reuses the main-derived run resource and originating workspace", async () => {
    startSpy.mockRejectedValueOnce(new Error("IPC_PERMISSION_DENIED: mcp:start"));
    const store = useMcpStore();
    await store.refresh(WORKSPACE_ID);
    await store.start(WORKSPACE_ID, "server-id");

    expect(store.permissionDenied).toBe(true);
    expect(store.deniedRequest?.resource).toBe(RUN_RESOURCE);
    expect(store.deniedRequest?.workspaceId).toBe(WORKSPACE_ID);
    expect(usePermissionStore().pendingWorkspaceId).toBe(WORKSPACE_ID);
  });

  it("stdio save requests an exact config fingerprint resource", async () => {
    saveSpy.mockRejectedValueOnce(new Error("IPC_PERMISSION_DENIED: mcp:save"));
    const config: McpServerInput = {
      name: "gamma",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { TOKEN: "secret" },
      headers: {},
      oauth: false,
    };
    const store = useMcpStore();
    await store.save(WORKSPACE_ID, "user", config);

    const parsed = parseMcpGrantResource(store.deniedRequest!.resource);
    expect(parsed).toMatchObject({
      kind: "config",
      workspaceId: WORKSPACE_ID,
      scope: "user",
      name: "gamma",
    });
    expect(store.deniedRequest!.resource).not.toContain("secret");
  });

  it("HTTP save errors remain ordinary errors, not shell permission prompts", async () => {
    saveSpy.mockRejectedValueOnce(new Error("disk failed"));
    const store = useMcpStore();
    await store.save(WORKSPACE_ID, "user", {
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com",
      args: [],
      env: {},
      headers: {},
      oauth: false,
    });
    expect(store.permissionDenied).toBe(false);
    expect(store.lastError).toContain("disk failed");
  });
});

describe("MCP workspace generation", () => {
  it("A 的列表晚于 B 返回时不能覆盖 B", async () => {
    const a = deferred<McpListResult>();
    const b = deferred<McpListResult>();
    listSpy.mockImplementation(async (workspaceId) =>
      workspaceId === WORKSPACE_ID ? a.promise : b.promise
    );
    const store = useMcpStore();
    store.setWorkspace(WORKSPACE_ID);

    const pendingA = store.refresh(WORKSPACE_ID);
    store.setWorkspace(OTHER_WORKSPACE_ID);
    const pendingB = store.refresh(OTHER_WORKSPACE_ID);
    b.resolve({ servers: [], errors: ["B 的列表"], scannedAt: 2 });
    await pendingB;
    a.resolve(listResult);
    await pendingA;

    expect(store.activeWorkspaceId).toBe(OTHER_WORKSPACE_ID);
    expect(store.servers).toEqual([]);
    expect(store.scanErrors).toEqual(["B 的列表"]);
  });

  it("A 的 start 权限拒绝晚到时不在 B 弹框或写错误", async () => {
    const started = deferred<never>();
    const store = useMcpStore();
    store.setWorkspace(WORKSPACE_ID);
    await store.refresh(WORKSPACE_ID);
    startSpy.mockReturnValueOnce(started.promise);

    const pending = store.start(WORKSPACE_ID, "server-id");
    expect(store.busyId).toBe("server-id");
    store.setWorkspace(OTHER_WORKSPACE_ID);
    started.reject(new Error("IPC_PERMISSION_DENIED: mcp:start"));
    await pending;

    expect(store.permissionDenied).toBe(false);
    expect(store.deniedRequest).toBeNull();
    expect(store.lastError).toBe("");
    expect(store.busyId).toBe("");
    expect(store.results).toEqual({});
    expect(usePermissionStore().pending).toBeNull();
  });

  it("切换工作区会立即清理旧的 MCP 授权重试入口", async () => {
    startSpy.mockRejectedValueOnce(new Error("IPC_PERMISSION_DENIED: mcp:start"));
    const store = useMcpStore();
    store.setWorkspace(WORKSPACE_ID);
    await store.refresh(WORKSPACE_ID);
    await store.start(WORKSPACE_ID, "server-id");
    expect(store.permissionDenied).toBe(true);

    store.setWorkspace(OTHER_WORKSPACE_ID);

    expect(store.permissionDenied).toBe(false);
    expect(store.deniedRequest).toBeNull();
    expect(store.deniedNotice).toBe("");
    expect(store.servers).toEqual([]);
  });

  it("没有工作区时 mutation 不发 IPC，也不会自动认领旧 id", async () => {
    const store = useMcpStore();
    store.setWorkspace("");

    const saved = await store.save("", "user", {
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com",
      args: [],
      env: {},
      headers: {},
      oauth: false,
    });
    await store.start("", "server-id");

    expect(saved).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(store.activeWorkspaceId).toBe("");
  });

  it("同工作区 mutation 使旧 refresh 数据过期时仍会关闭 loading", async () => {
    const listed = deferred<McpListResult>();
    listSpy.mockReturnValueOnce(listed.promise);
    saveSpy.mockResolvedValueOnce({ servers: [], errors: ["保存后的列表"], scannedAt: 2 });
    const store = useMcpStore();
    store.setWorkspace(WORKSPACE_ID);

    const pendingRefresh = store.refresh(WORKSPACE_ID);
    expect(store.loading).toBe(true);
    await store.save(WORKSPACE_ID, "user", {
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com",
      args: [],
      env: {},
      headers: {},
      oauth: false,
    });
    listed.resolve(listResult);
    await pendingRefresh;

    expect(store.loading).toBe(false);
    expect(store.scanErrors).toEqual(["保存后的列表"]);
  });
});
