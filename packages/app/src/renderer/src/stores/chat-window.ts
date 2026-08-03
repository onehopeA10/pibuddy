/**
 * 聊天区的**分段数据源**（SES-102）。
 *
 * ## 两条取数路径，方向不同、机制也不同
 *
 *   - 向**后**（新消息）：主进程用 `{ since: lastEntryId }` 的 RPC 增量拉取，
 *     经 event-forwarder 下发。渲染层一条 RPC 都不发。
 *   - 向**前**（更早历史）：走 `window.piBuddy.sessions.readHistoryBefore`，
 *     由主进程按 JSONL 字节 offset 本地反向读取。
 *
 * 之所以必须分开：pi 0.83 的取条目命令只有一个 `since` 参数，rpc.md:696 原文
 * 是 "get only entries **strictly after** it"，全协议没有 before / limit ——
 * 反向分页在 RPC 层根本不存在。把它写回 RPC 不会报错，只会让「加载更早的
 * 消息」永远返回空。因此本文件**不含任何 pi RPC 调用**。
 *
 * ## 游标是字节，不是 entryId
 *
 * `beforeOffset` 首屏取 `SessionRow.sizeBytes`，之后取上一页返回的
 * `nextBeforeOffset`；为 null 即已到文件头，此后不再发请求（少了这个判据，
 * 用户停在顶部会让请求无限打下去）。
 */
import { ref, type Ref } from "vue";
import type { SessionHistoryPage } from "@contract";
import { useAppStore } from "./app";

/** 每页条数。与首屏窗口大小一致，翻页时视口高度变化最平滑。 */
export const PAGE_SIZE = 60;

/** 回到底部后，未读分界线保留多久再消失（毫秒）。 */
export const UNREAD_LINGER_MS = 1000;

/**
 * 一次「查看更早的消息」最多往前追几页。
 *
 * 只有「整页消息都已经在内存里」时才会用到（首屏 beforeOffset = 文件长度，
 * 与 get_messages 填出来的那一段必然重叠）。给上限是为了让一次点击的代价
 * 有界：压缩过的长会话里，重叠段可能有好几页。
 */
export const MAX_OVERLAP_PAGES = 5;

export interface ChatWindow {
  /** 已向前加载出来的更早条目（原始 JSONL 记录，最早的在前）。 */
  earlier: Ref<unknown[]>;
  loading: Ref<boolean>;
  /** 非空表示上一次向前翻页失败，UI 显示重试按钮。 */
  loadError: Ref<string>;
  /** 已经读到文件头，不该再发请求。 */
  reachedTop: Ref<boolean>;
  nextBeforeOffset: Ref<number | null>;
  /** 视口是否贴着底部。false 时新消息不抢滚动，改插未读分界线。 */
  stickToBottom: Ref<boolean>;
  /** 未读分界线插在哪条消息 key **之前**；null 表示不显示。 */
  unreadDivider: Ref<number | null>;
  /** 仅供单测：向前翻页的实际请求次数。 */
  requestCount: Ref<number>;

  reset(initialBeforeOffset: number): void;
  /**
   * 补一个更靠后的字节上界（会话文件在索引里刚被读到 / 刚变长）。
   *
   * 与 reset 分开是因为语义不同：reset 是「换会话，一切从头」，这个是
   * 「上界比原先知道的更大」。已经翻过页之后一律忽略 —— 那时游标代表的是
   * 用户真实的阅读进度，被文件末尾覆盖掉就等于把翻页成果清零。
   */
  adoptOffset(offset: number): void;
  loadEarlier(): Promise<void>;
  retry(): Promise<void>;
  onIncoming(messageKey: number): void;
  onReachBottom(): void;
  onLeaveBottom(): void;
  dispose(): void;
}

