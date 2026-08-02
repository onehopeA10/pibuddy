<script setup lang="ts">
import { computed } from "vue";
import { NButton, NSelect, NTooltip } from "naive-ui";
import type { SelectOption, SelectGroupOption } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useExtensionUiStore } from "../stores/extensionUi";
import { usePiResourcesStore } from "../stores/piResources";
import type { ThinkingLevel } from "@sdk";

const store = useAppStore();
/**
 * 扩展上报的窗口标题（rpc.md:1300 setTitle）。
 *
 * 前缀与 60 字符截断在 store 的 displayTitle 里做，不在模板里做：
 * 模板里做意味着「改了模板、测试还绿」。扩展可以上报任意长度的标题，
 * 不截断会静默撑破顶栏布局 —— 不报错，只是模型选择框被挤出可视区。
 */
const extUi = useExtensionUiStore();
const piRes = usePiResourcesStore();

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

    <span v-if="extUi.displayTitle" class="ext-title" :title="extUi.displayTitle">
      {{ extUi.displayTitle }}
    </span>

    <div class="spacer" />

    <n-tooltip>
      <template #trigger>
        <n-button quaternary size="small" aria-label="Pi 资源" @click="piRes.panelOpen = true">
          🧩 资源
        </n-button>
      </template>
      查看和管理 Pi 的技能、扩展与包
    </n-tooltip>

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

<style scoped>
.ext-title {
  margin-left: 12px;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.72;
}
</style>
