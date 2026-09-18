<script setup lang="ts">
import { computed, ref } from "vue";
import { NSelect, NTooltip } from "naive-ui";
import type { SelectOption } from "naive-ui";
import type { ApprovalMode } from "@contract";
import { useAppStore } from "../stores/app";
import { APPROVAL_MODE_OPTIONS, approvalModeDescription } from "../approval-mode";

/**
 * 输入框操作行里的审批模式下拉。
 *
 * 只在权限扩展在场时渲染（store.approvalControlAvailable）；显示值永远取自
 * 扩展上报的状态，切换只是发一次请求，成功后等状态回来再变 —— 这里没有一份
 * 会与真相漂移的本地副本。
 */
const store = useAppStore();
const busy = ref(false);

const options = computed<SelectOption[]>(() =>
  APPROVAL_MODE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))
);

const value = computed(() => store.approvalMode ?? null);
const hint = computed(() => approvalModeDescription(store.approvalMode));

async function onChange(mode: ApprovalMode): Promise<void> {
  if (busy.value || mode === store.approvalMode) return;
  busy.value = true;
  try {
    await store.setApprovalMode(mode);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <n-tooltip v-if="store.approvalControlAvailable" placement="top" :delay="400">
    <template #trigger>
      <n-select
        :value="value"
        :options="options"
        :loading="busy"
        :disabled="busy || !store.started"
        size="tiny"
        class="approval-select"
        placeholder="权限"
        :consistent-menu-width="false"
        data-testid="approval-mode-select"
        aria-label="审批模式"
        @update:value="(v: ApprovalMode) => onChange(v)"
      />
    </template>
    {{ hint }}
  </n-tooltip>
</template>

<style scoped>
.approval-select {
  width: 128px;
}
</style>
