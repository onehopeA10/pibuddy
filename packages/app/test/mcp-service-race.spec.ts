import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-mcp-race-"));
const PROJECT_ROOT = path.join(ROOT, "project");
const { connectMock, trustControl } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  trustControl: {
    effective: "allow" as "allow" | "deny",
    wait: null as Promise<{ effective: "allow" | "deny" }> | null,
  },
}));

vi.mock("../src/main/workspace-registry.js", () => ({
  requireWorkspaceRoot: () => PROJECT_ROOT,
}));
vi.mock("../src/main/pi-resources/project-trust.js", () => ({
  currentProjectTrust: async () =>
    trustControl.wait ?? { effective: trustControl.effective },
}));
vi.mock("../src/main/mcp/mcp-client.js", () => ({
  connectStdio: connectMock,
  terminateStdioChild: (child: { kill: () => unknown }) => child.kill(),
}));

const {
  __resetMcpRunning,
  disposeMcpResources,
  listServers,
  startServer,
  stopServer,
  testServer,
  stopServersByRef,
} = await import("../src/main/mcp/mcp-service.js");

class FakeChild extends EventEmitter {
  kill = vi.fn(() => {
    this.emit("exit", 0, null);
    return true;
  });
}

const probe = {
  ok: true,
  serverInfo: { name: "race-stub", version: "1.0.0" },
  protocolVersion: "2024-11-05",
  tools: [],
  diagnostics: [],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function writeConfig(command = "node"): void {
  fs.mkdirSync(path.join(PROJECT_ROOT, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_ROOT, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { alpha: { command, args: ["server.mjs"] } } }),
    "utf8"
  );
}

async function alphaId(): Promise<string> {
  return (await listServers("ws")).servers.find((server) => server.name === "alpha")!.id;
}

beforeAll(() => {
  fs.mkdirSync(PROJECT_ROOT, { recursive: true });
});

beforeEach(() => {
  connectMock.mockReset();
  trustControl.effective = "allow";
  trustControl.wait = null;
  __resetMcpRunning();
  writeConfig();
});

afterEach(() => {
  disposeMcpResources();
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("MCP process lifecycle races", () => {
  it("concurrent start/start shares one spawn", async () => {
    const id = await alphaId();
    const pending = deferred<{ child: FakeChild; probe: typeof probe }>();
    const child = new FakeChild();
    connectMock.mockReturnValueOnce(pending.promise);

    const first = startServer("ws", id);
    const second = startServer("ws", id);
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    pending.resolve({ child, probe });

    await expect(first).resolves.toMatchObject({ ok: true, running: true });
    await expect(second).resolves.toMatchObject({ ok: true, running: true });
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("stop during handshake waits for and kills the eventual child", async () => {
    const id = await alphaId();
    const pending = deferred<{ child: FakeChild; probe: typeof probe }>();
    const child = new FakeChild();
    connectMock.mockReturnValueOnce(pending.promise);

    const starting = startServer("ws", id);
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    const stopping = stopServer("ws", id);
    pending.resolve({ child, probe });

    await expect(starting).resolves.toMatchObject({ running: false });
    await stopping;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect((await listServers("ws")).servers[0]!.running).toBe(false);
  });

  it("save/remove identity cleanup kills a running old id", async () => {
    const id = await alphaId();
    const child = new FakeChild();
    connectMock.mockResolvedValueOnce({ child, probe });
    await startServer("ws", id);

    await stopServersByRef("ws", "project", "alpha");

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect((await listServers("ws")).servers[0]!.running).toBe(false);
  });

  it("list reconciles an externally changed config and kills the now-stale process", async () => {
    const id = await alphaId();
    const child = new FakeChild();
    connectMock.mockResolvedValueOnce({ child, probe });
    await startServer("ws", id);

    writeConfig("different-command");
    const refreshed = await listServers("ws");

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(refreshed.servers[0]!.id).not.toBe(id);
    expect(refreshed.servers[0]!.running).toBe(false);
  });

  it("stop 拒绝用 B 的 workspaceId 终止 A 的进程", async () => {
    const id = await alphaId();
    const child = new FakeChild();
    connectMock.mockResolvedValueOnce({ child, probe });
    await startServer("ws", id);

    await expect(stopServer("ws-B", id)).rejects.toThrow(/MCP_SERVER_WORKSPACE_MISMATCH/);
    expect(child.kill).not.toHaveBeenCalled();
    await stopServer("ws", id);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("project trust 被外部改成 deny 后，下一次 list 回收已运行进程", async () => {
    const id = await alphaId();
    const child = new FakeChild();
    connectMock.mockResolvedValueOnce({ child, probe });
    await startServer("ws", id);

    trustControl.effective = "deny";
    const refreshed = await listServers("ws");

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(refreshed.servers[0]!.running).toBe(false);
  });

  it("dispose 发生在 trust await 期间时，旧 start 恢复后也不能 spawn", async () => {
    const id = await alphaId();
    const trust = deferred<{ effective: "allow" | "deny" }>();
    trustControl.wait = trust.promise;

    const starting = startServer("ws", id);
    await Promise.resolve();
    disposeMcpResources();
    trust.resolve({ effective: "allow" });

    await expect(starting).resolves.toMatchObject({ running: false });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("dispose 在握手完成前就能杀掉已经 spawn 的 child", async () => {
    const id = await alphaId();
    const pending = deferred<{ child: null; probe: typeof probe }>();
    const child = new FakeChild();
    connectMock.mockImplementationOnce((_config, opts) => {
      opts.onSpawn?.(child);
      return pending.promise;
    });

    const starting = startServer("ws", id);
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    disposeMcpResources();
    expect(child.kill).toHaveBeenCalledTimes(1);
    pending.resolve({ child: null, probe: { ...probe, ok: false } });
    await expect(starting).resolves.toMatchObject({ running: false });
  });

  it("dispose 同样回收连接测试的握手期 child", async () => {
    const id = await alphaId();
    const pending = deferred<{ child: null; probe: typeof probe }>();
    const child = new FakeChild();
    connectMock.mockImplementationOnce((_config, opts) => {
      opts.onSpawn?.(child);
      return pending.promise;
    });

    const testing = testServer("ws", id);
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    disposeMcpResources();
    expect(child.kill).toHaveBeenCalledTimes(1);
    pending.resolve({ child: null, probe: { ...probe, ok: false } });
    await expect(testing).resolves.toMatchObject({ running: false });
  });
});
