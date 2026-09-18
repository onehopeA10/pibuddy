<script setup lang="ts">
import { computed } from "vue";
import { NButton, NDropdown, NTooltip } from "naive-ui";
import type { DropdownOption } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useExtensionUiStore } from "../stores/extensionUi";
import StatusCenter from "./StatusCenter.vue";

const props = defineProps<{
  showSessionToggle?: boolean;
  sessionOpen?: boolean;
  contextOpen?: boolean;
  tools?: { key: string; label: string; enabled: boolean; active: boolean }[];
}>();
const emit = defineEmits<{
  "toggle-sessions": [];
  "toggle-context": [];
  tool: [key: string];
}>();

const store = useAppStore();
const extUi = useExtensionUiStore();

const folderName = computed(() => {
  const ws = store.workspace;
  return ws.split(/[\\/]/).filter(Boolean).pop() ?? ws;
});

const contextPercent = computed(() => store.stats?.contextUsage?.percent ?? null);

const toolOptions = computed<DropdownOption[]>(() =>
  (props.tools ?? [])
    .filter((t) => t.enabled)
    .map((t) => ({
      key: t.key,
      label: t.active ? `${t.label}（已开）` : t.label,
    }))
);

const hasTools = computed(() => toolOptions.value.length > 0);
</script>

<template>
  <header class="topbar">
    <n-button
      v-if="showSessionToggle"
      quaternary
      size="small"
      :aria-label="sessionOpen ? '收起会话列表' : '打开会话列表'"
      @click="emit('toggle-sessions')"
    >
      会话
    </n-button>
    <n-tooltip>
      <template #trigger>
        <n-button quaternary size="small" @click="store.chooseWorkspace()">
          {{ folderName }}
        </n-button>
      </template>
      工作文件夹：{{ store.workspace }}（点击更换）
    </n-tooltip>

    <span v-if="extUi.displayTitle" class="ext-title" :title="extUi.displayTitle">
      {{ extUi.displayTitle }}
    </span>

    <div class="spacer" />

    <n-dropdown
      v-if="hasTools"
      trigger="click"
      :options="toolOptions"
      @select="(key: string) => emit('tool', key)"
    >
      <n-button quaternary size="small">工具</n-button>
    </n-dropdown>

    <n-button
      quaternary
      size="small"
      :aria-pressed="contextOpen ? 'true' : 'false'"
      aria-label="任务上下文"
      @click="emit('toggle-context')"
    >
      任务上下文
    </n-button>

    <StatusCenter />

    <span v-if="store.extStatus" class="usage ext-status">{{ store.extStatus }}</span>

    <span v-if="contextPercent !== null" class="usage">
      记忆已用 {{ Math.round(contextPercent) }}%
    </span>
  </header>
</template>

<style scoped>
.ext-title {
  margin-left: 12px;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-ui-12);
  opacity: 0.72;
}
</style>
