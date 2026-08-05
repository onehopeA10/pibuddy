<script setup lang="ts">
/**
 * 模型错误的**可操作提示条**（MDL-101 的渲染层出口）。
 *
 * 与消息卡里那条 `<n-alert title="出错了">` 是两件事，故意不合并：
 *   - 消息卡展示 **provider 原文**，那是排障证据，一个字节都不改；
 *   - 这里展示 **该怎么办**，由归一化后的 kind 决定，带一个真能点的按钮。
 *
 * 合成一条的话，「原文」与「建议」会争同一块空间，而它们的读者不是同一群人：
 * 原文给的是能看懂英文报错的人，建议给的是打开桌面应用的办公用户。
 */
import { computed } from "vue";
import { NAlert, NButton } from "naive-ui";

import { useAppStore } from "../stores/app";
import { useProvidersStore } from "../stores/providers";
import { adviseModelError } from "../model-error-advice";

const store = useAppStore();
const providers = useProvidersStore();

const payload = computed(() => store.modelError);

const advice = computed(() =>
  payload.value
    ? adviseModelError(payload.value.kind, {
        ...(payload.value.retryAfterMs !== undefined
          ? { retryAfterMs: payload.value.retryAfterMs }
          : {}),
      })
    : null
);

/** 有按钮才渲染按钮：`wait` / `none` 两类下用户确实无处可点。 */
const actionLabel = computed(() => advice.value?.actionLabel ?? "");

function runAction(): void {
  const action = advice.value?.action;
  if (action === "compact") void store.compactSession();
  else if (action === "provider") providers.panelOpen = true;
  else if (action === "usage") providers.usagePanelOpen = true;
}
</script>

<template>
  <n-alert
    v-if="payload && advice"
    class="model-error-hint"
    type="warning"
    :show-icon="true"
    closable
    :title="advice.title"
    @close="store.clearModelError()"
  >
    <div class="hint-body">
      <p class="hint-text">{{ advice.hint }}</p>
      <div class="hint-actions">
        <n-button v-if="actionLabel" size="tiny" type="primary" @click="runAction">
          {{ actionLabel }}
        </n-button>
      </div>
      <details class="hint-raw">
        <summary aria-label="展开服务商原始报错">看服务商的原始报错</summary>
        <pre>{{ payload.raw }}</pre>
      </details>
    </div>
  </n-alert>
</template>

<style scoped>
.model-error-hint {
  margin: 0 12px 8px;
}
.hint-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hint-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.hint-actions {
  display: flex;
  gap: 8px;
}
.hint-raw summary {
  cursor: pointer;
  font-size: 12px;
  color: #6b7280;
}
.hint-raw pre {
  margin: 6px 0 0;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  line-height: 1.5;
}
</style>
