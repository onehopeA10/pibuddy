<script setup lang="ts">
/**
 * 可视化工作流面板（common.workflow）。
 *
 * 左侧一列定义列表 + 新建 / 导入；主区是画布（WorkflowCanvas）+ 一行操作
 * （保存 / 运行 / 停止 / 导出 / 删除）+ 运行态。挂载点是 AppShell 的 main slot
 * （能力门控 common.workflow），与 GitPanel / ChildAgentPanel 等并列。
 *
 * 面板只表达编排意图，真正跑 DAG / 触发 Agent 节点的 pi run 都在主进程。
 */
import { computed, ref, watch } from "vue";
import {
  NButton,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NTag,
  NEmpty,
  useMessage,
} from "naive-ui";
import type {
  WorkflowDefinition,
  WorkflowRunNodeStateKind,
  WorkflowRunStateKind,
} from "@contract";
import { WORKFLOW_DEFINITION_SCHEMA_VERSION } from "@contract";
import { useAppStore } from "../stores/app";
import { useWorkflowStore } from "../stores/workflow";
import WorkflowCanvas from "./WorkflowCanvas.vue";

const app = useAppStore();
const store = useWorkflowStore();
const message = useMessage();

const canvasRef = ref<InstanceType<typeof WorkflowCanvas> | null>(null);
const name = ref("");

watch(
  () => app.workspaceId,
  (id) => {
    if (id) void store.init(id);
  },
  { immediate: true }
);

watch(
  () => store.selected,
  (def) => {
    name.value = def?.name ?? "";
  },
  { immediate: true }
);

const definitionOptions = computed(() =>
  store.definitions.map((d) => ({ label: d.name, value: d.id }))
);

const RUN_TAG: Record<WorkflowRunStateKind, "info" | "success" | "error" | "warning"> = {
  running: "info",
  succeeded: "success",
  failed: "error",
  stopped: "warning",
};
const RUN_LABEL: Record<WorkflowRunStateKind, string> = {
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** 当前选中定义的运行态：nodeId → 状态（着色画布用）。 */
const runStates = computed<Record<string, WorkflowRunNodeStateKind>>(() => {
  const run = store.selectedRun;
  if (!run) return {};
  const map: Record<string, WorkflowRunNodeStateKind> = {};
  for (const n of run.nodes) map[n.nodeId] = n.state;
  return map;
});

const runningRun = computed(() =>
  store.selectedRun && store.selectedRun.state === "running" ? store.selectedRun : null
);

function newDefinition(): void {
  const now = Date.now();
  const id = `wf-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const def: WorkflowDefinition = {
    id,
    name: "新工作流",
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    nodes: [{ kind: "start", id: "start", title: "", position: { x: 40, y: 40 } }],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
  void store.save(def);
}

async function saveCurrent(): Promise<void> {
  const def = canvasRef.value?.toDefinition();
  if (!def) return;
  await store.save({ ...def, name: name.value || def.name });
  message.success("已保存");
}

async function runCurrent(): Promise<void> {
  if (!store.selectedId) return;
  await saveCurrent();
  await store.run(store.selectedId);
}

async function stopCurrent(): Promise<void> {
  const run = runningRun.value;
  if (run) await store.stop(run.id);
}

async function deleteCurrent(): Promise<void> {
  if (store.selectedId) await store.remove(store.selectedId);
}

// -------- 导入 / 导出 --------
const showExport = ref(false);
const exportText = ref("");
const showImport = ref(false);
const importText = ref("");

async function openExport(): Promise<void> {
  if (!store.selectedId) return;
  exportText.value = await store.exportJson(store.selectedId);
  showExport.value = true;
}

async function copyExport(): Promise<void> {
  try {
    await navigator.clipboard.writeText(exportText.value);
    message.success("已复制到剪贴板");
  } catch {
    message.warning("复制失败，请手动选择文本");
  }
}

async function doImport(): Promise<void> {
  if (!importText.value.trim()) return;
  await store.importJson(importText.value);
  if (store.lastError) message.error(store.lastError);
  else {
    message.success("已导入");
    showImport.value = false;
    importText.value = "";
  }
}
</script>

<template>
  <div class="workflow-panel">
    <div class="wf-header">
      <NSpace align="center" size="small" :wrap="true">
        <NSelect
          size="small"
          style="min-width: 180px"
          placeholder="选择工作流"
          :options="definitionOptions"
          :value="store.selectedId"
          @update:value="store.select"
        />
        <NButton size="small" @click="newDefinition">＋新建</NButton>
        <NButton size="small" @click="showImport = true">导入</NButton>
      </NSpace>
    </div>

    <template v-if="store.selected">
      <div class="wf-toolbar">
        <NInput
          size="small"
          style="max-width: 200px"
          placeholder="工作流名称"
          :value="name"
          @update:value="(v: string) => (name = v)"
        />
        <NSpace size="small">
          <NButton size="small" type="primary" @click="saveCurrent">保存</NButton>
          <NButton size="small" type="success" :disabled="!!runningRun" @click="runCurrent">
            运行
          </NButton>
          <NButton size="small" type="warning" :disabled="!runningRun" @click="stopCurrent">
            停止
          </NButton>
          <NButton size="small" @click="openExport">导出</NButton>
          <NButton size="small" type="error" quaternary @click="deleteCurrent">删除</NButton>
        </NSpace>
      </div>

      <div v-if="store.selectedRun" class="wf-run-state">
        <NTag size="small" :type="RUN_TAG[store.selectedRun.state]">
          {{ RUN_LABEL[store.selectedRun.state] }}
        </NTag>
        <span v-if="store.selectedRun.error" class="wf-error">{{ store.selectedRun.error }}</span>
      </div>

      <div class="wf-canvas-host">
        <WorkflowCanvas
          ref="canvasRef"
          :key="store.selected.id"
          :definition="store.selected"
          :run-states="runStates"
        />
      </div>
    </template>

    <NEmpty v-else class="wf-empty" description="还没有工作流，点「＋新建」开始画一张 DAG" />

    <p v-if="store.lastError" class="wf-error">{{ store.lastError }}</p>

    <!-- 导出 -->
    <NModal v-model:show="showExport" preset="card" title="导出工作流（可移植 JSON）" style="width: 640px">
      <NInput type="textarea" :value="exportText" readonly :autosize="{ minRows: 8, maxRows: 20 }" />
      <template #footer>
        <NButton size="small" type="primary" @click="copyExport">复制</NButton>
      </template>
    </NModal>

    <!-- 导入 -->
    <NModal v-model:show="showImport" preset="card" title="导入工作流（粘贴 JSON）" style="width: 640px">
      <NInput
        type="textarea"
        :value="importText"
        placeholder="粘贴一份工作流定义 JSON"
        :autosize="{ minRows: 8, maxRows: 20 }"
        @update:value="(v: string) => (importText = v)"
      />
      <template #footer>
        <NButton size="small" type="primary" @click="doImport">导入</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.workflow-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  padding: var(--space-4) var(--space-5);
  gap: var(--space-3);
  overflow: hidden;
}
.wf-header,
.wf-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.wf-run-state {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wf-canvas-host {
  flex: 1;
  min-height: 300px;
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-m);
  overflow: hidden;
}
.wf-empty {
  margin: auto;
}
.wf-error {
  color: var(--status-error);
  font-size: var(--font-ui-12);
  margin: 0;
}
</style>
