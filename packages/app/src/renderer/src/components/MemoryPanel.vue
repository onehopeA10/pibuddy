<script setup lang="ts">
/**
 * 长期记忆面板（MEM-101 第一版的界面出口）。
 *
 * 一处集齐九个动作：保存新记忆、检索、编辑、合并、排除 / 恢复、删除、导出、
 * 看原始证据、看注入命中，以及开关注入（当前工作区 / 全局）。
 *
 * ## 为什么把「注入命中」画出来
 *
 * 注入发生在主进程、用户看不见。不画出来的话，「模型怎么知道我上次说过这个」
 * 就成了一件没法追问的事。命中区把「这一轮我被塞了哪些记忆」摊开，用户据此
 * 知道该去改 / 删哪一条 —— 这正是「不能把总结当不可更正真相」的界面兜底。
 */
import { computed, ref, watch } from "vue";
import { NButton, NCheckbox, NInput, NModal, NSelect, NSpin, NSwitch, NTag } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useMemoryStore } from "../stores/memory";
import type { MemoryScope, MemoryType } from "@contract";

const app = useAppStore();
const store = useMemoryStore();

const workspaceId = computed(() => app.workspaceId ?? "");

const TYPE_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  instruction: "指令",
  context: "背景",
};

const typeOptions = [
  { label: "事实", value: "fact" },
  { label: "偏好", value: "preference" },
  { label: "指令", value: "instruction" },
  { label: "背景", value: "context" },
];
const scopeOptions = [
  { label: "本工作区", value: "workspace" },
  { label: "全局", value: "global" },
];
const scopeFilterOptions = [{ label: "全部作用域", value: "" }, ...scopeOptions];

// -------- 新增表单 --------
const draftContent = ref("");
const draftType = ref<MemoryType>("fact");
const draftScope = ref<MemoryScope>("workspace");

async function submitNew(): Promise<void> {
  const content = draftContent.value.trim();
  if (!content) return;
  const ok = await store.save(workspaceId.value, {
    content,
    type: draftType.value,
    scope: draftScope.value,
  });
  if (ok) draftContent.value = "";
}

// -------- 编辑 --------
const editingId = ref("");
const editContent = ref("");
function beginEdit(id: string, content: string): void {
  editingId.value = id;
  editContent.value = content;
}
async function commitEdit(): Promise<void> {
  const id = editingId.value;
  if (!id) return;
  const ok = await store.update(workspaceId.value, { id, content: editContent.value.trim() });
  if (ok) editingId.value = "";
}

// -------- 合并 --------
const merging = ref(false);
const mergeContent = ref("");
async function commitMerge(): Promise<void> {
  const ok = await store.mergeSelected(workspaceId.value, mergeContent.value.trim());
  if (ok) {
    merging.value = false;
    mergeContent.value = "";
  }
}

// -------- 导出 --------
async function doExport(): Promise<void> {
  const content = await store.exportAll(workspaceId.value);
  if (!content) return;
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "memories.json";
  a.click();
  URL.revokeObjectURL(url);
}

watch(
  () => [store.panelOpen, workspaceId.value, store.query, store.scopeFilter, store.includeExcluded],
  () => {
    if (store.panelOpen && workspaceId.value) {
      void store.refresh(workspaceId.value);
      void store.loadHits(workspaceId.value);
    }
  },
  { immediate: true }
);
</script>

