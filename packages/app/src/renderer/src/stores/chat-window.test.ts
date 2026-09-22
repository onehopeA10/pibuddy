/**
 * 分段数据源的翻页 / 新鲜度 / 失败重试（CRITICAL-1）。
 *
 * 反向分页在 pi RPC 层不存在（rpc.md:696 的 since 只返回 strictly after），
 * 所以这里 mock 的是 `sessions.readHistoryBefore`，也就是主进程按 JSONL
 * 字节 offset 本地读取的那条路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    store.workspaceId = "ws-1";
    store.currentSessionId = "sess-9";
    const win = useChatWindow();
    win.reset(4096);
    await win.loadEarlier();
    // workspaceId 与 sessionId 成对下发：sessionId 只在一个工作区之内唯一
    expect(readHistoryBefore).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionId: "sess-9",
      beforeOffset: 4096,
      limit: 7,
    });
  });
});

describe("useChatWindow · 异步预读与会话隔离", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    readHistoryBefore = vi.fn();
    query = vi.fn(async () => []);
    installBridge();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  const entry = (text: string) => ({
    type: "message", message: { role: "user", content: text },
  });

  function deferredPage() {
    let resolve!: (value: SessionHistoryPage) => void;
    const promise = new Promise<SessionHistoryPage>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("首屏先返回，之后每批7条沿上页游标补载，并保留期间的新消息", async () => {
    const store = useAppStore();
    store.workspaceId = "ws";
    store.currentSessionId = "s1";
    store.historyBeforeOffset = 700;
    store.items = [{ key: 100, message: { role: "user", content: "首屏" } }] as never;
    const pending = deferredPage();
    readHistoryBefore.mockReturnValueOnce(pending.promise);
    const win = useChatWindow();
    win.reset(store.historyBeforeOffset);
    win.prefetch();
    expect(readHistoryBefore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(readHistoryBefore).toHaveBeenCalledWith({
      workspaceId: "ws", sessionId: "s1", beforeOffset: 700, limit: 7,
    });
    store.items = [...store.items, { key: 101, message: { role: "user", content: "新消息" } }] as never;
    pending.resolve(page([entry("更早历史")], null));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.items.map((item) => (item.message as { content: string }).content))
      .toEqual(["更早历史", "首屏", "新消息"]);
    expect(store.historyBeforeOffset).toBeNull();
    expect(win.reachedTop.value).toBe(true);
    win.dispose();
  });

  it("预读有批数上限，不会自动读完整个长会话", async () => {
    let offset = 1000;
    readHistoryBefore.mockImplementation(async () => {
      offset -= 10;
      return page([entry(`history-${offset}`)], offset);
    });
    const win = useChatWindow();
    win.reset(1000);
    win.prefetch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(readHistoryBefore).toHaveBeenCalledTimes(8);
    expect(readHistoryBefore.mock.calls.every(([args]) => args.limit === 7)).toBe(true);
    win.dispose();
  });

  it("预读只补足60条，定时器等待期间新增消息也计入上限", async () => {
    const store = useAppStore();
    const win = useChatWindow();
    win.reset(1000);
    win.prefetch();
    store.items = Array.from({ length: 59 }, (_, i) => ({
      key: 1000 + i, message: { role: "user", content: `existing-${i}` },
    })) as never;
    readHistoryBefore.mockResolvedValueOnce(page([entry("older")], 900));
    await vi.advanceTimersByTimeAsync(1000);
    expect(readHistoryBefore).toHaveBeenCalledTimes(1);
    expect(readHistoryBefore.mock.calls[0][0].limit).toBe(1);
    expect(store.items).toHaveLength(60);
    win.dispose();
  });

  it("A的迟到结果不能写入B，也不能提前解除B的加载状态", async () => {
    const store = useAppStore();
    store.currentSessionId = "a";
    const a = deferredPage();
    const b = deferredPage();
    readHistoryBefore.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const win = useChatWindow();
    win.reset(1000);
    const loadingA = win.loadEarlier();
    store.currentSessionId = "b";
    win.reset(2000);
    const loadingB = win.loadEarlier();
    a.resolve(page([entry("from a")], null));
    await loadingA;
    expect(store.items).toHaveLength(0);
    expect(win.loading.value).toBe(true);
    expect(win.nextBeforeOffset.value).toBe(2000);
    b.resolve(page([entry("from b")], 1000));
    await loadingB;
    expect(store.items[0].message).toMatchObject({ content: "from b" });
    expect(win.loading.value).toBe(false);
    win.dispose();
  });

  it.each(["workspace", "history-reset", "dispose"])("%s后忽略已经发出的补载", async (change) => {
    const store = useAppStore();
    store.workspaceId = "w1";
    const pending = deferredPage();
    readHistoryBefore.mockReturnValueOnce(pending.promise);
    const win = useChatWindow();
    win.reset(1000);
    const loading = win.loadEarlier();
    if (change === "workspace") store.workspaceId = "w2";
    if (change === "history-reset") store.historyGeneration++;
    if (change === "dispose") win.dispose();
    pending.resolve(page([entry("outdated")], null));
    await loading;
    expect(store.items).toHaveLength(0);
    expect(store.historyBeforeOffset).toBeUndefined();
    win.dispose();
  });

  it("切换前撤销未开始的预读，文件变长不覆盖首屏游标", async () => {
    const store = useAppStore();
    store.historyBeforeOffset = 700;
    const win = useChatWindow();
    win.reset(700);
    win.adoptOffset(5000);
    expect(win.nextBeforeOffset.value).toBe(700);
    win.prefetch();
    win.reset(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readHistoryBefore).not.toHaveBeenCalled();
    win.dispose();
  });

  it("预读失败保留现有消息和游标，重试仍从失败处读取", async () => {
    const store = useAppStore();
    store.items = [{ key: 50, message: { role: "user", content: "首屏" } }] as never;
    readHistoryBefore.mockRejectedValueOnce(new Error("暂时失败"))
      .mockResolvedValueOnce(page([entry("历史")], null));
    const win = useChatWindow();
    win.reset(700);
    win.prefetch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(readHistoryBefore).toHaveBeenCalledTimes(1);
    expect(store.items).toHaveLength(1);
    expect(win.nextBeforeOffset.value).toBe(700);
    expect(win.loadError.value).toBe("暂时失败");
    await win.retry();
    expect(readHistoryBefore.mock.calls[1][0].beforeOffset).toBe(700);
    expect(store.items).toHaveLength(2);
    win.dispose();
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

/**
 * 磁盘反向分页的开关就是 sizeBytes（SES-3）。
 *
 * `reset(0)` 会让 `reachedTop` 在那一刻就为 true —— 设计里那条 JSONL 反向
 * 分页从此一次都不会执行。它不报错、不失败类型检查，表现只是「压缩过的长
 * 会话，更早的消息怎么点都出不来」。
 */
