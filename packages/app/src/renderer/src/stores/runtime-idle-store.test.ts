import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { send, useAppStore } from "./app";

const SESSION_MODEL = { id: "m1", provider: "anthropic", input: ["text"] };

let startSpy: ReturnType<typeof vi.fn>;
let stopSpy: ReturnType<typeof vi.fn>;
let promptSpy: ReturnType<typeof vi.fn>;
let getStateSpy: ReturnType<typeof vi.fn>;

function installBridge(opts?: { promptImpl?: () => Promise<{ success: boolean; error?: string }> }) {
  startSpy = vi.fn(async () => ({
    state: { model: SESSION_MODEL, thinkingLevel: "low", sessionId: "sess-1" },
    models: [SESSION_MODEL],
    messages: [],
  }));
  stopSpy = vi.fn(async () => undefined);
  promptSpy = vi.fn(opts?.promptImpl ?? (async () => ({ success: true })));
  getStateSpy = vi.fn(async () => ({
    success: true,
    data: { model: SESSION_MODEL, thinkingLevel: "low", sessionId: "sess-1" },
  }));

  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      pi: {
        runtime: { start: startSpy, stop: stopSpy },
        prompt: promptSpy,
        setModel: vi.fn(async () => ({ success: true })),
        setThinkingLevel: vi.fn(async () => ({ success: true })),
        getState: getStateSpy,
        getSessionStats: vi.fn(async () => ({ success: false })),
        getAvailableThinkingLevels: vi.fn(async () => ({
          success: true,
          data: { levels: ["off", "low", "high"] },
        })),
        newSession: vi.fn(async () => ({ success: true, data: {} })),
      },
      settings: { set: vi.fn(async () => ({})), get: vi.fn(async () => ({})) },
      sessions: {
        query: vi.fn(async () => []),
        saveDraft: vi.fn(async () => true),
        getDraft: vi.fn(async () => null),
      },
    },
  };
}

describe("前台 runtime 空闲休眠 / 聚焦唤醒", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    installBridge();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function boot(): Promise<ReturnType<typeof useAppStore>> {
    const store = useAppStore();
    store.workspaceId = "ws-1";
    store.idleSleepMs = 50;
    await store.start("sess-1");
    return store;
  }

  it("空闲到期后停掉进程，标成休眠而不是断连错误", async () => {
    const store = await boot();
    expect(store.started).toBe(true);

    await vi.advanceTimersByTimeAsync(50);

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(store.runtimeAsleep).toBe(true);
    expect(store.started).toBe(false);
    expect(store.startError).toBe("");
    expect(store.canCompose).toBe(true);
  });

  it("正在输出时到期不睡，等空闲后再排", async () => {
    const store = await boot();
    store.streaming = true;

    await vi.advanceTimersByTimeAsync(50);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(store.runtimeAsleep).toBe(false);

    store.streaming = false;
    store.markConversation();
    await vi.advanceTimersByTimeAsync(50);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("休眠后再启动若会话文件已不在，ENOENT 也会去掉 sessionId 再试一次", async () => {
    const store = await boot();
    await vi.advanceTimersByTimeAsync(50);
    startSpy.mockClear();
    startSpy.mockRejectedValueOnce(
      new Error(
        "ENOENT: no such file or directory, realpath 'C:\\\\Users\\\\yehh\\\\.pi\\\\agent\\\\sessions\\\\x.jsonl'"
      )
    );

    await store.onWindowActivated();

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(startSpy.mock.calls[1]?.[0]).toEqual({ workspaceId: "ws-1", sessionId: undefined });
    expect(store.started).toBe(true);
    expect(store.startError).toBe("");
  });

  it("休眠后再启动若会话还不在索引里，会去掉 sessionId 再试一次", async () => {
    const store = await boot();
    await vi.advanceTimersByTimeAsync(50);
    expect(store.runtimeAsleep).toBe(true);
    startSpy.mockClear();
    startSpy.mockRejectedValueOnce(
      new Error("Error invoking remote method 'pi:start': Error: SESSION_UNKNOWN: sess-1")
    );

    await store.onWindowActivated();

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(startSpy.mock.calls[0]?.[0]).toEqual({ workspaceId: "ws-1", sessionId: "sess-1" });
    expect(startSpy.mock.calls[1]?.[0]).toEqual({ workspaceId: "ws-1", sessionId: undefined });
    expect(store.started).toBe(true);
    expect(store.startError).toBe("");
  });

  it("聚焦休眠窗口会重新启动当前会话", async () => {
    const store = await boot();
    await vi.advanceTimersByTimeAsync(50);
    expect(store.runtimeAsleep).toBe(true);
    startSpy.mockClear();

    await store.onWindowActivated();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      sessionId: "sess-1",
    });
    expect(store.started).toBe(true);
    expect(store.runtimeAsleep).toBe(false);
  });

  it("发送会先唤醒再投递，不要求用户重启应用", async () => {
    const store = await boot();
    await vi.advanceTimersByTimeAsync(50);
    expect(store.runtimeAsleep).toBe(true);
    startSpy.mockClear();

    const ok = await send({ text: "还在吗" });

    expect(ok).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(store.runtimeAsleep).toBe(false);
    expect(store.started).toBe(true);
  });

  it("进程已死时发送会拉活再重试一次 prompt", async () => {
    const store = await boot();
    promptSpy
      .mockRejectedValueOnce(new Error("智能体运行时不可用（phase=stopping）"))
      .mockResolvedValueOnce({ success: true });
    startSpy.mockClear();

    const ok = await send({ text: "再发一次" });

    expect(ok).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledTimes(2);
  });

  it("看起来还在跑但 getState 失败时，聚焦会探活并重启", async () => {
    const store = await boot();
    getStateSpy.mockResolvedValueOnce({ success: false });
    startSpy.mockClear();

    await store.onWindowActivated();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(store.started).toBe(true);
  });

  it("休眠时点新建任务直接新开进程，不再对已停的客户端 switch_session", async () => {
    const store = await boot();
    await vi.advanceTimersByTimeAsync(50);
    expect(store.runtimeAsleep).toBe(true);
    startSpy.mockClear();
    const newSession = (window as unknown as { piBuddy: { pi: { newSession: ReturnType<typeof vi.fn> } } })
      .piBuddy.pi.newSession;

    await store.newTask();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[0]).toEqual({ workspaceId: "ws-1", sessionId: undefined });
    expect(newSession).not.toHaveBeenCalled();
    expect(store.runtimeAsleep).toBe(false);
    expect(store.started).toBe(true);
    expect(store.creatingTask).toBe(false);
  });

  it("新建任务会作废还在飞的 switch_session，不把客户端已停止弹出来", async () => {
    const store = await boot();
    const error = vi.fn();
    store.setNotifier({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error });
    store.piLoadedSessionId = "other-sess";
    let rejectSwitch!: (err: Error) => void;
    const switchSession = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectSwitch = reject;
        })
    );
    const pi = (window as unknown as { piBuddy: { pi: Record<string, unknown> } }).piBuddy.pi;
    pi.switchSession = switchSession;

    const pending = store.whenPiReady();
    await Promise.resolve();
    await Promise.resolve();
    expect(switchSession).toHaveBeenCalledTimes(1);

    await store.newTask();
    rejectSwitch(
      new Error("Error invoking remote method 'pi:switch-session': Error: 客户端已停止")
    );
    await pending;

    expect(error).not.toHaveBeenCalled();
    expect(store.creatingTask).toBe(false);
  });
});
