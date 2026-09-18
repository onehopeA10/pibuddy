<script setup lang="ts">
import { NButton } from "naive-ui";
import { useAppStore } from "../stores/app";
import SessionListPanel from "./SessionListPanel.vue";
import FileTreePanel from "./FileTreePanel.vue";
import { formatCost, formatTokenCount } from "../friendly";

defineProps<{
  filesEnabled?: boolean;
  pane?: "sessions" | "files";
}>();
const emit = defineEmits<{
  "update:pane": [value: "sessions" | "files"];
}>();

const store = useAppStore();
</script>

<template>
  <aside class="sidebar">
    <div v-if="filesEnabled" class="sidebar-tabs">
      <button
        type="button"
        class="sidebar-tab"
        :class="{ on: pane !== 'files' }"
        @click="emit('update:pane', 'sessions')"
      >
        会话
      </button>
      <button
        type="button"
        class="sidebar-tab"
        :class="{ on: pane === 'files' }"
        @click="emit('update:pane', 'files')"
      >
        文件
      </button>
    </div>
    <div class="new-task">
      <n-button
        type="primary"
        block
        :disabled="!store.workspaceId"
        :loading="store.creatingTask"
        @click="store.newTask()"
      >
        新建任务
      </n-button>
    </div>

    <FileTreePanel v-if="filesEnabled && pane === 'files'" />
    <SessionListPanel v-else />

    <div class="footer">
      <span v-if="store.stats">
        本次花费
        <template v-if="store.stats.cost === 0 && store.stats.tokens.total > 0">
          免费 · {{ formatTokenCount(store.stats.tokens.total) }}
        </template>
        <template v-else>{{ formatCost(store.stats.cost) }}</template>
      </span>
      <span v-else></span>
      <span />
    </div>
  </aside>
</template>
