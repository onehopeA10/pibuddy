<script setup lang="ts">
import { NButton } from "naive-ui";
import { useAppStore } from "../stores/app";
import { formatTime, formatCost } from "../friendly";

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

    <div class="session-list">
      <div
        v-for="s in store.sessions"
        :key="s.path"
        class="session-item"
        :class="{ active: store.agentState?.sessionFile === s.path }"
        @click="store.openSession(s)"
      >
        <div class="title">{{ s.name || s.firstMessage || "（空白会话）" }}</div>
        <div class="meta">{{ formatTime(s.modified) }} · {{ s.messageCount }} 条消息</div>
      </div>
      <div
        v-if="store.sessions.length === 0"
        style="text-align: center; color: #b0b4bc; font-size: 12px; padding: 24px 0"
      >
        还没有历史任务
      </div>
    </div>

    <div class="footer">
      <span v-if="store.stats">本次花费 {{ formatCost(store.stats.cost) }}</span>
      <span v-else></span>
      <n-button quaternary size="small" @click="store.settingsOpen = true">⚙️ 设置</n-button>
    </div>
  </aside>
</template>
