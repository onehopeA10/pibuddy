import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "./app";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function historyPage(text = "preview target") {
  return {
    entries: [
      { type: "message", message: { role: "user", content: text } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "preview-tool",
          toolName: "read",
          content: [{ type: "text", text: "preview output" }],
          isError: false,
        },
      },
    ],
    nextBeforeOffset: null,
    stale: false,
    skippedPartial: 0,
  };
}

function seedPreviousState() {
  const store = useAppStore();
  store.currentSessionId = "session-old";
  store.piLoadedSessionId = "session-old";
  store.currentSessionBytes = 321;
  store.items = [
    { key: 41, message: { role: "user", content: "previous message" } },
  ] as never;
  store.toolRuns["previous-tool"] = {
    toolCallId: "previous-tool",
    toolName: "write",
    args: { path: "old.txt" },
    status: "done",
    output: "previous output",
    images: [],
  };
  return store;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("openSession local preview", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("预览落地后立刻显示，不阻塞在还没回来的 switchSession 上", async () => {
    const preview = deferred<ReturnType<typeof historyPage>>();
    const switched = deferred<{ success: true; data: Record<string, never> }>();
    const switchSession = vi.fn(() => switched.promise);
    const getState = vi.fn(async () => ({ success: true, data: { sessionId: "session-target" } }));
    const getSessionStats = vi.fn(async () => ({ success: false }));
    const prompt = vi.fn(async () => ({ success: true }));
    const artifactsQuery = vi.fn(async () => ({ items: [], total: 0 }));
    (globalThis as unknown as { window: unknown }).window = {
      piBuddy: {
        sessions: { readHistoryBefore: vi.fn(() => preview.promise) },
        pi: {
          switchSession,
          getState,
          getSessionStats,
          prompt,
        },
        artifacts: { query: artifactsQuery },
      },
    };

    const store = seedPreviousState();
    store.workspaceId = "w1";
    const opening = store.openSession({ sessionId: "session-target", sizeBytes: 999 });

    preview.resolve(historyPage());
    await opening;

    expect(store.currentSessionId).toBe("session-target");
    expect(store.items.map((item) => item.message.role)).toEqual(["user"]);
    expect(store.switchingSessionId).toBeNull();
    expect(store.piLoadedSessionId).toBe("session-old");
    expect(artifactsQuery).not.toHaveBeenCalled();

    await flushMicrotasks();
    expect(switchSession).toHaveBeenCalledTimes(1);

    switched.resolve({ success: true, data: {} });
    await store.whenPiReady();
    expect(store.piLoadedSessionId).toBe("session-target");
    expect(switchSession).toHaveBeenCalledTimes(1);
    expect(getState).not.toHaveBeenCalled();
    expect(getSessionStats).not.toHaveBeenCalled();

    store.handleEvent({ type: "agent_settled" } as never);
    await flushMicrotasks();
    expect(getState).not.toHaveBeenCalled();
    expect(getSessionStats).not.toHaveBeenCalled();

    await store.send({ text: "切完立刻发" });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getState).not.toHaveBeenCalled();
  });

  it("过期预览不能盖掉正在打开的另一个会话", async () => {
    const firstPreview = deferred<ReturnType<typeof historyPage>>();
    const secondPreview = deferred<ReturnType<typeof historyPage>>();
    const readHistoryBefore = vi
      .fn()
      .mockImplementationOnce(() => firstPreview.promise)
      .mockImplementationOnce(() => secondPreview.promise);
    (globalThis as unknown as { window: unknown }).window = {
      piBuddy: {
        sessions: { readHistoryBefore },
        pi: {
          switchSession: vi.fn(async () => ({ success: true, data: {} })),
          getState: vi.fn(async () => ({ success: true, data: { sessionId: "session-b" } })),
          getSessionStats: vi.fn(async () => ({ success: false })),
        },
      },
    };

    const store = seedPreviousState();
    const first = store.openSession({ sessionId: "session-a", sizeBytes: 100 });
    await flushMicrotasks();
    const second = store.openSession({ sessionId: "session-b", sizeBytes: 200 });

    firstPreview.resolve(historyPage("session a"));
    secondPreview.resolve(historyPage("session b"));
    await Promise.all([first, second]);

    expect(store.currentSessionId).toBe("session-b");
    expect(store.items.map((item) => (item.message as { content?: string }).content)).toEqual([
      "session b",
    ]);
  });

  it("预览失败也不锁输入框，发送先落地再等 switch", async () => {
    const switched = deferred<{ success: true; data: Record<string, never> }>();
    const switchSession = vi.fn(() => switched.promise);
    const prompt = vi.fn(async () => ({ success: true }));
    (globalThis as unknown as { window: unknown }).window = {
      piBuddy: {
        sessions: { readHistoryBefore: vi.fn(), getDraft: vi.fn(async () => null) },
        pi: {
          switchSession,
          prompt,
          getMessages: vi.fn(async () => ({ success: true, data: { messages: [] } })),
        },
      },
    };

    const store = seedPreviousState();
    store.workspaceId = "w1";
    const opening = store.openSession({ sessionId: "session-target" });
    await nextTick();
    await flushMicrotasks();

    expect(store.currentSessionId).toBe("session-target");
    expect(store.switchingSessionId).toBeNull();
    expect(store.piLoadedSessionId).toBe("session-old");

    const accepted = await store.send({ text: "先发着" });
    expect(accepted).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(store.items.map((item) => (item.message as { content?: string }).content)).toContain(
      "先发着"
    );

    switched.resolve({ success: true, data: {} });
    await opening;
    await flushMicrotasks();
    await flushMicrotasks();
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
