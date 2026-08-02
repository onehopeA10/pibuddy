<script setup lang="ts">
/**
 * 会话中心面板（SES-101）。
 *
 * 三段式：搜索框 → 状态分页（进行中 / 已归档 / 回收站）→ 列表。
 * 列表项只持有不透明的 `sessionId`，一个路径字符串都不出现。
 *
 * 「解析失败的会话照样列出来」这条口径继续保留：让用户看见「有这么一个
 * 会话但读不出来」，比悄悄藏起来强 —— 这里的体现是 preview 为空时显示
 * 「（还没有消息）」而不是把整条过滤掉。
 */
import { computed, onMounted, ref } from "vue";
import { NButton, NDropdown, NInput, NSpin, useDialog, useMessage } from "naive-ui";
import type { SessionRow, SessionStatus } from "@contract";
import { useAppStore } from "../stores/app";
import { useSessionsStore } from "../stores/sessions";
import { formatTime } from "../friendly";

const app = useAppStore();
const store = useSessionsStore();
const message = useMessage();
const dialog = useDialog();

const TABS: { key: SessionStatus; label: string }[] = [
  { key: "active", label: "进行中" },
  { key: "archived", label: "已归档" },
  { key: "trashed", label: "回收站" },
];

const renaming = ref("");
const renameText = ref("");

const activeStatus = computed(() => store.filters.status);
const searchText = computed({
  get: () => store.filters.search,
  set: (v: string) => store.setSearch(v),
});

/** 当前打开的会话；用于列表高亮。 */
const currentSessionId = computed(() => app.currentSessionId);

onMounted(() => {
  if (app.workspaceId) void store.refresh(app.workspaceId);
});

function menuFor(row: SessionRow): { label: string; key: string }[] {
  if (row.status === "trashed") {
    return [
      { label: "恢复到「进行中」", key: "restore" },
      { label: "彻底删除（移入系统回收站）", key: "purge" },
    ];
  }
  return [
    { label: "重命名", key: "rename" },
    { label: row.pinned ? "取消置顶" : "置顶", key: "pin" },
    { label: row.status === "archived" ? "取消归档" : "归档", key: "archive" },
    { label: "导出为网页", key: "export" },
    { label: "移到回收站", key: "trash" },
  ];
}

async function onMenu(key: string, row: SessionRow): Promise<void> {
  try {
    switch (key) {
      case "rename":
        renaming.value = row.sessionId;
        renameText.value = row.name ?? "";
        break;
      case "pin":
        await store.setPinned(row.sessionId, !row.pinned);
        break;
      case "archive":
        await store.moveTo(row.sessionId, row.status === "archived" ? "active" : "archived");
        break;
      case "trash":
        // 只改状态，不删文件 —— 文案必须如实说明这一点。
        await store.moveTo(row.sessionId, "trashed");
        message.success("已移到回收站，随时可以恢复");
        break;
      case "restore":
        await store.moveTo(row.sessionId, "active");
        break;
      case "export": {
        const at = await store.exportHtml(row.sessionId);
        message.success(at ? `已导出到 ${at}` : "已导出");
        break;
      }
      case "purge":
        confirmPurge(row);
        break;
      default:
        break;
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : "操作失败");
  }
}

/**
 * 彻底删除必须先说清楚删的是**哪一个**。
 * 早先这类确认框只说「确定删除吗」，用户根本不知道点下去会失去什么。
 */
function confirmPurge(row: SessionRow): void {
  dialog.warning({
    title: "彻底删除这个任务？",
    content: `「${row.name || row.preview || "未命名任务"}」共 ${row.messageCount} 条消息。会话文件会被移入系统回收站，之后还可以从那里找回。`,
    positiveText: "彻底删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      try {
        await store.purge(row.sessionId);
        message.success("已移入系统回收站");
      } catch (err) {
        message.error(err instanceof Error ? err.message : "删除失败");
      }
    },
  });
}

async function commitRename(row: SessionRow): Promise<void> {
  const name = renameText.value.trim();
  renaming.value = "";
  if (!name || name === row.name) return;
  try {
    await store.rename(row.sessionId, name);
  } catch (err) {
    message.error(err instanceof Error ? err.message : "重命名失败");
  }
}
</script>

<template>
  <div class="session-panel">
    <div class="session-search">
      <n-input v-model:value="searchText" clearable size="small" placeholder="搜索历史任务…" />
    </div>

    <div class="session-tabs">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        class="session-tab"
        :class="{ active: activeStatus === tab.key }"
        @click="store.setStatus(tab.key)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="session-list">
      <div v-if="store.loading && store.rows.length === 0" class="session-empty">
        <n-spin size="small" />
      </div>

      <!-- 查询失败与「没有会话」必须区分开：否则用户会以为历史全丢了 -->
      <div v-else-if="store.error" class="session-empty session-error">
        {{ store.error }}
        <n-button size="tiny" quaternary @click="store.refresh()">重试</n-button>
      </div>

      <template v-else>
        <div
          v-for="s in store.rows"
          :key="s.sessionId"
          class="session-item"
          :class="{ active: currentSessionId === s.sessionId }"
          @click="app.openSession({ sessionId: s.sessionId })"
        >
          <div class="title">
            <span v-if="s.pinned" class="pin" title="已置顶">📌</span>
            <n-input
              v-if="renaming === s.sessionId"
              v-model:value="renameText"
              size="tiny"
              autofocus
              @keyup.enter="commitRename(s)"
              @blur="commitRename(s)"
              @click.stop
            />
            <template v-else>{{ s.name || "（未命名任务）" }}</template>
            <span v-if="s.unread" class="dot" title="有新消息"></span>
            <span v-if="s.running" class="dot running" title="正在后台运行"></span>
          </div>
          <div class="preview">{{ s.preview || "（还没有消息）" }}</div>
          <div class="meta">
            {{ formatTime(s.modified) }} · {{ s.messageCount }} 条消息
            <n-dropdown
              trigger="click"
              :options="menuFor(s)"
              @select="(k: string) => onMenu(k, s)"
            >
              <span class="more" title="更多操作" @click.stop>⋯</span>
            </n-dropdown>
          </div>
        </div>

        <div v-if="store.rows.length === 0" class="session-empty">
          {{ store.filters.search ? "没有匹配的任务" : "还没有历史任务" }}
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.session-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.session-search {
  padding: 0 12px 8px;
}
.session-tabs {
  display: flex;
  gap: 4px;
  padding: 0 12px 8px;
}
.session-tab {
  flex: 1;
  border: none;
  background: transparent;
  color: #8b8f98;
  font-size: 12px;
  padding: 4px 0;
  border-radius: 6px;
  cursor: pointer;
}
.session-tab.active {
  background: rgba(99, 102, 241, 0.12);
  color: #6366f1;
}
.session-empty {
  text-align: center;
  color: #b0b4bc;
  font-size: 12px;
  padding: 24px 0;
}
.session-error {
  color: #d03050;
}
.session-item .title {
  display: flex;
  align-items: center;
  gap: 4px;
}
.session-item .more {
  float: right;
  padding: 0 4px;
  cursor: pointer;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6366f1;
  display: inline-block;
}
.dot.running {
  background: #18a058;
}
</style>
