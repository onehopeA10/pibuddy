<script setup lang="ts">
/**
 * 产物库（ART-102 的界面出口）。
 *
 * 八个动作各对应一条窄通道：搜索筛选、版本比较、重命名、复制一份、
 * 导出、在文件夹中显示、移入回收站、恢复。
 *
 * ## 状态是显式画出来的
 *
 * generating / failed / conflicted 三个状态如果不在列表里画出来，
 * 用户看到的就是一个「点开是空的」的条目 —— 而那正是 Agent 还在写、
 * 或者写失败了、或者被外部改过。状态标签就是这三种情况唯一的解释。
 */
import { computed, ref, watch } from "vue";
import { NButton, NInput, NModal, NSelect, NSpin, NTag } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useArtifactsStore } from "../stores/artifacts";

const app = useAppStore();
const store = useArtifactsStore();

const renaming = ref("");
const renameValue = ref("");

const STATUS_LABEL: Record<string, { text: string; type: "default" | "info" | "warning" | "error" | "success" }> = {
  generating: { text: "生成中", type: "info" },
  ready: { text: "就绪", type: "success" },
  failed: { text: "生成失败", type: "error" },
  conflicted: { text: "已被外部改动", type: "warning" },
  trashed: { text: "在回收站", type: "default" },
};

const statusOptions = [
  { label: "全部状态", value: "" },
  { label: "生成中", value: "generating" },
  { label: "就绪", value: "ready" },
  { label: "生成失败", value: "failed" },
  { label: "已被外部改动", value: "conflicted" },
];

const workspaceId = computed(() => app.workspaceId ?? "");

watch(
  () => [store.panelOpen, workspaceId.value, store.query, store.statusFilter, store.showTrash],
  () => {
    if (store.panelOpen && workspaceId.value) void store.refresh(workspaceId.value);
  },
  { immediate: true }
);

function beginRename(id: string, name: string): void {
  renaming.value = id;
  renameValue.value = name;
}

async function commitRename(): Promise<void> {
  const id = renaming.value;
  if (!id) return;
  await store.rename(workspaceId.value, id, renameValue.value.trim() || "未命名");
  renaming.value = "";
}
</script>

<template>
  <n-modal
    v-model:show="store.panelOpen"
    preset="card"
    closable
    style="width: 900px; max-width: 94vw"
    title="产物"
    aria-label="产物库"
  >
    <div class="bar">
      <n-input
        v-model:value="store.query"
        placeholder="按名字搜索产物"
        clearable
        size="small"
        style="max-width: 260px"
        :input-props="{ 'aria-label': '搜索产物' }"
      />
      <n-select
        v-model:value="store.statusFilter"
        :options="statusOptions"
        size="small"
        style="width: 160px"
        :input-props="{ 'aria-label': '按状态筛选' }"
      />
      <n-button
        size="small"
        :type="store.showTrash ? 'primary' : 'default'"
        quaternary
        @click="store.showTrash = !store.showTrash"
      >
        回收站
      </n-button>
      <span class="spacer" />
      <n-button
        size="small"
        :disabled="!store.canCompare"
        @click="store.runCompare()"
      >
        比较选中的两版
      </n-button>
    </div>

    <p v-if="store.lastError" class="err" role="alert">{{ store.lastError }}</p>

    <div v-if="store.loading" class="center"><n-spin size="small" /></div>

    <p v-else-if="store.items.length === 0" class="muted">
      {{ store.showTrash ? "回收站是空的。" : "还没有产物。让我帮你做点东西吧。" }}
    </p>

    <ul v-else class="list">
      <li v-for="item in store.items" :key="item.id" class="row">
        <label class="pick">
          <input
            type="checkbox"
            :checked="store.compareLeft === item.id || store.compareRight === item.id"
            :aria-label="`选择 ${item.name} 参与版本比较`"
            @change="store.toggleCompare(item.id)"
          />
        </label>
        <div class="meta">
          <div class="title">
            <template v-if="renaming === item.id">
              <n-input
                v-model:value="renameValue"
                size="tiny"
                style="max-width: 240px"
                :input-props="{ 'aria-label': '新名字' }"
                @keyup.enter="commitRename"
              />
              <n-button size="tiny" @click="commitRename">保存</n-button>
              <n-button size="tiny" quaternary @click="renaming = ''">取消</n-button>
            </template>
            <template v-else>
              <strong>{{ item.name }}</strong>
              <n-tag size="small">v{{ item.version }}</n-tag>
              <n-tag size="small" :type="STATUS_LABEL[item.status]?.type ?? 'default'">
                {{ STATUS_LABEL[item.status]?.text ?? item.status }}
              </n-tag>
            </template>
          </div>
          <div class="sub">{{ item.exportPath }} · {{ item.sizeBytes }} 字节</div>
        </div>
        <div class="actions">
          <template v-if="item.status === 'trashed'">
            <n-button size="tiny" @click="store.restore(workspaceId, item.id)">恢复</n-button>
            <n-button size="tiny" quaternary @click="store.exportOne(item.id)">导出</n-button>
          </template>
          <template v-else>
            <n-button size="tiny" quaternary @click="beginRename(item.id, item.name)">
              重命名
            </n-button>
            <n-button size="tiny" quaternary @click="store.duplicate(workspaceId, item.id)">
              复制一份
            </n-button>
            <n-button size="tiny" quaternary @click="store.exportOne(item.id)">导出</n-button>
            <n-button size="tiny" quaternary @click="store.showInFolder(item.id)">
              在文件夹中显示
            </n-button>
            <n-button size="tiny" quaternary @click="store.trash(workspaceId, item.id)">
              移入回收站
            </n-button>
          </template>
        </div>
      </li>
    </ul>

    <section v-if="store.comparison" class="compare" aria-label="版本比较结果">
      <h4>
        v{{ store.comparison.left.version }} ↔ v{{ store.comparison.right.version }} ·
        {{ store.comparison.identical ? "内容完全相同" : "内容不同" }} · 体积差
        {{ store.comparison.sizeDelta }} 字节
      </h4>
      <p v-if="store.comparison.degraded" class="muted">{{ store.comparison.degraded }}</p>
      <pre v-else class="diff"><template
        v-for="(d, i) in store.comparison.textDiff"
        :key="i"
      >{{ d.op === "add" ? "+" : "-" }} {{ d.text }}
</template></pre>
    </section>
  </n-modal>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.spacer {
  flex: 1;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 46vh;
  overflow: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.meta {
  flex: 1;
  min-width: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sub {
  color: var(--text-tertiary);
  font-size: var(--font-ui-12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.muted {
  color: var(--text-tertiary);
  font-size: var(--font-ui-13);
}
.err {
  color: var(--status-error);
  font-size: 12.5px;
}
.center {
  display: flex;
  justify-content: center;
  padding: 20px;
}
.compare {
  margin-top: 12px;
  border-top: var(--border-w) solid var(--border-subtle);
  padding-top: 8px;
}
.diff {
  max-height: 200px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
}
</style>
