/**
 * 从本机 Pi CLI 会话目录把对话拷进当前工作文件夹。
 * 扫描与拷贝都在主进程，这里只展示摘要和勾选。
 */
<script setup lang="ts">
import { ref } from "vue";
import { NButton, NCheckbox, NSpace, NText } from "naive-ui";
import type { SessionImportCandidate } from "@contract";
import { useAppStore } from "../stores/app";
import { useSessionsStore } from "../stores/sessions";

const app = useAppStore();
const sessions = useSessionsStore();
const items = ref<SessionImportCandidate[]>([]);
const selected = ref<string[]>([]);
const loading = ref(false);
const notice = ref("");

function when(ms: number): string {
  if (!ms) return "时间不详";
  return new Date(ms).toLocaleString();
}

async function scan(): Promise<void> {
  notice.value = "";
  if (!app.workspaceId) {
    notice.value = "请先选择工作文件夹";
    return;
  }
  loading.value = true;
  try {
    const page = await window.piBuddy.sessions.importScan(app.workspaceId);
    items.value = page.items;
    selected.value = page.items.filter((i) => !i.alreadyHere).map((i) => i.externalId);
    notice.value = page.items.length === 0 ? "这台电脑上没发现 Pi 的旧对话。" : "";
  } catch (err) {
    notice.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function run(): Promise<void> {
  if (!app.workspaceId || selected.value.length === 0) return;
  loading.value = true;
  try {
    const result = await window.piBuddy.sessions.importRun(app.workspaceId, selected.value);
    notice.value = `已带入 ${result.imported} 段，跳过 ${result.skipped}，没办成 ${result.failed}`;
    await sessions.refresh(app.workspaceId);
    await scan();
  } catch (err) {
    notice.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <section class="import">
    <n-text depth="3" class="lead">
      以前在终端里用过 Pi？可以把那些对话带进现在这个文件夹。先扫描，再勾选要带的。
    </n-text>
    <n-space size="small" style="margin: 8px 0">
      <n-button size="small" :loading="loading" @click="scan">看看有哪些</n-button>
      <n-button
        size="small"
        type="primary"
        :disabled="selected.length === 0"
        :loading="loading"
        @click="run"
      >
        带入勾选的 {{ selected.length ? `(${selected.length})` : "" }}
      </n-button>
    </n-space>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <ul v-if="items.length" class="list">
      <li v-for="item in items" :key="item.externalId">
        <n-checkbox
          :checked="selected.includes(item.externalId)"
          :disabled="item.alreadyHere"
          @update:checked="
            (on: boolean) => {
              selected = on
                ? [...selected, item.externalId]
                : selected.filter((id) => id !== item.externalId);
            }
          "
        >
          {{ item.title }}
        </n-checkbox>
        <span class="meta">
          {{ item.messageCount }} 条 · {{ when(item.updatedAt) }}
          <template v-if="item.alreadyHere"> · 已经在这里</template>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.import {
  margin: 12px 0 16px;
  padding-top: 8px;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}
.lead {
  font-size: 12.5px;
}
.notice {
  font-size: 12.5px;
  color: #4b5563;
  margin: 4px 0;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 220px;
  overflow: auto;
}
.list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
.meta {
  font-size: 12px;
  color: #8a8f98;
  padding-left: 22px;
}
</style>
