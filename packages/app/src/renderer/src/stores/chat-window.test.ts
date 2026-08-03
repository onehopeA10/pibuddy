/**
 * 分段数据源的翻页 / 新鲜度 / 失败重试（CRITICAL-1）。
 *
 * 反向分页在 pi RPC 层不存在（rpc.md:696 的 since 只返回 strictly after），
 * 所以这里 mock 的是 `sessions.readHistoryBefore`，也就是主进程按 JSONL
 * 字节 offset 本地读取的那条路。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { SessionHistoryPage } from "@contract";
import { useAppStore } from "./app";
import { useChatWindow } from "./chat-window";

function page(
  entries: unknown[],
  nextBeforeOffset: number | null,
  stale = false
): SessionHistoryPage {
  return { entries, nextBeforeOffset, stale, skippedPartial: 0 } as SessionHistoryPage;
}

let readHistoryBefore: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;

function installBridge(): void {
  (globalThis as unknown as { window: unknown }).window = {
    piBuddy: {
      sessions: { readHistoryBefore, query, getDraft: vi.fn(async () => null) },
      pi: {},
    },
  };
}

describe("useChatWindow · 向更早翻页", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    readHistoryBefore = vi.fn();
    query = vi.fn(async () => []);
    installBridge();
  });

  it("(a)(b) 三页翻完后到顶，再滚到顶不再发请求", async () => {
    readHistoryBefore
      .mockResolvedValueOnce(page([{ type: "a" }], 700))
      .mockResolvedValueOnce(page([{ type: "b" }], 300))
      .mockResolvedValueOnce(page([{ type: "c" }], null));

    const win = useChatWindow();
    win.reset(1000);

    await win.loadEarlier();
    await win.loadEarlier();
    await win.loadEarlier();
    expect(win.requestCount.value).toBe(3);
    expect(win.reachedTop.value).toBe(true);
    // 最早的在前
    expect(win.earlier.value).toEqual([{ type: "c" }, { type: "b" }, { type: "a" }]);

    // 到顶之后用户还停在顶部，scroll 会持续触发 —— 一次都不能再发
    await win.loadEarlier();
    await win.loadEarlier();
    expect(win.requestCount.value).toBe(3);
  });

  it("(c) stale 时先同步一次会话索引再重试，且只重试一次", async () => {
    readHistoryBefore
      .mockResolvedValueOnce(page([], 1000, true))
      .mockResolvedValueOnce(page([{ type: "a" }], 700));

    const win = useChatWindow();
    win.reset(1000);
    await win.loadEarlier();

    expect(query).toHaveBeenCalledTimes(1);
    expect(readHistoryBefore).toHaveBeenCalledTimes(2);
    expect(win.earlier.value).toEqual([{ type: "a" }]);
  });

  it("(d) 请求抛错时 loadError 为真，retry() 只重发一次", async () => {
    readHistoryBefore
      .mockRejectedValueOnce(new Error("磁盘忙"))
      .mockResolvedValueOnce(page([{ type: "a" }], null));

    const win = useChatWindow();
    win.reset(1000);
    await win.loadEarlier();
    expect(win.loadError.value).toBeTruthy();
    expect(win.requestCount.value).toBe(1);

    await win.retry();
    expect(win.loadError.value).toBe("");
    expect(win.requestCount.value).toBe(2);

    // 已经成功了，再点重试不该再发
    await win.retry();
    expect(win.requestCount.value).toBe(2);
  });

  it("请求参数是字节 offset，不是 entryId", async () => {
    readHistoryBefore.mockResolvedValueOnce(page([], null));
    const store = useAppStore();
    store.currentSessionId = "sess-9";
    const win = useChatWindow();
    win.reset(4096);
    await win.loadEarlier();
    expect(readHistoryBefore).toHaveBeenCalledWith({
      sessionId: "sess-9",
      beforeOffset: 4096,
      limit: 60,
    });
  });
});

describe("useChatWindow · 未读分界线", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    readHistoryBefore = vi.fn();
    query = vi.fn(async () => []);
    installBridge();
    vi.useFakeTimers();
  });

  it("不在底部时插一条、且只插一条；回到底部后 1100ms 消失", () => {
    const win = useChatWindow();
    win.reset(0);

    win.onLeaveBottom();
    win.onIncoming(11);
    expect(win.unreadDivider.value).toBe(11);

    // 又来三条：分界线不移动，也不重复插
    win.onIncoming(12);
    win.onIncoming(13);
    win.onIncoming(14);
    expect(win.unreadDivider.value).toBe(11);

    win.onReachBottom();
    vi.advanceTimersByTime(1100);
    expect(win.unreadDivider.value).toBe(null);
    vi.useRealTimers();
  });
});

/**
 * 翻页读到的消息必须真的出现在界面上。
 *
 * 改造前 loadEarlier 只把条目塞进自己的 `earlier` 数组，而 ChatView 渲染的
 * 是 store.items —— 全项目再无第二处引用 `earlier`。表现是：磁盘读了、游标
 * 前进了、requestCount 也加了，**界面上一条都不会多**。三大门禁全绿。
 */
describe("useChatWindow · 翻页结果接入渲染", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    readHistoryBefore = vi.fn();
    query = vi.fn(async () => []);
    installBridge();
  });

  it("读到的 message 条目被接到 store.items 前面，非 message 条目被忽略", async () => {
    const app = useAppStore();
    app.items = [{ key: 999, message: { role: "user", content: "现有的一条" } }] as never;

    readHistoryBefore.mockResolvedValueOnce(
      page(
        [
          // 会话文件里混着非消息条目，不能当成消息渲染
          { type: "model_change", provider: "openai", modelId: "gpt-5.6" },
          { type: "message", message: { role: "user", content: "更早的提问" } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "更早的回答" }] } },
        ],
        null
      )
    );

    const win = useChatWindow();
    win.reset(5000);
    await win.loadEarlier();

    // 2 条更早的 + 原有 1 条
    expect(app.items).toHaveLength(3);
    // 顺序：更早的在前，且原有那条仍在最后
    expect((app.items[0].message as { content: unknown }).content).toBe("更早的提问");
    expect(app.items[2].key).toBe(999);
  });
});