describe("useChatWindow · 字节上界", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    readHistoryBefore = vi.fn();
    query = vi.fn(async () => []);
    installBridge();
  });

  it("reset(0) 即判定到顶，一次请求都不会发", async () => {
    const win = useChatWindow();
    win.reset(0);
    expect(win.reachedTop.value).toBe(true);
    await win.loadEarlier();
    expect(readHistoryBefore).not.toHaveBeenCalled();
  });

  it("reset(真实字节数) 之后翻页真的读得到磁盘", async () => {
    readHistoryBefore.mockResolvedValueOnce(page([{ type: "x" }], null));
    const win = useChatWindow();
    win.reset(4096);
    expect(win.reachedTop.value).toBe(false);
    await win.loadEarlier();
    expect(readHistoryBefore).toHaveBeenCalledTimes(1);
  });

  it("字节数迟到时 adoptOffset 补得上；翻过页之后不再覆盖阅读进度", async () => {
    readHistoryBefore.mockResolvedValueOnce(page([{ type: "x" }], 300));
    const win = useChatWindow();
    // 开机恢复会话：currentSessionId 先变，字节数要等索引刷新完才知道
    win.reset(0);
    expect(win.reachedTop.value).toBe(true);

    win.adoptOffset(4096);
    expect(win.reachedTop.value).toBe(false);
    expect(win.nextBeforeOffset.value).toBe(4096);

    await win.loadEarlier();
    expect(win.nextBeforeOffset.value).toBe(300);

    // 会话又变长了：已经翻过页，游标代表阅读进度，不能被文件末尾顶回去
    win.adoptOffset(8192);
    expect(win.nextBeforeOffset.value).toBe(300);
  });
});

/**
 * 两条取数路径的重叠（SES-3）。
 *
 * `store.items` 由 pi 的 get_messages 填充，而首屏的 beforeOffset 就是文件
 * 长度 —— 第一页磁盘数据必然与内存里已有的那一段是同一批消息。不去重就是
 * 同一条消息在界面上出现两遍，而且「点一次多一份」。
 */
describe("useChatWindow · 与内存数据的重叠", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    readHistoryBefore = vi.fn();
    query = vi.fn(async () => []);
    installBridge();
  });

  function messageEntry(text: string, timestamp: number): unknown {
    return { type: "message", message: { role: "user", content: text, timestamp } };
  }

  it("整页都是内存里已有的消息时去重，并自动再往前取一页", async () => {
    const app = useAppStore();
    app.items = [
      { key: 1, message: { role: "user", content: "已经在内存里", timestamp: 111 } },
    ] as never;

    readHistoryBefore
      .mockResolvedValueOnce(page([messageEntry("已经在内存里", 111)], 500))
      .mockResolvedValueOnce(page([messageEntry("真正更早的一条", 50)], null));

    const win = useChatWindow();
    win.reset(1000);
    await win.loadEarlier();

    // 重复的那条没有被再插一遍
    expect(app.items).toHaveLength(2);
    expect((app.items[0].message as { content: unknown }).content).toBe("真正更早的一条");
    expect(win.requestCount.value).toBe(2);
  });

  it("同一页读两次也只接上一次（重入不会把消息插重）", async () => {
    const app = useAppStore();
    app.items = [] as never;
    readHistoryBefore
      .mockResolvedValueOnce(page([messageEntry("更早的一条", 50)], null))
      .mockResolvedValueOnce(page([messageEntry("更早的一条", 50)], null));

    const win = useChatWindow();
    win.reset(1000);
    await win.loadEarlier();
    win.reset(1000);
    await win.loadEarlier();

    expect(app.items).toHaveLength(1);
  });
});
