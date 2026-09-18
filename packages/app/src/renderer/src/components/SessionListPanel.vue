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
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NButton, NDropdown, NInput, NSpin, useDialog, useMessage } from "naive-ui";
import type { SessionRow, SessionStatus, WorkspaceListItem } from "@contract";
import { useAppStore } from "../stores/app";
import { useProjectsStore } from "../stores/projects";
import { sessionDisplayName, useSessionsStore } from "../stores/sessions";
import { formatTime } from "../friendly";

const app = useAppStore();
const store = useSessionsStore();
const projects = useProjectsStore();
const message = useMessage();
const dialog = useDialog();

const TABS: { key: SessionStatus; label: string }[] = [
  { key: "active", label: "进行中" },
  { key: "archived", label: "已归档" },
  { key: "trashed", label: "回收站" },
];

const renaming = ref("");
const renameText = ref("");

function sessionRunning(s: SessionRow): boolean {
  return s.running || Boolean(app.runtimeScope[s.sessionId]?.streaming);
}

const activeStatus = computed(() => store.filters.status);
const searchText = computed({
  get: () => store.filters.search,
  set: (v: string) => store.setSearch(v),
});

/** 当前打开的会话；用于列表高亮。 */
const currentSessionId = computed(() => app.currentSessionId);

/**
 * 项目维度（Codex 式两级侧栏）：项目 → 会话。
 *
 * 当前项目排第一且默认展开，它的会话行来自 sessions store（带整理菜单）；
 * 其它项目折叠，点开才惰性拉取，行只能「打开」—— 打开即切换工作目录并
 * 直接进入那个会话。
 */
const currentOpen = ref(true);

const orderedProjects = computed<WorkspaceListItem[]>(() => {
  const list = projects.items;
  const cur = list.find((p) => p.workspaceId === app.workspaceId);
  const rest = list.filter((p) => p.workspaceId !== app.workspaceId);
  return cur ? [cur, ...rest] : rest;
});

const projectFilter = computed(() => ({
  status: store.filters.status,
  search: store.filters.search,
}));

function isCurrent(p: WorkspaceListItem): boolean {
  return p.workspaceId === app.workspaceId;
}

function toggleProject(p: WorkspaceListItem): void {
  if (isCurrent(p)) currentOpen.value = !currentOpen.value;
  else projects.toggle(p.workspaceId, projectFilter.value);
}

function openInProject(p: WorkspaceListItem, row: SessionRow): void {
  void app.switchWorkspace(p.workspaceId, row.sessionId);
}

async function newTaskIn(p: WorkspaceListItem): Promise<void> {
  if (isCurrent(p)) {
    await app.newTask();
    return;
  }
  if (await app.switchWorkspace(p.workspaceId)) await app.newTask();
}

onMounted(() => {
  void projects.refresh();
  if (app.workspaceId) void store.refresh(app.workspaceId);
});

// 换了工作目录：项目列表重排（lastOpenedAt 变了）、当前会话列表重查。
watch(
  () => app.workspaceId,
  (id) => {
    void projects.refresh();
    if (id) void store.refresh(id);
  }
);

