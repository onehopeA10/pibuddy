<script setup lang="ts">
/**
 * 提示词库面板（common.prompt-library / REQ-0001 R1 的界面出口）。
 *
 * 浏览（按五类分组）/ 搜索 / 一键填入输入框 / 收藏；用户自建与预置同列。
 * 预置项右上角只有「隐藏」，没有删除与编辑 —— 不可删是产品规则（R1.3），
 * 界面上干脆不画那个按钮，而不是画出来再弹「不允许」。想改预置的内容，
 * 走「存为我的」：复制成一条用户项随便改，原预置照旧。
 */
import { inject, ref, watch } from "vue";
import { NButton, NCheckbox, NEmpty, NInput, NModal, NSelect, NSpin, NTag, useMessage } from "naive-ui";
import { PROMPT_CATEGORY_LABELS, type PromptCategory, type PromptEntry } from "@contract";
import { usePromptLibraryStore } from "../stores/promptLibrary";
import PanelFrame from "./PanelFrame.vue";

defineProps<{ embedded?: boolean }>();
const goChat = inject<() => void>("goChat", () => undefined);

const store = usePromptLibraryStore();
const message = useMessage();

const categoryOptions = (Object.entries(PROMPT_CATEGORY_LABELS) as [PromptCategory, string][]).map(
  ([value, label]) => ({ value, label })
);

// -------- 新建 / 编辑共用一张表单 --------
const formOpen = ref(false);
/** 空串 = 新建；否则是正在编辑的条目 id。 */
const editingId = ref("");
const formTitle = ref("");
const formDescription = ref("");
const formCategory = ref<PromptCategory>("custom");
const formContent = ref("");

function beginCreate(): void {
  editingId.value = "";
  formTitle.value = "";
  formDescription.value = "";
  formCategory.value = "custom";
  formContent.value = "";
  formOpen.value = true;
}

function beginEdit(entry: PromptEntry): void {
  editingId.value = entry.id;
  formTitle.value = entry.title;
  formDescription.value = entry.description;
  formCategory.value = entry.category;
  formContent.value = entry.content;
  formOpen.value = true;
}

/** 把一条预置复制成用户项（预置不可改，改它的正确姿势）。 */
function beginSaveAsMine(entry: PromptEntry): void {
  editingId.value = "";
  formTitle.value = `${entry.title}（我的）`;
  formDescription.value = entry.description;
  formCategory.value = entry.category;
  formContent.value = entry.content;
  formOpen.value = true;
}

async function submitForm(): Promise<void> {
  const title = formTitle.value.trim();
  const content = formContent.value.trim();
  if (!title || !content) {
    message.warning("标题和模板内容都不能为空");
    return;
  }
  const ok = editingId.value
    ? await store.update({
        id: editingId.value,
        title,
        description: formDescription.value.trim(),
        category: formCategory.value,
        content,
      })
    : await store.create({
        title,
        description: formDescription.value.trim(),
        category: formCategory.value,
        content,
      });
  if (ok) {
    formOpen.value = false;
    message.success(editingId.value ? "已保存修改" : "已加入我的提示词");
  }
}

async function confirmRemove(entry: PromptEntry): Promise<void> {
  if (await store.remove(entry.id)) message.success(`已删除「${entry.title}」`);
}

function use(entry: PromptEntry): void {
  store.fillComposer(entry);
  message.success("模板已填入输入框，替换【】里的内容后发送");
  goChat();
}

watch(
  () => store.panelOpen,
  (open) => {
    if (open) void store.refresh();
  },
  { immediate: true }
);
</script>