<template>
  <n-modal
    v-model:show="store.panelOpen"
    preset="card"
    style="width: 920px; max-width: 94vw"
    title="长期记忆"
    aria-label="长期记忆"
  >
    <!-- 注入开关 -->
    <div class="bar">
      <label class="toggle">
        <n-switch
          :value="store.injectionEnabled"
          size="small"
          @update:value="(v: boolean) => store.setInjection(workspaceId, 'workspace', v)"
        />
        本工作区注入
      </label>
      <label class="toggle">
        <n-switch
          :value="store.globalInjectionEnabled"
          size="small"
          @update:value="(v: boolean) => store.setInjection(workspaceId, 'global', v)"
        />
        全局注入总开关
      </label>
      <span class="spacer" />
      <n-button size="small" quaternary @click="doExport">导出</n-button>
    </div>

    <!-- 新增 -->
    <section class="add" aria-label="保存一条记忆">
      <n-input
        v-model:value="draftContent"
        type="textarea"
        placeholder="记住点什么？（例如：回复统一用中文；后端用 PostgreSQL）"
        :autosize="{ minRows: 1, maxRows: 4 }"
        :input-props="{ 'aria-label': '记忆内容' }"
      />
      <div class="add-row">
        <n-select v-model:value="draftType" :options="typeOptions" size="small" style="width: 110px" />
        <n-select v-model:value="draftScope" :options="scopeOptions" size="small" style="width: 120px" />
        <n-button size="small" type="primary" :disabled="!draftContent.trim()" @click="submitNew">
          保存
        </n-button>
      </div>
    </section>

    <!-- 检索 / 筛选 -->
    <div class="bar">
      <n-input
        v-model:value="store.query"
        placeholder="检索记忆"
        clearable
        size="small"
        style="max-width: 240px"
        :input-props="{ 'aria-label': '检索记忆' }"
      />
      <n-select
        v-model:value="store.scopeFilter"
        :options="scopeFilterOptions"
        size="small"
        style="width: 130px"
      />
      <n-checkbox v-model:checked="store.includeExcluded" size="small">含已排除</n-checkbox>
      <span class="spacer" />
      <n-button
        v-if="store.selectedCount >= 2"
        size="small"
        @click="merging = true"
      >
        合并选中的 {{ store.selectedCount }} 条
      </n-button>
    </div>

    <p v-if="store.lastError" class="err" role="alert">{{ store.lastError }}</p>
    <div v-if="store.loading" class="center"><n-spin size="small" /></div>
    <p v-else-if="store.items.length === 0" class="muted">还没有记忆。在上面记一条吧。</p>

    <ul v-else class="list">
      <li v-for="item in store.items" :key="item.id" class="row" :class="{ excluded: item.excluded }">
        <label class="pick">
          <input
            type="checkbox"
            :checked="store.selected.has(item.id)"
            :aria-label="`选择记忆参与合并`"
            @change="store.toggleSelect(item.id)"
          />
        </label>
        <div class="meta">
          <div class="title">
            <n-tag size="small">{{ TYPE_LABEL[item.type] ?? item.type }}</n-tag>
            <n-tag size="small" :type="item.scope === 'global' ? 'info' : 'default'">
              {{ item.scope === "global" ? "全局" : "本工作区" }}
            </n-tag>
            <n-tag v-if="item.sensitivity === 'sensitive'" size="small" type="warning">敏感·不注入</n-tag>
            <n-tag v-if="item.excluded" size="small" type="error">已排除</n-tag>
            <span class="conf">可信度 {{ Math.round(item.confidence * 100) }}%</span>
          </div>
          <template v-if="editingId === item.id">
            <n-input
              v-model:value="editContent"
              type="textarea"
              size="small"
              :autosize="{ minRows: 1, maxRows: 6 }"
              :input-props="{ 'aria-label': '编辑记忆内容' }"
            />
            <div class="edit-actions">
              <n-button size="tiny" type="primary" @click="commitEdit">保存</n-button>
              <n-button size="tiny" quaternary @click="editingId = ''">取消</n-button>
            </div>
          </template>
          <div v-else class="content">{{ item.content }}</div>
          <div
            v-if="store.evidence && store.evidence.id === item.id"
            class="evidence"
            aria-label="原始证据"
          >
            <template v-if="store.evidence.found">
              <div class="ev-src">来源：{{ store.evidence.sessionName ?? "会话" }}</div>
              <pre class="ev-text">{{ store.evidence.text }}</pre>
            </template>
            <p v-else class="muted">找不到这条记忆的来源证据（可能是手动录入或会话已删）。</p>
          </div>
        </div>
        <div class="actions">
          <n-button size="tiny" quaternary @click="beginEdit(item.id, item.content)">编辑</n-button>
          <n-button size="tiny" quaternary @click="store.loadEvidence(item.id)">证据</n-button>
          <n-button
            size="tiny"
            quaternary
            @click="store.update(workspaceId, { id: item.id, excluded: !item.excluded })"
          >
            {{ item.excluded ? "恢复" : "排除" }}
          </n-button>
          <n-button size="tiny" quaternary @click="store.remove(workspaceId, item.id)">删除</n-button>
        </div>
      </li>
    </ul>

    <!-- 注入命中（隐私 / 调试视图） -->
    <section class="hits" aria-label="注入命中记录">
      <h4>注入命中记录（这一轮塞给模型的记忆）</h4>
      <p v-if="store.hits.length === 0" class="muted">还没有注入过任何记忆。</p>
      <ul v-else class="hit-list">
        <li v-for="(h, i) in store.hits" :key="`${h.id}-${i}`" class="hit">
          <n-tag size="small">{{ TYPE_LABEL[h.type] ?? h.type }}</n-tag>
          <span class="hit-preview">{{ h.preview }}</span>
        </li>
      </ul>
    </section>

    <!-- 合并弹窗 -->
    <n-modal
      v-model:show="merging"
      preset="dialog"
      title="合并记忆"
      positive-text="合并"
      negative-text="取消"
      @positive-click="commitMerge"
    >
      <p class="muted">选中的 {{ store.selectedCount }} 条将被删除，替换为下面这一条：</p>
      <n-input
        v-model:value="mergeContent"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 6 }"
        placeholder="合并后的内容"
        :input-props="{ 'aria-label': '合并后的内容' }"
      />
    </n-modal>
  </n-modal>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.spacer {
  flex: 1;
}
.add {
  border: 1px solid #eef0f3;
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 12px;
}
.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 42vh;
  overflow: auto;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 4px;
  border-bottom: 1px solid #f1f3f5;
}
.row.excluded {
  opacity: 0.55;
}
.meta {
  flex: 1;
  min-width: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.conf {
  color: #9ca3af;
  font-size: 12px;
}
.content {
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
.edit-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.evidence {
  margin-top: 6px;
  border-left: 3px solid #d0d7de;
  padding-left: 8px;
}
.ev-src {
  color: #6b7280;
  font-size: 12px;
}
.ev-text {
  max-height: 160px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  margin: 4px 0 0;
}
.actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.hits {
  margin-top: 14px;
  border-top: 1px solid #eef0f3;
  padding-top: 8px;
}
.hit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 20vh;
  overflow: auto;
}
.hit {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.hit-preview {
  color: #4b5563;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.muted {
  color: #9ca3af;
  font-size: 13px;
}
.err {
  color: #dc2626;
  font-size: 12.5px;
}
.center {
  display: flex;
  justify-content: center;
  padding: 20px;
}
</style>