// 状态页 / 搜索词变化：已展开的其它项目跟着重查。搜索是逐字触发的，这里
// 同样尾沿防抖，别每敲一个字就对每个展开的项目查一次库。
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
watch(projectFilter, (f) => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void projects.reloadExpanded(app.workspaceId, f);
  }, 220);
});
onBeforeUnmount(() => {
  if (reloadTimer) clearTimeout(reloadTimer);
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
    content: `「${sessionDisplayName(row)}」共 ${row.messageCount} 条消息。会话文件会被移入系统回收站，之后还可以从那里找回。`,
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
      <template v-for="p in orderedProjects" :key="p.workspaceId">
        <!-- 项目头：目录名 + 完整路径悬停提示；点击展开 / 折叠 -->
        <div
          class="project-row"
          :class="{ current: isCurrent(p), open: isCurrent(p) ? currentOpen : projects.isExpanded(p.workspaceId) }"
          :title="p.displayPath"
          role="button"
          tabindex="0"
          @click="toggleProject(p)"
          @keydown.enter.prevent="toggleProject(p)"
        >
          <svg class="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 7.5 6 4 9.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="project-name">{{ p.name }}</span>
          <span v-if="isCurrent(p)" class="project-badge">当前</span>
          <button
            type="button"
            class="project-add"
            :title="`在「${p.name}」新建任务`"
            :aria-label="`在 ${p.name} 新建任务`"
            :disabled="app.creatingTask"
            @click.stop="newTaskIn(p)"
          >
            ＋
          </button>
        </div>

        <!-- 当前项目：完整的会话列表（带整理菜单） -->
        <template v-if="isCurrent(p) && currentOpen">
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
          class="session-item nested"
          :class="{
            active: currentSessionId === s.sessionId,
            opening: app.switchingSessionId === s.sessionId,
            waiting: app.switchingSessionId !== null && app.switchingSessionId !== s.sessionId,
          }"
          @click="app.openSession({ sessionId: s.sessionId, sizeBytes: s.sizeBytes })"
        >
          <div class="title">
            <!--
              pi 读整个 JSONL 重建上下文要好几秒（由文件大小决定，不是消息数）。
              这段等待消不掉，但不能让它表现为「点了没反应」—— 那样用户只会
              反复点，把等待叠加成好几倍。
            -->
            <n-spin v-if="app.switchingSessionId === s.sessionId" :size="12" />
            <span v-if="s.pinned" class="pin" title="已置顶">置顶</span>
            <n-input
              v-if="renaming === s.sessionId"
              v-model:value="renameText"
              size="tiny"
              autofocus
              @keyup.enter="commitRename(s)"
              @blur="commitRename(s)"
              @click.stop
            />
            <template v-else>{{ sessionDisplayName(s) }}</template>
            <span v-if="s.unread" class="dot" title="有新消息"></span>
            <span v-if="sessionRunning(s)" class="dot running" title="正在运行"></span>
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
        </template>

        <!-- 其它项目：惰性拉取的只读行，点开 = 切换目录 + 进入该会话 -->
        <template v-else-if="!isCurrent(p) && projects.isExpanded(p.workspaceId)">
          <div v-if="projects.rowsFor(p.workspaceId).loading" class="session-empty">
            <n-spin size="small" />
          </div>
          <div v-else-if="projects.rowsFor(p.workspaceId).error" class="session-empty session-error">
            {{ projects.rowsFor(p.workspaceId).error }}
          </div>
          <template v-else>
            <div
              v-for="s in projects.rowsFor(p.workspaceId).rows"
              :key="s.sessionId"
              class="session-item nested"
              :class="{ waiting: app.switchingSessionId !== null }"
              @click="openInProject(p, s)"
            >
              <div class="title">
                <span v-if="s.pinned" class="pin" title="已置顶">置顶</span>
                {{ sessionDisplayName(s) }}
                <span v-if="sessionRunning(s)" class="dot running" title="正在运行"></span>
              </div>
              <div class="preview">{{ s.preview || "（还没有消息）" }}</div>
              <div class="meta">{{ formatTime(s.modified) }} · {{ s.messageCount }} 条消息</div>
            </div>
            <div v-if="projects.rowsFor(p.workspaceId).rows.length === 0" class="session-empty compact">
              {{ store.filters.search ? "没有匹配的任务" : "还没有历史任务" }}
            </div>
          </template>
        </template>
      </template>

      <div v-if="projects.error" class="session-empty session-error">{{ projects.error }}</div>

      <!-- 添加项目 = 系统目录选择框；选完即注册并切过去（与 Codex 同一行为） -->
      <button type="button" class="project-add-row" @click="app.chooseWorkspace()">
        ＋ 添加项目
      </button>
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
/* ---- 项目头（两级侧栏的第一级） ---- */
.project-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 8px;
  padding: 5px 6px;
  border-radius: var(--radius-m);
  color: var(--text-secondary);
  font-size: var(--font-ui-12);
  cursor: pointer;
  user-select: none;
}
.project-row:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.project-row.current {
  color: var(--text-primary);
}
.project-row .chev {
  flex-shrink: 0;
  transition: transform var(--dur-fast) var(--ease);
  color: var(--text-tertiary);
}
.project-row.open .chev {
  transform: rotate(90deg);
}
.project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.project-badge {
  flex-shrink: 0;
  font-size: var(--font-ui-11);
  color: var(--accent);
  background: var(--accent-subtle);
  border-radius: var(--radius-s);
  padding: 0 5px;
  line-height: 16px;
}
.project-add {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--font-ui-13);
  line-height: 20px;
  cursor: pointer;
  opacity: 0;
}
.project-row:hover .project-add,
.project-row:focus-within .project-add {
  opacity: 1;
}
.project-add:hover {
  background: var(--bg-selected);
  color: var(--text-primary);
}
.project-add:disabled {
  cursor: default;
  opacity: 0.3;
}
.project-add-row {
  display: block;
  width: calc(100% - 16px);
  margin: 6px 8px 8px;
  padding: 6px 8px;
  border: var(--border-w) dashed var(--border-subtle);
  border-radius: var(--radius-m);
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--font-ui-12);
  text-align: left;
  cursor: pointer;
}
.project-add-row:hover {
  color: var(--text-secondary);
  border-color: var(--border-strong);
  background: var(--bg-hover);
}
/* 第二级：会话行整体右缩，与项目头形成层级 */
.session-item.nested {
  margin-left: 14px;
}
.session-empty.compact {
  padding: 10px 0;
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
  color: var(--text-secondary);
  font-size: var(--font-ui-12);
  padding: 5px 0;
  border-radius: 999px;
  cursor: pointer;
}
.session-tab.active {
  background: var(--accent-subtle);
  color: var(--accent);
}
.session-empty {
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--font-ui-12);
  padding: 24px 0;
}
.session-error {
  color: var(--status-error);
}
.session-item .title {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pin {
  font-size: var(--font-ui-11);
  color: var(--accent);
  flex-shrink: 0;
}
/*
 * 切换中的两种状态。
 *
 * pi 重建上下文要好几秒，这段时间界面必须表态：正在开的那条高亮 + 转圈，
 * 其余变灰且不接受点击 —— 否则用户在空窗期连点，会排起好几个各自数秒的
 * 切换，最终停在哪个会话取决于返回顺序。
 */
.session-item.opening {
  background: var(--accent-subtle);
}
.session-item.waiting {
  opacity: 0.45;
  pointer-events: none;
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
  background: var(--accent);
  display: inline-block;
}
.dot.running {
  background: var(--status-success);
}
</style>
