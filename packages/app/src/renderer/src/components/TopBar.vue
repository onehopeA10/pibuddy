<script setup lang="ts">
import { computed } from "vue";
import { NButton, NSelect, NTooltip } from "naive-ui";
import type { SelectOption, SelectGroupOption } from "naive-ui";
import { useAppStore } from "../stores/app";
import type { ThinkingLevel } from "@sdk";

const store = useAppStore();

const folderName = computed(() => {
  const ws = store.workspace;
  return ws.split(/[\\/]/).filter(Boolean).pop() ?? ws;
});

const modelValue = computed(() =>
  store.currentModel ? `${store.currentModel.provider}::${store.currentModel.id}` : null
);

const modelOptions = computed<(SelectOption | SelectGroupOption)[]>(() => {
  const byProvider = new Map<string, SelectOption[]>();
  for (const m of store.models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push({ label: m.name || m.id, value: `${m.provider}::${m.id}` });
    byProvider.set(m.provider, list);
  }
  return [...byProvider.entries()].map(([provider, children]) => ({
    type: "group",
    label: provider,
    key: provider,
    children,
  }));
});

function onModelChange(value: string): void {
  const [provider, ...rest] = value.split("::");
  void store.setModel(provider, rest.join("::"));
}

const THINKING_LABELS: Record<string, string> = {
  off: "思考：关",
  minimal: "思考：极少",
  low: "思考：少",
  medium: "思考：中",
  high: "思考：多",
  xhigh: "思考：超多",
  max: "思考：最强",
};

const thinkingOptions = computed<SelectOption[]>(() =>
  store.thinkingLevels.map((l) => ({ label: THINKING_LABELS[l] ?? l, value: l }))
);

const contextPercent = computed(() => store.stats?.contextUsage?.percent ?? null);
</script>

<template>
  <header class="topbar">
    <n-tooltip>
      <template #trigger>
        <n-button quaternary size="small" @click="store.chooseWorkspace()">
          📁 {{ folderName }}
        </n-button>
      </template>
      工作文件夹：{{ store.workspace }}（点击更换）
    </n-tooltip>

    <div class="spacer" />

    <span v-if="store.extStatus" class="usage ext-status">{{ store.extStatus }}</span>

    <span v-if="contextPercent !== null" class="usage">
      记忆已用 {{ Math.round(contextPercent) }}%
    </span>

    <n-select
      v-if="store.thinkingLevels.length > 1"
      :value="store.agentState?.thinkingLevel ?? 'off'"
      :options="thinkingOptions"
      size="small"
      style="width: 128px"
      :consistent-menu-width="false"
      @update:value="(v: string) => store.setThinkingLevel(v as ThinkingLevel)"
    />

    <n-select
      :value="modelValue"
      :options="modelOptions"
      size="small"
      filterable
      placeholder="选择模型"
      style="width: 240px"
      :consistent-menu-width="false"
      @update:value="onModelChange"
    />
  </header>
</template>
