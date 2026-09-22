import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "@pibuddy/contract";

type Client = { runtimeId: string; stopped: boolean; resolveState: (state: { sessionId: string }) => void; rejectState: (error: Error) => void };
const h = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown, event: unknown) => unknown>(),
  clients: [] as Client[],
  focused: vi.fn(),
  switching: vi.fn(async (_runtime: string) => ({ success: true, data: { cancelled: false } })),
  contain: vi.fn(async (_dir: string, target: string) => target),
  trust: vi.fn(async () => ({ hasProjectResources: false })),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/start-ownership", isPackaged: false, getVersion: () => "0.0.0" },
  shell: {}, dialog: {}, BrowserWindow: { getAllWindows: () => [] }, ipcMain: {},
}));
vi.mock("../ipc-guard.js", () => ({ registerHandler: (channel: string, _schema: unknown, handler: (payload: unknown, event: unknown) => unknown) => h.handlers.set(channel, handler), forgetSender: vi.fn() }));
vi.mock("@pibuddy/pi-sdk", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, PiRpcClient: class extends EventEmitter {
    runtimeId = `runtime-${h.clients.length + 1}`;
    phase = "running";
    stopped = false;
    stderrSnapshot = "";
    resolveState!: Client["resolveState"];
    rejectState!: Client["rejectState"];
    state = new Promise<{ sessionId: string }>((resolve, reject) => { this.resolveState = resolve; this.rejectState = reject; });
    constructor() { super(); h.clients.push(this); }
    start() {}
    assertUsable() { if (this.stopped) throw new Error("stopped"); }
    async stop() { this.stopped = true; }
    get running() { return !this.stopped; }
    switchSession() { return h.switching(this.runtimeId); }
    getState() { return this.state; }
    async getAvailableModels() { return { models: [] }; }
    async getMessages() { return { messages: [] }; }
  } };
});
vi.mock("../agent-pool/pool.js", () => ({ agentPoolObserver: () => ({ onAdopt: vi.fn() }), agentPool: () => ({ setFocused: h.focused }), poolRuntimeHost: () => ({ setForegroundGateway: vi.fn() }) }));
vi.mock("../settings.js", () => ({ loadSettings: () => ({}) }));
vi.mock("../workspace-registry.js", () => ({ requireWorkspaceRoot: () => "/synthetic", assertContained: h.contain, workspaceIdFor: () => "w1" }));
vi.mock("../sessions/session-dir.js", () => ({ resolveSessionDir: () => "/synthetic/sessions", sessionFilePath: () => "/synthetic/b.jsonl", pickResumeSessionPath: (source: string) => source }));
vi.mock("../sessions/session-index.js", () => ({ sessionIndex: () => ({ bySessionId: () => ({ sourcePath: "/synthetic/b.jsonl" }) }) }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<Record<string, unknown>>(), stat: vi.fn(async () => ({ size: 12 })) }));
vi.mock("../sessions/pi-session-header.js", async (original) => ({ ...await original<Record<string, unknown>>(), assertLaunchablePiSessionFile: vi.fn(async () => undefined) }));
vi.mock("./switch-session-trace.js", () => ({ attachSwitchTrace: () => ({ stop: () => ({}) }) }));
vi.mock("../pi-resources/trust-store.js", () => ({ describeTrust: h.trust, trustArgsFor: () => [] }));
vi.mock("../pi-resources/project-trust.js", () => ({ sessionTrustFor: vi.fn() }));
vi.mock("../pi-launcher.js", () => ({ buildPiSpawn: () => ({ runtime: {} }), verifyRuntimeHandshake: vi.fn() }));
vi.mock("./kernel-extensions.js", () => ({ kernelExtensionArgs: () => [] }));
vi.mock("../lifecycle/graceful-shutdown.js", () => ({ agentActivity: { forget: vi.fn() } }));
vi.mock("../changeset/tool-watch.js", () => ({ observeToolEvent: vi.fn() }));
vi.mock("./event-forwarder.js", () => ({ createForwarder: () => ({ dispose: vi.fn() }), sendPush: vi.fn() }));
vi.mock("../log.js", () => ({ log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

const { registerPiIpc, supervisor, tryClientFor } = await import("./pi-ipc.js");
const event = { sender: { id: 77, isDestroyed: () => false, send() {} } };
function start() { return Promise.resolve(h.handlers.get(CHANNELS.piStart)!({ workspaceId: "w1" }, event)); }
const launched = (count: number) => vi.waitFor(() => expect(h.clients).toHaveLength(count));
beforeAll(() => registerPiIpc());
afterEach(async () => { await supervisor().dispose(); h.clients.length = 0; h.focused.mockClear(); h.switching.mockClear(); h.contain.mockClear(); });

describe("foreground startup ownership", () => {
  it.each(["rpc-reject", "rpc-resolve", "path"])("旧 switch 的 %s 迟到不能操作或替换后来的 C", async (phase) => {
    const boot = start();
    await launched(1);
    h.clients[0].resolveState({ sessionId: "a" });
    await boot;
    let releasePath!: (value: string) => void;
    let releaseRpc!: (value: { success: boolean; data: { cancelled: boolean } }) => void;
    let rejectRpc!: (error: Error) => void;
    if (phase === "path") h.contain.mockImplementationOnce(() => new Promise((resolve) => { releasePath = resolve; }));
    else h.switching.mockImplementationOnce(() => new Promise((resolve, reject) => { releaseRpc = resolve; rejectRpc = reject; }));
    const old = Promise.resolve(h.handlers.get(CHANNELS.piSwitchSession)!({ workspaceId: "w1", sessionId: "b" }, event));
    const rejected = expect(old).rejects.toThrow(/取代/);
    await vi.waitFor(() => expect(phase === "path" ? h.contain : h.switching).toHaveBeenCalled());
    const next = start();
    await launched(2);
    h.clients[1].resolveState({ sessionId: "c" });
    await next;
    if (phase === "path") releasePath("/synthetic/b.jsonl");
    else if (phase === "rpc-reject") rejectRpc(new Error("客户端已停止"));
    else releaseRpc({ success: true, data: { cancelled: false } });
    await rejected;
    expect(h.clients).toHaveLength(2);
    expect(h.clients[1].stopped).toBe(false);
    expect(supervisor().currentActive()?.sessionId).toBe("c");
    expect(h.focused).toHaveBeenLastCalledWith("c");
  });

  it.each(["reject", "resolve"])("A 被 B 替换后迟到 %s 不得清理或覆盖 B", async (outcome) => {
    const a = start();
    const rejected = expect(a).rejects.toThrow();
    await launched(1);
    const b = start();
    await launched(2);
    const [old, current] = h.clients;
    current.resolveState({ sessionId: "b" });
    await expect(b).resolves.toMatchObject({ state: { sessionId: "b" } });
    if (outcome === "reject") old.rejectState(new Error("old handshake failed"));
    else old.resolveState({ sessionId: "a" });
    await rejected;
    expect(old.stopped).toBe(true);
    expect(current.stopped).toBe(false);
    expect(supervisor().currentActive()?.client.runtimeId).toBe(current.runtimeId);
    expect(tryClientFor(77)?.runtimeId).toBe(current.runtimeId);
    expect(h.focused).toHaveBeenLastCalledWith("b");
  });

  it("旧启动仍在准备资源时，新启动已完成，旧请求不能再 launch 替换它", async () => {
    let release!: (value: { hasProjectResources: boolean }) => void;
    h.trust.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const a = start();
    const rejected = expect(a).rejects.toThrow(/取代/);
    const b = start();
    await launched(1);
    h.clients[0].resolveState({ sessionId: "b" });
    await b;
    release({ hasProjectResources: false });
    await rejected;
    expect(h.clients).toHaveLength(1);
    expect(h.clients[0].stopped).toBe(false);
  });
});
