<script setup lang="ts">
import { NButton } from "naive-ui";
import { useAppStore } from "../stores/app";
import SessionListPanel from "./SessionListPanel.vue";
import { formatCost, formatTokenCount } from "../friendly";

const store = useAppStore();
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">π</div>
      <div>
        PiBuddy
        <small>AI 办公小助手</small>
      </div>
    </div>

    <div class="new-task">
      <n-button type="primary" block :disabled="!store.started" @click="store.newTask()">
        ＋ 开始新任务
      </n-button>
    </div>

    <!-- 列表、搜索、整理动作全在 SessionListPanel 里；侧边栏只负责布局 -->
    <SessionListPanel />

    <div class="footer">
      <span v-if="store.stats">
        本次花费
        <template v-if="store.stats.cost === 0 && store.stats.tokens.total > 0">
          免费 · {{ formatTokenCount(store.stats.tokens.total) }}
        </template>
        <template v-else>{{ formatCost(store.stats.cost) }}</template>
      </span>
      <span v-else></span>
      <n-button quaternary size="small" @click="store.settingsOpen = true">⚙️ 设置</n-button>
    </div>
  </aside>
</template>
