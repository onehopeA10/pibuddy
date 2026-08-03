<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { NButton } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useChatWindow } from "../stores/chat-window";
import MessageItem from "./MessageItem.vue";
import Welcome from "./Welcome.vue";

const store = useAppStore();
const win = useChatWindow();
const scrollEl = ref<HTMLElement | null>(null);

/**
 * 流式滚动的唯一驱动。
 *
 * `stickToBottom` 现在住在 useChatWindow 里（未读分界线要读同一个判据），
 * 但**下面那个 activityTick watcher 一个字都不能删** —— 它是流式期间聊天区
 * 跟随滚动的唯一来源，丢了订阅不会报错，只是助手一边输出一边把内容顶到
 * 视口外面去。
 */
const stickToBottom = win.stickToBottom;

// 长会话只渲染最近的一段消息，避免几百条消息全量渲染卡住主线程。
const INITIAL_WINDOW = 60;
const visibleCount = ref(INITIAL_WINDOW);

watch(
  () => store.currentSessionId,
  () => {
    visibleCount.value = INITIAL_WINDOW;
    // sizeBytes 首屏用 0：真正的字节上界由 SessionListPanel 打开会话时给出，
    // 这里只保证换会话后不会带着上一会话的游标继续翻页。
    win.reset(0);
  }
);

const hiddenCount = computed(() =>
  Math.max(0, store.items.length - visibleCount.value)
);
const visibleItems = computed(() =>
  hiddenCount.value > 0 ? store.items.slice(hiddenCount.value) : store.items
);

/**
 * 向前扩窗的重入闸。
 *
 * 这道闸不能省：showEarlier 是 async 且会**写回 scrollTop**，而写 scrollTop
 * 又会再触发一次 scroll 事件。没有闸的话，滚到顶部会并发跑起好几份
 * showEarlier，每份都拿着自己那一刻的 prevHeight 去补偿，同一段高度差被
 * 重复加好几次，视口就来回弹 —— 表现就是「一直在抖」。
 */
const expanding = ref(false);

/** 内存里还没铺完，或磁盘上还有更早的字节 —— 两者都没有就别再扩了。 */
const canShowEarlier = computed(
  () => hiddenCount.value > 0 || !win.reachedTop.value
);

async function showEarlier(): Promise<void> {
  if (expanding.value || !canShowEarlier.value) return;
  expanding.value = true;
  const el = scrollEl.value;
  const prevHeight = el?.scrollHeight ?? 0;
  try {
    win.onLeaveBottom();
    // 上界钉在真实条数上：早先是无条件 +100，全部铺完后仍一路涨，
    // 于是 hiddenCount 恒为 0 而扩窗永远「成功」，闸门就形同虚设。
    visibleCount.value = Math.min(
      visibleCount.value + 100,
      Math.max(store.items.length, INITIAL_WINDOW)
    );
    // 内存里的还没铺完就先铺内存里的；铺完了才向主进程要更早的字节。
    if (hiddenCount.value === 0) await win.loadEarlier();
    await nextTick();
    // 扩窗后补偿滚动位置，视口停留在原来看到的消息上。
    // 高度没变就一个字节都不写：写 scrollTop 会再触发 scroll，白白多一轮。
    const grown = (el?.scrollHeight ?? 0) - prevHeight;
    if (el && grown > 0) el.scrollTop += grown;
  } finally {
    expanding.value = false;
  }
}

/**
 * 贴底判定必须**同步**更新：它驱动未读分界线与「跳到底部」按钮，慢一帧就
 * 会出现「已经在底部了按钮还亮着」。真正需要节流的是会写回 scrollTop 的
 * 扩窗动作 —— 那才是抖动的来源，由 showEarlier 自己的重入闸拦住。
 */
function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (atBottom) win.onReachBottom();
  else win.onLeaveBottom();
  if (el.scrollTop < 40) void showEarlier();
}

async function jumpToBottom(): Promise<void> {
  win.onReachBottom();
  await nextTick();
  const el = scrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// 新消息到达且视口不在底部 → 插一条未读分界线（只插第一条）
watch(
  () => store.items.length,
  (next, prev) => {
    if (next <= (prev ?? 0)) return;
    const last = store.items[store.items.length - 1];
    if (last) win.onIncoming(last.key);
  }
);

watch(
  () => store.activityTick,
  async () => {
    if (!stickToBottom.value) return;
    await nextTick();
    const el = scrollEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  }
);

onBeforeUnmount(() => win.dispose());

function resend(text: string): void {
  store.editorText = text;
}
</script>

<template>
  <div ref="scrollEl" class="chat-scroll" @scroll.passive="onScroll">
    <!--
      切换会话成功、但消息没读出来。此时旧消息已被清空（不能拿旧会话的内容
      冒充新会话），必须明确告诉用户「这是加载失败」而不是「这个会话是空的」。
    -->
    <div v-if="store.sessionLoadError" class="session-load-error">
      <span>😕 会话内容没能加载出来：{{ store.sessionLoadError }}</span>
      <n-button size="tiny" type="primary" secondary @click="store.reloadMessages()">
        重试
      </n-button>
    </div>
    <Welcome
      v-if="store.items.length === 0 && !store.liveAssistant && !store.sessionLoadError"
    />
    <div v-else class="chat-inner">
      <div v-if="win.loadError.value" class="history-load-error">
        <span>😕 更早的消息没能加载出来：{{ win.loadError.value }}</span>
        <n-button
          size="tiny"
          type="primary"
          secondary
          aria-label="重试加载更早的消息"
          @click="win.retry()"
        >
          重试
        </n-button>
      </div>
      <div v-else-if="canShowEarlier" style="text-align: center; margin-bottom: 16px">
        <n-button
          size="tiny"
          quaternary
          :loading="win.loading.value"
          aria-label="查看更早的消息"
          @click="showEarlier"
        >
          ↑ 查看更早的消息{{ hiddenCount > 0 ? `（还有 ${hiddenCount} 条）` : "" }}
        </n-button>
      </div>

      <template v-for="item in visibleItems" :key="item.key">
        <div
          v-if="win.unreadDivider.value === item.key"
          data-unread-divider
          class="unread-divider"
        >
          <span>以下是新消息</span>
        </div>
        <MessageItem
          :message="item.message"
          :message-key="item.key"
          @resend="resend"
        />
      </template>
      <MessageItem
        v-if="store.liveAssistant"
        :message="store.liveAssistant"
        streaming
      />
    </div>

    <n-button
      v-if="!win.stickToBottom.value"
      class="jump-bottom"
      size="tiny"
      secondary
      aria-label="跳到底部"
      @click="jumpToBottom"
    >
      ↓ 跳到底部
    </n-button>
  </div>
</template>

<style scoped>
.unread-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  color: #ef4444;
  font-size: 12px;
}
.unread-divider::before,
.unread-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #fecaca;
}
.history-load-error {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
  margin-bottom: 16px;
  font-size: 12.5px;
  color: #b45309;
}
.jump-bottom {
  position: sticky;
  bottom: 12px;
  left: 50%;
}
</style>
