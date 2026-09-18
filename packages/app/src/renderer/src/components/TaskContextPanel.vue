<script setup lang="ts">
import { computed } from "vue";
import { NButton, NProgress } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useArtifactsStore } from "../stores/artifacts";
import { useWorkspaceStore } from "../stores/workspace";

const emit = defineEmits<{ close: []; collapse: [] }>();
const props = defineProps<{ collapsed?: boolean }>();

const app = useAppStore();
const artifacts = useArtifactsStore();
const workspace = useWorkspaceStore();

const running = computed(() => app.streaming);
const toolCount = computed(() => Object.keys(app.toolRuns).length);
const doneCount = computed(
  () => Object.values(app.toolRuns).filter((t) => t.status === "done").length
);
const percent = computed(() => {
  if (!toolCount.value) return running.value ? 12 : 0;
  return Math.round((doneCount.value / toolCount.value) * 100);
});
const recentArtifacts = computed(() => artifacts.items.slice(0, 8));
const pendingChanges = computed(() => workspace.pendingChanges.slice(0, 8));
</script>

<template>
  <aside
    class="context-panel"
    :class="{ collapsed: props.collapsed }"
    aria-label="任务上下文"
  >
    <button
      v-if="props.collapsed"
      type="button"
      class="context-rail"
      aria-label="展开任务上下文"
      @click="emit('collapse')"
    >
      <span class="rail-title">任务上下文</span>
      <span v-if="running" class="rail-dot" aria-hidden="true" />
      <span class="rail-count">{{ doneCount }}/{{ toolCount || "…" }}</span>
    </button>
    <template v-else>
    <h3>
      任务上下文
      <n-button size="tiny" quaternary style="float: right" aria-label="收起任务上下文" @click="emit('collapse')">
        收起
      </n-button>
      <n-button size="tiny" quaternary style="float: right" aria-label="关闭任务上下文" @click="emit('close')">
        关闭
      </n-button>
    </h3>
    <div class="context-section">
      <div class="sec-title">任务进度</div>
      <n-progress
        type="line"
        :percentage="percent"
        :show-indicator="true"
        :status="running ? 'info' : 'success'"
        :height="6"
      />
      <p style="margin: 8px 0 0; font-size: 12px; color: var(--text-secondary)">
        <template v-if="running">正在执行，已完成 {{ doneCount }}/{{ toolCount || "…" }} 步</template>
        <template v-else-if="toolCount">本轮完成 {{ doneCount }} 个工具调用</template>
        <template v-else>当前没有进行中的步骤</template>
      </p>
    </div>
    <div class="context-section">
      <div class="sec-title">产物 {{ artifacts.items.length || "" }}</div>
      <p v-if="!recentArtifacts.length" style="margin: 0; font-size: 12px; color: var(--text-tertiary)">
        还没有产物
      </p>
      <button
        v-for="item in recentArtifacts"
        :key="item.id"
        type="button"
        class="ctx-row"
        @click="artifacts.preview({ workspaceId: item.workspaceId, relativePath: item.exportPath, artifactId: item.id })"
      >
        <span class="name">{{ item.name }}</span>
        <span class="meta">v{{ item.version }}</span>
      </button>
      <n-button v-if="artifacts.items.length" size="tiny" quaternary @click="artifacts.panelOpen = true">
        打开产物库
      </n-button>
    </div>
    <div class="context-section">
      <div class="sec-title">更改 {{ pendingChanges.length || "" }}</div>
      <p v-if="!pendingChanges.length" style="margin: 0; font-size: 12px; color: var(--text-tertiary)">
        没有待审改动
      </p>
      <div v-for="change in pendingChanges" :key="change.id" class="ctx-row">
        <span class="name">{{ change.relativePath }}</span>
        <span class="meta">待审</span>
      </div>
    </div>
    </template>
  </aside>
</template>

<style scoped>
.context-panel.collapsed {
  width: var(--context-collapsed-width, 40px);
  border-left: var(--border-w) solid var(--border-subtle);
}
.context-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.context-rail:hover {
  color: var(--accent);
}
.rail-title {
  writing-mode: vertical-rl;
  font-size: var(--font-ui-12);
  letter-spacing: 2px;
}
.rail-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.rail-count {
  font-size: var(--font-ui-11);
  color: var(--text-tertiary);
}
.ctx-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  padding: 6px 0;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.ctx-row:hover {
  color: var(--accent);
}
.ctx-row .name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-row .meta {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-left: 8px;
  flex-shrink: 0;
}
</style>
