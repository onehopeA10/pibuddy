<script setup lang="ts">
import { computed } from "vue";
import { NSelect, NTag, NTooltip } from "naive-ui";
import type { SelectGroupOption, SelectOption } from "naive-ui";
import type { ThinkingLevel } from "@sdk";
import { useAppStore } from "../stores/app";

const store = useAppStore();

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

/** 输入模态标签：与账号页同一套词（文 / 图 / 图文）。 */
function modalityLabel(input: string[] | undefined): string {
  const list = input ?? ["text"];
  const text = list.includes("text");
  const image = list.includes("image");
  if (text && image) return "图文";
  if (image) return "图";
  return "文";
}

const modelCaps = computed(() => {
  const m = store.currentModel;
  if (!m) return null;
  return {
    image: (m.input ?? []).includes("image"),
    modality: modalityLabel(m.input),
    reasoning: m.reasoning === true,
    contextK: m.contextWindow ? Math.round(m.contextWindow / 1000) : 0,
    costIn: m.cost?.input ?? 0,
  };
});
</script>

<template>
  <div class="model-controls">
    <n-tooltip v-if="modelCaps">
      <template #trigger>
        <span class="model-caps" data-testid="model-caps">
          <n-tag size="tiny" :bordered="false" :type="modelCaps.image ? 'success' : 'default'">
            {{ modelCaps.modality }}
          </n-tag>
        </span>
      </template>
      {{
        modelCaps.image
          ? "这个模型接受文字和图片"
          : "这个模型只接受文字，发图前需要切换模型"
      }}
      <template v-if="modelCaps.reasoning"> · 支持深度思考</template>
      <template v-if="modelCaps.contextK"> · {{ modelCaps.contextK }}K</template>
      <template v-if="modelCaps.costIn"> · 输入 ${{ modelCaps.costIn }}/M tokens</template>
    </n-tooltip>

    <n-select
      v-if="store.thinkingLevels.length > 1"
      :value="store.agentState?.thinkingLevel ?? 'off'"
      :options="thinkingOptions"
      size="tiny"
      class="thinking-select"
      :consistent-menu-width="false"
      @update:value="(v: string) => store.setThinkingLevel(v as ThinkingLevel)"
    />

    <n-select
      :value="modelValue"
      :options="modelOptions"
      size="tiny"
      filterable
      placeholder="选择模型"
      class="model-select"
      :consistent-menu-width="false"
      @update:value="onModelChange"
    />
  </div>
</template>

<style scoped>
.model-controls {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.model-caps {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
}
.thinking-select {
  width: 118px;
}
.model-select {
  width: 200px;
}
</style>