export function useChatWindow(): ChatWindow {
  const store = useAppStore();

  const earlier = ref<unknown[]>([]);
  const loading = ref(false);
  const loadError = ref("");
  const reachedTop = ref(false);
  const nextBeforeOffset = ref<number | null>(null);
  const stickToBottom = ref(true);
  const unreadDivider = ref<number | null>(null);
  const requestCount = ref(0);

  let unreadTimer: ReturnType<typeof setTimeout> | null = null;

  function reset(initialBeforeOffset: number): void {
    earlier.value = [];
    loading.value = false;
    loadError.value = "";
    reachedTop.value = initialBeforeOffset <= 0;
    nextBeforeOffset.value = initialBeforeOffset;
    stickToBottom.value = true;
    unreadDivider.value = null;
    requestCount.value = 0;
    if (unreadTimer) {
      clearTimeout(unreadTimer);
      unreadTimer = null;
    }
  }

  function adoptOffset(offset: number): void {
    if (requestCount.value > 0) return;
    if (offset <= (nextBeforeOffset.value ?? 0)) return;
    nextBeforeOffset.value = offset;
    reachedTop.value = false;
  }

  async function fetchPage(beforeOffset: number): Promise<SessionHistoryPage> {
    requestCount.value++;
    return window.piBuddy.sessions.readHistoryBefore({
      workspaceId: store.workspaceId,
      sessionId: store.currentSessionId,
      beforeOffset,
      limit: PAGE_SIZE,
    });
  }

  /**
   * 向更早翻一页。
   *
   * 到顶 / 正在加载 / 上一次失败未重试时都直接返回 —— 尤其是「到顶」：滚动
   * 条停在顶部会持续触发 scroll 事件，少这一道判据就是无限请求。
   */
  async function loadEarlier(): Promise<void> {
    if (loading.value || reachedTop.value) return;
    loading.value = true;
    loadError.value = "";
    try {
      // 首屏的 beforeOffset 就是文件长度，而 store.items 已经由 pi 的
      // get_messages 填满 —— 第一页磁盘数据与内存里的必然是同一批消息，
      // prependMessages 会把它们整批去重掉。此时若直接返回，用户点了一次
      // 「查看更早的消息」而界面纹丝不动。因此**整页都是重复**时再往前一页，
      // 上限 MAX_OVERLAP_PAGES 页 —— 无上限的话，一次点击可能把整个文件读完。
      for (let i = 0; i < MAX_OVERLAP_PAGES; i++) {
        const offset = nextBeforeOffset.value;
        if (offset === null || offset <= 0) {
          reachedTop.value = true;
          break;
        }
        let page = await fetchPage(offset);
        if (page.stale) {
          // 索引与磁盘对不上（会话在两次调用之间被追加过）。先同步一次索引，
          // 再**只重试一次** —— 会话正在流式写入时无限重试会把界面钉死。
          await window.piBuddy.sessions.query(store.workspaceId);
          page = await fetchPage(offset);
        }
        earlier.value = [...page.entries, ...earlier.value];
        // **必须接进 items**：ChatView 渲染的是 store.items，`earlier` 全项目
        // 再无第二处引用。只填 earlier 的话，磁盘读了、游标前进了、requestCount
        // 也加了，而界面上一条消息都不会多 —— 不报错、不失败类型检查，纯静默。
        const messages = store.entriesToMessages(page.entries);
        const added = store.prependMessages(messages);
        nextBeforeOffset.value = page.nextBeforeOffset;
        if (page.nextBeforeOffset === null) {
          reachedTop.value = true;
          break;
        }
        // 这一页本来就没有消息条目（全是 model_change 之类）：那是一页正常的
        // 数据，不算「重叠」，不再往前追。
        if (messages.length === 0 || added > 0) break;
      }
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : "加载更早的消息失败";
    } finally {
      loading.value = false;
    }
  }

  /** 失败后由用户点「重试」触发，只重发一次。 */
  async function retry(): Promise<void> {
    if (!loadError.value) return;
    loadError.value = "";
    await loadEarlier();
  }

  /**
   * 有新消息到达。
   *
   * 视口不在底部时插一条未读分界线，并且**只插第一条**：后续新消息不再
   * 移动分界线，否则用户往回看的位置会被不停顶走。
   */
  function onIncoming(messageKey: number): void {
    if (stickToBottom.value) return;
    if (unreadDivider.value !== null) return;
    unreadDivider.value = messageKey;
  }

  /** 视口回到底部：分界线再停留一会儿让用户看清读到哪了，然后撤掉。 */
  function onReachBottom(): void {
    stickToBottom.value = true;
    if (unreadDivider.value === null) return;
    if (unreadTimer) clearTimeout(unreadTimer);
    unreadTimer = setTimeout(() => {
      unreadTimer = null;
      unreadDivider.value = null;
    }, UNREAD_LINGER_MS);
  }

  function onLeaveBottom(): void {
    stickToBottom.value = false;
  }

  function dispose(): void {
    if (unreadTimer) {
      clearTimeout(unreadTimer);
      unreadTimer = null;
    }
  }

  return {
    earlier,
    loading,
    loadError,
    reachedTop,
    nextBeforeOffset,
    stickToBottom,
    unreadDivider,
    requestCount,
    reset,
    adoptOffset,
    loadEarlier,
    retry,
    onIncoming,
    onReachBottom,
    onLeaveBottom,
    dispose,
  };
}
