<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NButton, NInput, NModal, NSpace } from "naive-ui";
import { useAppStore } from "../stores/app";

const store = useAppStore();
const current = computed(() => store.uiRequests[0] ?? null);
const inputValue = ref("");

watch(current, (req) => {
  inputValue.value = req?.prefill ?? "";
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
    :mask-closable="false"
    :closable="true"
    @close="cancel"
  >
    <template v-if="current">
      <!-- 选择 -->
      <template v-if="current.method === 'select'">
        <n-space vertical>
          <n-button
            v-for="opt in current.options ?? []"
            :key="opt"
            block
            secondary
            @click="store.respondUi(current, { value: opt })"
          >
            {{ opt }}
          </n-button>
        </n-space>
      </template>

      <!-- 确认 -->
      <template v-else-if="current.method === 'confirm'">
        <p style="margin: 0 0 16px; white-space: pre-wrap">{{ current.message }}</p>
        <n-space justify="end">
          <n-button @click="store.respondUi(current, { confirmed: false })">取消</n-button>
          <n-button type="primary" @click="store.respondUi(current, { confirmed: true })">
            确认
          </n-button>
        </n-space>
      </template>

      <!-- 输入 / 编辑 -->
      <template v-else-if="current.method === 'input' || current.method === 'editor'">
        <n-input
          v-model:value="inputValue"
          :type="current.method === 'editor' ? 'textarea' : 'text'"
          :autosize="current.method === 'editor' ? { minRows: 4, maxRows: 14 } : undefined"
          :placeholder="current.placeholder ?? ''"
        />
        <n-space justify="end" style="margin-top: 16px">
          <n-button @click="cancel">取消</n-button>
          <n-button type="primary" @click="store.respondUi(current, { value: inputValue })">
            确定
          </n-button>
        </n-space>
      </template>
    </template>
  </n-modal>
</template>
