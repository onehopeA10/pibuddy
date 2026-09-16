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
import PanelFrame from "./PanelFrame.vue";

const props = defineProps<{ embedded?: boolean }>();

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

// -------- 知识库新增 --------
const kbTitle = ref("");
const kbContent = ref("");
const KB_KIND_LABEL: Record<string, string> = { session: "会话", file: "文件", manual: "手工" };
async function submitKnowledge(): Promise<void> {
  const title = kbTitle.value.trim();
  const content = kbContent.value.trim();
  if (!title || !content) return;
  const ok = await store.knowledgeAdd(workspaceId.value, { title, content, sourceKind: "manual" });
  if (ok) {
    kbTitle.value = "";
    kbContent.value = "";
  }
}

watch(
  () => [store.panelOpen, workspaceId.value, store.query, store.scopeFilter, store.includeExcluded],
  () => {
    if (store.panelOpen && workspaceId.value) {
      void store.refresh(workspaceId.value);
      void store.loadHits(workspaceId.value);
      void store.loadEmbedStatus(workspaceId.value);
      void store.knowledgeList(workspaceId.value);
    }
  },
  { immediate: true }
);
</script>

<template>
  <PanelFrame
    :embedded="embedded"
    :show="store.panelOpen"
    title="长期记忆"
    width="920px"
    @update:show="store.panelOpen = $event"
  >
    <div class="feature-page">
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

    <!-- 嵌入状态 + 语义检索（v2） -->
    <section class="semantic" aria-label="语义检索">
      <div class="bar">
        <n-input
          v-model:value="store.semanticQuery"
          placeholder="语义检索（混合 FTS + 向量，近义不同词也能查到）"
          clearable
          size="small"
          style="max-width: 320px"
          :input-props="{ 'aria-label': '语义检索' }"
          @keyup.enter="store.semanticSearch(workspaceId)"
        />
        <n-button size="small" type="primary" @click="store.semanticSearch(workspaceId)">检索</n-button>
        <span class="spacer" />
        <span v-if="store.embedStatus" class="muted embed-stat">
          嵌入 {{ store.embedStatus.backend }}·{{ store.embedStatus.model }}
          （{{ store.embedStatus.embeddedMemories }}/{{ store.embedStatus.totalMemories }}）
        </span>
        <n-button size="tiny" quaternary @click="store.reembed(workspaceId)">重嵌</n-button>
      </div>
      <div v-if="store.semanticLoading" class="center"><n-spin size="small" /></div>
      <ul v-else-if="store.semanticResults.length > 0" class="sem-list" aria-label="语义检索结果">
        <li v-for="h in store.semanticResults" :key="h.record.id" class="sem-row">
          <n-tag size="small">{{ TYPE_LABEL[h.record.type] ?? h.record.type }}</n-tag>
          <span class="sem-content">{{ h.record.content }}</span>
          <span class="sem-score" :title="`FTS ${h.ftsScore.toFixed(2)} · 向量 ${h.vectorScore.toFixed(2)}`">
            {{ Math.round(h.score * 100) }}
          </span>
        </li>
      </ul>
    </section>

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

    <!-- 知识库（v2）：带来源引用的文档 / 片段 -->
    <section class="knowledge" aria-label="知识库">
      <h4>知识库</h4>
      <div class="kb-add">
        <n-input
          v-model:value="kbTitle"
          placeholder="标题"
          size="small"
          style="max-width: 200px"
          :input-props="{ 'aria-label': '知识标题' }"
        />
        <n-input
          v-model:value="kbContent"
          type="textarea"
          placeholder="内容（检索时命中会标出来源）"
          :autosize="{ minRows: 1, maxRows: 4 }"
          :input-props="{ 'aria-label': '知识内容' }"
        />
        <n-button size="small" type="primary" :disabled="!kbTitle.trim() || !kbContent.trim()" @click="submitKnowledge">
          加入
        </n-button>
      </div>
      <div class="bar">
        <n-input
          v-model:value="store.knowledgeQuery"
          placeholder="检索知识库"
          clearable
          size="small"
          style="max-width: 280px"
          :input-props="{ 'aria-label': '检索知识库' }"
          @keyup.enter="store.knowledgeSearch(workspaceId)"
        />
        <n-button size="small" @click="store.knowledgeSearch(workspaceId)">检索</n-button>
      </div>
      <ul v-if="store.knowledgeResults.length > 0" class="kb-list" aria-label="知识检索结果">
        <li v-for="h in store.knowledgeResults" :key="h.record.id" class="kb-row">
          <div class="kb-main">
            <div class="kb-title">{{ h.record.title }}</div>
            <div class="kb-content">{{ h.record.content }}</div>
            <div class="kb-cite">
              引用：{{ KB_KIND_LABEL[h.citation.sourceKind] ?? h.citation.sourceKind }}
              <template v-if="h.citation.sourceRef"> · {{ h.citation.sourceRef }}</template>
              <template v-if="h.citation.sourceTurnId"> · 轮次 {{ h.citation.sourceTurnId }}</template>
            </div>
          </div>
          <n-button size="tiny" quaternary @click="store.knowledgeDelete(workspaceId, h.record.id)">删除</n-button>
        </li>
      </ul>
      <ul v-else class="kb-list" aria-label="知识库列表">
        <li v-for="k in store.knowledgeItems" :key="k.id" class="kb-row">
          <div class="kb-main">
            <div class="kb-title">{{ k.title }}</div>
            <div class="kb-content">{{ k.content }}</div>
            <div class="kb-cite">
              来源：{{ KB_KIND_LABEL[k.sourceKind] ?? k.sourceKind }}
              <template v-if="k.sourceRef"> · {{ k.sourceRef }}</template>
            </div>
          </div>
          <n-button size="tiny" quaternary @click="store.knowledgeDelete(workspaceId, k.id)">删除</n-button>
        </li>
        <li v-if="store.knowledgeItems.length === 0" class="muted">知识库还是空的。</li>
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
    </div>
  </PanelFrame>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
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
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-l);
  padding: var(--space-3);
  margin-bottom: 12px;
}
.add-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: none;
  overflow: auto;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  border-bottom: var(--border-w) solid var(--border-subtle);
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
  color: var(--text-tertiary);
  font-size: var(--font-ui-12);
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
  border-left: 3px solid var(--border-strong);
  padding-left: 8px;
}
.ev-src {
  color: var(--text-secondary);
  font-size: var(--font-ui-12);
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
  border-top: var(--border-w) solid var(--border-subtle);
  padding-top: var(--space-3);
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
  color: var(--text-secondary);
  font-size: var(--font-ui-12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.semantic {
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-l);
  padding: var(--space-3);
  margin-bottom: 12px;
}
.embed-stat {
  font-size: 12px;
}
.sem-list,
.kb-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 26vh;
  overflow: auto;
}
.sem-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.sem-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.sem-score {
  color: var(--accent);
  font-size: var(--font-ui-12);
  font-variant-numeric: tabular-nums;
}
.knowledge {
  margin-top: 14px;
  border-top: var(--border-w) solid var(--border-subtle);
  padding-top: var(--space-3);
}
.kb-add {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.kb-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.kb-main {
  flex: 1;
  min-width: 0;
}
.kb-title {
  font-weight: 600;
  font-size: 13px;
}
.kb-content {
  margin-top: 2px;
  font-size: var(--font-ui-12);
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.kb-cite {
  margin-top: 3px;
  font-size: var(--font-ui-11);
  color: var(--text-tertiary);
}
.muted {
  color: var(--text-tertiary);
  font-size: var(--font-ui-13);
}
.err {
  color: var(--status-error);
  font-size: var(--font-ui-12);
}
.center {
  display: flex;
  justify-content: center;
  padding: 20px;
}
</style>