<template>
  <PanelFrame
    :embedded="embedded"
    :show="store.panelOpen"
    title="提示词库"
    width="760px"
    @update:show="store.panelOpen = $event"
  >
    <div class="toolbar">
      <n-input
        v-model:value="store.query"
        placeholder="搜索标题、说明或内容…"
        clearable
        size="small"
        style="flex: 1"
      />
      <n-checkbox v-model:checked="store.favoritesOnly" size="small">只看收藏</n-checkbox>
      <n-checkbox v-if="store.hiddenCount > 0" v-model:checked="store.showHidden" size="small">
        显示已隐藏（{{ store.hiddenCount }}）
      </n-checkbox>
      <n-button size="small" type="primary" @click="beginCreate">＋ 新建提示词</n-button>
    </div>

    <p v-if="store.lastError" class="error-line">{{ store.lastError }}</p>
    <p v-for="(err, i) in store.errors" :key="`err-${i}`" class="error-line">{{ err }}</p>

    <n-spin :show="store.loading">
      <n-empty
        v-if="store.grouped.length === 0"
        description="没有匹配的提示词"
        style="padding: 32px 0"
      />

      <div v-for="group in store.grouped" :key="group.category" class="group">
        <h3 class="group-title">{{ group.label }}</h3>
        <div
          v-for="entry in group.items"
          :key="entry.id"
          class="entry"
          :class="{ hidden: entry.hidden }"
          :data-testid="`prompt-entry-${entry.name}`"
        >
          <div class="entry-head">
            <span class="entry-title">{{ entry.title }}</span>
            <n-tag size="tiny" :bordered="false">/{{ entry.name }}</n-tag>
            <n-tag v-if="entry.preset" size="tiny" type="info" :bordered="false">预置</n-tag>
            <n-tag v-if="entry.hidden" size="tiny" type="warning" :bordered="false">已隐藏</n-tag>
          </div>
          <p class="entry-desc">{{ entry.description }}</p>
          <div class="entry-actions">
            <n-button size="tiny" type="primary" @click="use(entry)">填入输入框</n-button>
            <n-button
              size="tiny"
              quaternary
              :type="entry.favorite ? 'warning' : 'default'"
              @click="store.setFavorite(entry.id, !entry.favorite)"
            >
              {{ entry.favorite ? "★ 已收藏" : "☆ 收藏" }}
            </n-button>
            <template v-if="entry.preset">
              <n-button size="tiny" quaternary @click="beginSaveAsMine(entry)">存为我的</n-button>
              <n-button size="tiny" quaternary @click="store.setHidden(entry.id, !entry.hidden)">
                {{ entry.hidden ? "恢复显示" : "隐藏" }}
              </n-button>
            </template>
            <template v-else>
              <n-button size="tiny" quaternary @click="beginEdit(entry)">编辑</n-button>
              <n-button size="tiny" quaternary type="error" @click="confirmRemove(entry)">
                删除
              </n-button>
            </template>
          </div>
        </div>
      </div>
    </n-spin>

    <!-- 新建 / 编辑表单 -->
    <n-modal
      v-model:show="formOpen"
      preset="card"
      :title="editingId ? '编辑提示词' : '新建提示词'"
      style="width: 640px"
    >
      <div class="form">
        <n-input v-model:value="formTitle" placeholder="标题（也是 / 命令名的来源）" />
        <n-select v-model:value="formCategory" :options="categoryOptions" />
        <n-input v-model:value="formDescription" placeholder="一句话说明（选填）" />
        <n-input
          v-model:value="formContent"
          type="textarea"
          :autosize="{ minRows: 8, maxRows: 18 }"
          placeholder="模板正文。建议把要替换的参数写成【这样的占位】，用的时候一眼就能找到。"
        />
        <div class="form-actions">
          <n-button size="small" @click="formOpen = false">取消</n-button>
          <n-button size="small" type="primary" @click="submitForm">保存</n-button>
        </div>
      </div>
    </n-modal>
  </PanelFrame>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.error-line {
  color: var(--status-error);
  font-size: var(--font-ui-12);
  margin: 4px 0;
}
.group {
  margin-bottom: 16px;
}
.group-title {
  font-size: var(--font-ui-13);
  margin: 8px 0 6px;
  color: var(--text-secondary);
}
.entry {
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-m);
  padding: 8px 12px;
  margin-bottom: 8px;
}
.entry.hidden {
  opacity: 0.55;
}
.entry-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.entry-title {
  font-weight: 600;
}
.entry-desc {
  margin: 4px 0 6px;
  font-size: var(--font-ui-12);
  color: var(--text-secondary);
}
.entry-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
