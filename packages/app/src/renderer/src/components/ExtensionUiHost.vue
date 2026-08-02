<script setup lang="ts">
/**
 * 扩展弹窗的渲染宿主（EXT-101）。
 *
 * 三条纪律：
 *
 * 1. **一切按纯文本渲染**。这里没有、也不会有 `v-html`：请求的 title /
 *    message / options / prefill 全都来自扩展代码，而扩展是第三方 TypeScript
 *    模块。用插值渲染意味着它最多能显示一串字符，拿不到任何 Electron API，
 *    也造不出可点击的东西。
 * 2. **失效即关闭**。主进程的 pi:ui-expire 到达时 store 会把这一条移出队列，
 *    这里因此自动关闭 —— 改造前 modal 是 mask-closable:false 的，超时之后
 *    用户面对一个关不掉、点了也没反应的框，而发出去的响应带着一个失效 id。
 * 3. **回答要看结果**。store.respondUi 返回 `{ok, reason}`，失败时给用户
 *    一句话，而不是让弹窗静静消失、助手那边什么都没收到。
 */
import { computed, nextTick, ref, watch } from "vue";
import { NButton, NInput, NModal, NSpace, NText } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useExtensionUiStore } from "../stores/extensionUi";

const store = useAppStore();
const extUi = useExtensionUiStore();

/** 一次只问一个问题；其余按到达顺序排队（pi 那边每一条都在阻塞等待）。 */
const current = computed(() => extUi.uiRequests[0] ?? null);
const queuedCount = computed(() => Math.max(0, extUi.uiRequests.length - 1));
const inputValue = ref("");
const inputRef = ref<{ focus: () => void } | null>(null);

watch(current, (req) => {
  inputValue.value = req?.prefill ?? "";
  // 焦点回归：弹窗出现时把光标放进输入框，用户不必先摸鼠标
  if (req && (req.method === "input" || req.method === "editor")) {
    void nextTick(() => inputRef.value?.focus());
  }
});

/** 有 timeout 的请求要让用户知道「这个问题会自己过期」。 */
const timeoutHint = computed(() => {
  const ms = current.value?.timeout;
  if (typeof ms !== "number" || ms <= 0) return "";
  return `助手最多等 ${Math.round(ms / 1000)} 秒`;
});

function cancel(): void {
  if (current.value) void store.respondUi(current.value, { cancelled: true });
}
</script>

<template>
  <n-modal
    :show="current !== null"
    preset="card"
    style="max-width: 520px"
    :title="current?.title || '助手需要你的确认'"
    :aria-label="current?.title || '助手需要你的确认'"
    role="dialog"
    :mask-closable="false"
    :closable="true"
    :auto-focus="false"
    @close="cancel"
    @esc="cancel"
  >
    <template v-if="current">
      <!-- 选择 -->
      <template v-if="current.method === 'select'">
        <p v-if="current.message" class="ext-message">{{ current.message }}</p>
        <n-space vertical>
          <n-button
            v-for="opt in current.options ?? []"
            :key="opt"
            block
            secondary
            :aria-label="opt"
            @click="store.respondUi(current, { value: opt })"
          >
            {{ opt }}
          </n-button>
        </n-space>
      </template>

      <!-- 确认 -->
      <template v-else-if="current.method === 'confirm'">
        <p class="ext-message">{{ current.message }}</p>
        <n-space justify="end">
          <n-button @click="store.respondUi(current, { confirmed: false })">取消</n-button>
          <n-button type="primary" @click="store.respondUi(current, { confirmed: true })">
            确认
          </n-button>
        </n-space>
      </template>

      <!-- 输入 / 编辑 -->
      <template v-else-if="current.method === 'input' || current.method === 'editor'">
        <p v-if="current.message" class="ext-message">{{ current.message }}</p>
        <n-input
          ref="inputRef"
          v-model:value="inputValue"
          :type="current.method === 'editor' ? 'textarea' : 'text'"
          :autosize="current.method === 'editor' ? { minRows: 4, maxRows: 14 } : undefined"
          :placeholder="current.placeholder ?? ''"
          :aria-label="current.title || '请输入'"
        />
        <n-space justify="end" style="margin-top: 16px">
          <n-button @click="cancel">取消</n-button>
          <n-button type="primary" @click="store.respondUi(current, { value: inputValue })">
            确定
          </n-button>
        </n-space>
      </template>
    </template>

    <template #footer>
      <div class="ext-footer">
        <n-text v-if="timeoutHint" depth="3">{{ timeoutHint }}</n-text>
        <n-text v-if="queuedCount > 0" depth="3">
          还有 {{ queuedCount }} 个问题在排队
        </n-text>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.ext-message {
  margin: 0 0 16px;
  white-space: pre-wrap;
  word-break: break-word;
}
.ext-footer {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  font-size: 12px;
}
</style>
