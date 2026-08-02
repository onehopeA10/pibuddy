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
        <!-- 名称 / 首条消息 / 消息数 / 修改时间四项各占其位：早先名称与首条
             消息挤在同一行做 `||` 回退，有名字的会话就再也看不到内容预览了。 -->
        <div class="title">{{ s.name || "（未命名任务）" }}</div>
        <div class="preview">{{ s.firstMessage || "（还没有消息）" }}</div>
        <div class="meta">
          {{ formatTime(s.modified) }} · {{ s.messageCount }} 条消息
          <!-- 解析失败的会话照样列出来：让用户知道它存在，比悄悄藏起来强 -->
          <span v-if="s.parseError" class="parse-error" :title="s.parseError">· 解析失败</span>
        </div>
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
