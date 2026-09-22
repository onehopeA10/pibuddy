import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "@pibuddy/contract";

type Event = { sender: { id: number } };
type Handler = (payload: unknown, event: Event) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sessionId: "",
  client: {
    assertUsable: vi.fn(),
    send: vi.fn(async (_command: unknown) => ({ success: true })),
  },
  actions: vi.fn((message: string, _context: unknown) => ({ message })),
  memoryEnabled: vi.fn(() => false),
  inject: vi.fn(async (message: string, _workspace: string, _session?: string, _requestText?: string) => message),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/pi-prompt-session", isPackaged: false, getVersion: () => "0.0.0" },
  shell: { trashItem: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("../ipc-guard.js", () => ({
  registerHandler: <T>(channel: string, schema: { parse: (input: unknown) => T }, handler: (payload: T, event: Event) => unknown) => {
    h.handlers.set(channel, (payload, event) => handler(schema.parse(payload), event));
  },
  forgetSender: vi.fn(),
}));
vi.mock("../pi-supervisor.js", () => ({
  PiSupervisor: class {
    setPoolObserver() {}
    currentActive() { return { sessionId: h.sessionId, client: h.client }; }
    recordForSession(sessionId: string) { return { sessionId, client: h.client }; }
    attachToTarget(_sender: unknown, sessionId: string) {
      h.sessionId = sessionId;
      return h.client;
    }
  },
}));
vi.mock("../agent-pool/pool.js", () => ({
  agentPoolObserver: vi.fn(),
  agentPool: () => ({ setFocused: vi.fn() }),
  poolRuntimeHost: () => ({ setForegroundGateway: vi.fn() }),
}));
vi.mock("../conversation/apply-actions.js", () => ({ applyConversationActions: h.actions }));
vi.mock("../capability/capability-state.js", () => ({ isCapabilityEnabled: h.memoryEnabled }));
vi.mock("../memory/memory-inject.js", () => ({ injectMemory: h.inject }));
vi.mock("../log.js", () => ({ log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

const { registerPiIpc } = await import("./pi-ipc.js");
const event: Event = { sender: { id: 42 } };
function invoke(channel: string, payload: unknown) {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler(payload, event);
}
function switchTo(sessionId: string, workspaceId = "w1") {
  return invoke(CHANNELS.piSwitchSession, { sessionId, workspaceId });
}
const target = { message: "你好", sessionId: "a", workspaceId: "w1" };

beforeAll(() => registerPiIpc());
beforeEach(async () => {
  vi.clearAllMocks();
  h.memoryEnabled.mockReturnValue(false);
  h.sessionId = "";
  await switchTo("a");
});

describe("prompt intended session", () => {
  it("只在预处理与投递之前确认不可用时返回 notSent", async () => {
    h.client.assertUsable.mockImplementationOnce(() => { throw new Error("runtime unavailable"); });
    expect(await invoke(CHANNELS.piPrompt, target)).toMatchObject({ success: false, notSent: true });
    expect(h.actions).not.toHaveBeenCalled();
    expect(h.inject).not.toHaveBeenCalled();
    expect(h.client.send).not.toHaveBeenCalled();
  });

  it("投递中的异常原样拒绝，不伪称未发送", async () => {
    h.client.send.mockRejectedValueOnce(new Error("客户端已停止"));
    await expect(invoke(CHANNELS.piPrompt, target)).rejects.toThrow("客户端已停止");
  });

  it.each([
    { sessionId: "b", workspaceId: "w1" },
    { sessionId: "a", workspaceId: "w2" },
  ])("rejects an already mismatched target %j before actions or memory", async (scope) => {
    expect(await invoke(CHANNELS.piPrompt, { ...target, ...scope })).toMatchObject({ success: false });
    expect(h.actions).not.toHaveBeenCalled();
    expect(h.inject).not.toHaveBeenCalled();
    expect(h.client.send).not.toHaveBeenCalled();
  });

  it("sends the intended message without leaking host routing fields to Pi", async () => {
    expect(await invoke(CHANNELS.piPrompt, target)).toEqual({ success: true });
    expect(h.actions).toHaveBeenCalledWith("你好", { workspaceId: "w1", sessionId: "a", workMode: "act" });
    expect(h.client.send).toHaveBeenCalledWith({ type: "prompt", message: "你好" });
  });

  it("routes memory using the user's original question rather than plan or action instructions", async () => {
    h.memoryEnabled.mockReturnValue(true);
    h.actions.mockReturnValueOnce({ message: "今天天气如何\n\n[宿主动作说明]" });
    expect(await invoke(CHANNELS.piPrompt, { ...target, message: "今天天气如何", workMode: "plan" })).toEqual({ success: true });
    expect(h.inject).toHaveBeenCalledWith(
      expect.stringContaining("【先看方案】"), "w1", "a", "今天天气如何"
    );
    expect(h.client.send).toHaveBeenCalledWith({
      type: "prompt", message: expect.stringContaining("今天天气如何\n\n[宿主动作说明]"),
    });
  });

  it("keeps legacy callers without explicit routing fields compatible", async () => {
    expect(await invoke(CHANNELS.piPrompt, { message: "你好" })).toEqual({ success: true });
    expect(h.client.send).toHaveBeenCalledTimes(1);
  });

  it("rejects a switch during attachment preparation before applying actions", async () => {
    const response = invoke(CHANNELS.piPrompt, target);
    await switchTo("b");
    expect(await response).toMatchObject({ success: false });
    expect(h.actions).not.toHaveBeenCalled();
    expect(h.client.send).not.toHaveBeenCalled();
  });

  it("invalidates pending memory injection even after A→B→A returns to the same ID", async () => {
    h.memoryEnabled.mockReturnValue(true);
    let finishMemory!: (message: string) => void;
    let memoryStarted!: () => void;
    const started = new Promise<void>((resolve) => { memoryStarted = resolve; });
    const memory = new Promise<string>((resolve) => { finishMemory = resolve; });
    h.inject.mockImplementationOnce(() => { memoryStarted(); return memory; });
    const response = invoke(CHANNELS.piPrompt, target);
    await started;
    await switchTo("b");
    await switchTo("a");
    finishMemory("memory\n\n你好");
    expect(await response).toMatchObject({ success: false });
    expect(h.inject).toHaveBeenCalledWith("你好", "w1", "a", "你好");
    expect(h.client.send).not.toHaveBeenCalled();
  });
});
