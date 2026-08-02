<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { NButton } from "naive-ui";
import { useAppStore } from "../stores/app";
import MessageItem from "./MessageItem.vue";
import Welcome from "./Welcome.vue";

const store = useAppStore();
const scrollEl = ref<HTMLElement | null>(null);
let stickToBottom = true;

// 长会话只渲染最近的一段消息，避免几百条消息全量渲染卡住主线程。
// 效果等同虚拟滚动，但实现简单得多（聊天场景用户极少回看很早的内容）。
const INITIAL_WINDOW = 60;
const visibleCount = ref(INITIAL_WINDOW);

watch(
  () => store.agentState?.sessionFile,
  () => {
    visibleCount.value = INITIAL_WINDOW;
    stickToBottom = true;
  }
);

const hiddenCount = computed(() =>
  Math.max(0, store.items.length - visibleCount.value)
);
const visibleItems = computed(() =>
  hiddenCount.value > 0 ? store.items.slice(hiddenCount.value) : store.items
);

async function showEarlier(): Promise<void> {
  const el = scrollEl.value;
  const prevHeight = el?.scrollHeight ?? 0;
  stickToBottom = false;
  visibleCount.value += 100;
  await nextTick();
  // 扩窗后补偿滚动位置，视口停留在原来看到的消息上
  if (el) el.scrollTop += el.scrollHeight - prevHeight;
}

function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

watch(
  () => store.activityTick,
  async () => {
    if (!stickToBottom) return;
    await nextTick();
    const el = scrollEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  }
);
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
      <div v-if="hiddenCount > 0" style="text-align: center; margin-bottom: 16px">
        <n-button size="tiny" quaternary @click="showEarlier">
          ↑ 查看更早的 {{ hiddenCount }} 条消息
        </n-button>
      </div>
      <MessageItem
        v-for="item in visibleItems"
        :key="item.key"
        :message="item.message"
      />
      <MessageItem
        v-if="store.liveAssistant"
        :message="store.liveAssistant"
        streaming
      />
    </div>
  </div>
</template>
