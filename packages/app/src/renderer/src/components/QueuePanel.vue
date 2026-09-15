<script setup lang="ts">
/**
 * 输入队列面板。
 *
 * **两段队列，权限完全不同**：
 *
 *   - 上半段是本地**未提交**的条目（还没发出去），可以改、可以删；
 *   - 下半段是已经交给 pi 的条目（来自 queue_update）。pi 的 queue_update
 *     只给字符串数组、没有稳定 id，协议里也没有任何「撤回队列项」的命令 ——
 *     所以这段是**只读**的。给它配一个删除按钮是骗人：点了什么都不会发生，
 *     而助手照样会执行那条指令。
 */
import { ref } from "vue";
import { useAppStore } from "../stores/app";

const store = useAppStore();
const editingId = ref<number | null>(null);
const editingText = ref("");

function startEdit(id: number, text: string): void {
  editingId.value = id;
  editingText.value = text;
}

function commitEdit(): void {
  if (editingId.value === null) return;
  store.updateLocalQueueItem(editingId.value, editingText.value);
  editingId.value = null;
}
</script>

<template>
  <div
    v-if="store.localQueue.length || store.queue.steering.length || store.queue.followUp.length"
    class="queue-panel"
  >
    <section v-if="store.localQueue.length" data-queue-section="local">
      <div class="queue-title">还没发出去的（可以改，也可以删）</div>
      <div v-for="item in store.localQueue" :key="item.id" class="queue-item">
        <span class="queue-mode">{{ item.mode === "steer" ? "立即插话" : "下一轮处理" }}</span>
        <template v-if="editingId === item.id">
          <input v-model="editingText" aria-label="修改队列内容" @keyup.enter="commitEdit" />
          <button type="button" aria-label="保存修改" @click="commitEdit">保存</button>
        </template>
        <template v-else>
          <span class="queue-text">{{ item.text }}</span>
          <button type="button" aria-label="编辑" @click="startEdit(item.id, item.text)">
            编辑
          </button>
          <button type="button" aria-label="删除" @click="store.removeLocalQueueItem(item.id)">
            删除
          </button>
        </template>
      </div>
    </section>

    <section
      v-if="store.queue.steering.length || store.queue.followUp.length"
      data-queue-section="committed"
    >
      <div class="queue-title">
        已经交给助手了（不可撤回：pi 没有提供撤回队列的命令）
      </div>
      <div
        v-for="(text, i) in store.queue.steering"
        :key="`steer-${i}`"
        class="queue-item readonly"
      >
        <span class="queue-mode">立即插话</span>
        <span class="queue-text">{{ text }}</span>
      </div>
      <div
        v-for="(text, i) in store.queue.followUp"
        :key="`follow-${i}`"
        class="queue-item readonly"
      >
        <span class="queue-mode">下一轮处理</span>
        <span class="queue-text">{{ text }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.queue-panel {
  font-size: var(--font-ui-12);
  padding: 6px 10px;
  border-top: var(--border-w) solid var(--border-subtle);
}
.queue-title {
  color: var(--text-tertiary);
  margin: 4px 0;
}
.queue-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.queue-item.readonly {
  opacity: 0.75;
}
.queue-mode {
  color: var(--accent);
  flex: none;
}
.queue-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-item button {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: var(--font-ui-12);
}
</style>
