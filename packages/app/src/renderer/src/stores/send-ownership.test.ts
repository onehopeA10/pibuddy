import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./app";
import { wrapEnvelope } from "@pibuddy/contract";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Response = { success: boolean; error?: string; notSent?: boolean };
let store: ReturnType<typeof useAppStore>;
let prompt: ReturnType<typeof vi.fn>;
let start: ReturnType<typeof vi.fn>;
let saveDraft: ReturnType<typeof vi.fn>;
const state = (sessionId: string) => ({ state: { sessionId }, models: [], messages: [] });

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  store = useAppStore();
  store.workspaceId = "w1";
  store.currentSessionId = "a";
  store.piLoadedSessionId = "a";
  store.started = true;
  prompt = vi.fn(async (): Promise<Response> => ({ success: true }));
  start = vi.fn(async () => state("a"));
  saveDraft = vi.fn(async () => true);
  vi.stubGlobal("window", { piBuddy: {
    pi: {
      prompt, abort: vi.fn(async () => ({ success: true })),
      switchSession: vi.fn(async () => ({ success: true, data: { cancelled: false } })),
      runtime: { start, stop: vi.fn(async () => undefined) },
      getState: vi.fn(async () => ({ success: true, data: { sessionId: store.currentSessionId } })),
      getAvailableThinkingLevels: vi.fn(async () => ({ success: true, data: { levels: ["off"] } })),
      getSessionStats: vi.fn(async () => ({ success: false })),
    },
    sessions: { readHistoryBefore: vi.fn(async () => ({ entries: [], nextBeforeOffset: null })), getDraft: vi.fn(async () => null), saveDraft, query: vi.fn(async () => []) },
    settings: { get: vi.fn(async () => ({})) },
    dialog: { selectWorkspace: vi.fn(async (workspaceId: string) => ({ workspaceId, displayPath: "synthetic" })) },
  } });
  vi.spyOn(store, "whenPiReady").mockResolvedValue(true);
});
afterEach(() => { store.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const switchTo = (sessionId: string) => store.openSession({ sessionId, sizeBytes: 1 });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("发送收尾属于原会话", () => {
  it("A 发送→B→A 失败：撤回 A 缓存回显并恢复 A 草稿，不写 B", async () => {
    const pending = deferred<Response>();
    prompt.mockReturnValueOnce(pending.promise);
    const sent = store.send({ text: "A 的消息" });
    await flush();
    await switchTo("b");
    expect(store.editorText).toBe("");
    pending.resolve({ success: false, error: "失败" });
    expect(await sent).toBe(false);
    expect(store.editorText).toBe("");
    expect(store.items).toEqual([]);
    await switchTo("a");
    expect(store.editorText).toBe("A 的消息");
    expect(store.items).toEqual([]);
  });

  it.each(["veto", "error"])("A 发送失败后 B 切换 %s，回滚使用最新 transcript 而非复活旧回显", async (outcome) => {
    const sending = deferred<Response>();
    const switching = deferred<{ success: boolean; data?: { cancelled: boolean } }>();
    prompt.mockReturnValueOnce(sending.promise);
    vi.spyOn(window.piBuddy.pi, "switchSession").mockReturnValueOnce(switching.promise as never);
    const sent = store.send({ text: "未发送的 A 消息" });
    await flush();
    await switchTo("b");
    await vi.advanceTimersByTimeAsync(350);
    sending.resolve({ success: false });
    await sent;
    store.handleEventEnvelope(wrapEnvelope(
      { workspaceId: "w1", sessionId: "a", runtimeId: "rt-a", generation: 1 }, 0,
      { type: "message_end", message: { role: "user", content: "后台真实追加", timestamp: 1 } }
    ));
    switching.resolve(outcome === "veto" ? { success: true, data: { cancelled: true } } : { success: false });
    await flush();
    expect(store.currentSessionId).toBe("a");
    expect(store.editorText).toBe("未发送的 A 消息");
    expect(store.items.map((item) => "content" in item.message ? item.message.content : null)).toEqual(["后台真实追加"]);
  });

  it("发送失败恢复图片时保留显示名称，不把纯 SDK 图片当作完整 composer 数据", async () => {
    store.agentState = { model: { id: "vision", provider: "synthetic", input: ["text", "image"] } } as never;
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    prompt.mockResolvedValueOnce({ success: false });
    expect(await store.send({ images: [image] })).toBe(false);
    expect(store.draftImages).toEqual([{ ...image, name: "图片 1" }]);
  });

  it("失败不会覆盖原会话后来输入的新草稿", async () => {
    const pending = deferred<Response>();
    prompt.mockReturnValueOnce(pending.promise);
    const sent = store.send({ text: "旧内容" });
    await flush();
    store.editorText = "新内容";
    pending.resolve({ success: false });
    await sent;
    expect(store.editorText).toBe("新内容");
  });

  it("跨工作区同 sessionId：失败草稿写回原 workspace，当前输入和消息保持不变", async () => {
    const pending = deferred<Response>();
    prompt.mockReturnValueOnce(pending.promise);
    const sent = store.send({ text: "w1 的内容" });
    await flush();
    await store.switchWorkspace("w2", "a");
    store.editorText = "w2 的草稿";
    store.items = [{ key: 1, message: { role: "user", content: "w2 的消息" } }] as never;
    pending.resolve({ success: false });
    await sent;
    expect(store.editorText).toBe("w2 的草稿");
    expect(store.items[0].message).toMatchObject({ content: "w2 的消息" });
    expect(saveDraft).toHaveBeenCalledWith("w1", "a", expect.objectContaining({ text: "w1 的内容" }));
  });

  it("旧发送成功时也不授权调用方清空新会话输入", async () => {
    const pending = deferred<Response>();
    prompt.mockReturnValueOnce(pending.promise);
    const sent = store.send({ text: "已投递给 A" });
    await flush();
    await switchTo("b");
    store.editorText = "B 的新草稿";
    pending.resolve({ success: true });
    expect(await sent).toBe(false);
    expect(store.editorText).toBe("B 的新草稿");
    await switchTo("a");
    expect(store.items.some((item) => "content" in item.message && item.message.content === "已投递给 A")).toBe(true);
  });
});

describe("取消与安全重试", () => {
  it("已停止后收到 notSent，不得唤醒重试", async () => {
    const pending = deferred<Response>();
    prompt.mockReturnValueOnce(pending.promise);
    const wake = vi.spyOn(store, "wakeRuntime").mockResolvedValue(true);
    const sent = store.send({ text: "停止这条" });
    await flush();
    await store.abortRun();
    pending.resolve({ success: false, notSent: true });
    expect(await sent).toBe(false);
    expect(wake).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "switch", "ABA"])("恢复期间 %s 后不得重发", async (action) => {
    const waking = deferred<boolean>();
    prompt.mockResolvedValueOnce({ success: false, notSent: true });
    const wake = vi.spyOn(store, "wakeRuntime").mockReturnValueOnce(waking.promise);
    const sent = store.send({ text: "不要重发" });
    await flush();
    expect(wake).toHaveBeenCalledTimes(1);
    if (action === "stop") await store.abortRun();
    else { await switchTo("b"); if (action === "ABA") await switchTo("a"); }
    waking.resolve(true);
    expect(await sent).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("可能只是确认丢失的 runtime 异常不能自动重发", async () => {
    prompt.mockRejectedValueOnce(new Error("智能体运行时不可用（phase=stopping）"));
    const wake = vi.spyOn(store, "wakeRuntime").mockResolvedValue(true);
    expect(await store.send({ text: "可能已经执行" })).toBe(false);
    expect(wake).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe("启动结果代际", () => {
  it.each(["resolve", "reject"])("旧 start 迟到 %s 不覆盖已经启动的 B", async (outcome) => {
    const a = deferred<ReturnType<typeof state>>();
    start.mockReturnValueOnce(a.promise).mockResolvedValueOnce(state("b"));
    const old = store.start("a");
    await store.start("b");
    if (outcome === "resolve") a.resolve(state("a"));
    else a.reject(new Error("旧启动失败"));
    await old;
    expect(store.currentSessionId).toBe("b");
    expect(store.piLoadedSessionId).toBe("b");
    expect(store.started).toBe(true);
    expect(store.startError).toBe("");
  });
});
