<script setup lang="ts">
/**
 * 学习面板（edu.kids / REQ-0001 R3，首个真内容垂直包的 UI 贡献）。
 *
 * 三块：孩子档案（按 workspace 分区）、一键出卷、错题本。出卷与复习卷都
 * **只把组好的中文指令填进输入框**——出题在 pi 回路内（agent 调
 * edu.kids.math_worksheet 工具，代码保证答案正确），讲解与排版归模型；
 * 面板不绕过会话直接生成任何内容，用户发送前永远可改。
 */
import { computed, onMounted, ref, watch } from "vue";
import { NButton, NCheckbox, NCheckboxGroup, NInput, NInputNumber, NSelect, NTag } from "naive-ui";
import type { EduSubjectId } from "@contract";
import { useAppStore } from "../stores/app";
import { SUBJECT_LABELS, useEduStore, type WorksheetRequest } from "../stores/edu";

const app = useAppStore();
const edu = useEduStore();

const workspaceId = computed(() => app.workspaceId);

// ---- 档案表单（本地草稿，保存时整份提交） ----
const formName = ref("");
const formGrade = ref(3);
const formSubjects = ref<EduSubjectId[]>([]);

const gradeOptions = [1, 2, 3, 4, 5, 6].map((n) => ({ label: `${n} 年级`, value: n }));

/** 档案回来后把表单同步成落盘值（含切工作区）。 */
watch(
  () => edu.profile,
  (p) => {
    formName.value = p?.childName ?? "";
    formGrade.value = p?.grade ?? 3;
    formSubjects.value = [...(p?.subjects ?? [])];
  },
  { immediate: true }
);

watch(
  workspaceId,
  (id) => {
    if (id) void edu.refresh(id);
  },
  { immediate: true }
);

onMounted(() => {
  if (workspaceId.value) void edu.refresh(workspaceId.value);
});

async function onSaveProfile(): Promise<void> {
  if (!workspaceId.value) return;
  const ok = await edu.saveProfile(
    workspaceId.value,
    formName.value.trim(),
    formGrade.value,
    formSubjects.value
  );
  if (ok) app.notify("success", "档案已保存");
}

// ---- 一键出卷 ----
const wsOperation = ref<WorksheetRequest["operation"]>("mix");
const wsCount = ref(20);
const wsDifficulty = ref<WorksheetRequest["difficulty"]>("basic");

const operationOptions = [
  { label: "加法", value: "add" },
  { label: "减法", value: "sub" },
  { label: "乘法", value: "mul" },
  { label: "除法", value: "div" },
  { label: "加减乘除混合", value: "mix" },
];
const difficultyOptions = [
  { label: "基础", value: "basic" },
  { label: "挑战", value: "challenge" },
];

/** 填进输入框（不代发）：用户看得到、改得了，发不发由他决定。 */
function fillComposer(text: string): void {
  app.editorText = text;
  app.notify("success", "已填入输入框，确认后发送");
}

function onWorksheet(): void {
  fillComposer(
    edu.buildWorksheetPrompt({
      operation: wsOperation.value,
      count: Math.min(50, Math.max(1, Math.round(wsCount.value || 20))),
      difficulty: wsDifficulty.value,
    })
  );
}

function onReview(): void {
  fillComposer(edu.buildReviewPrompt());
}

const subjectLabel = (subject: string): string =>
  SUBJECT_LABELS[subject as EduSubjectId] ?? subject;
</script>

<template>
  <div class="edu-panel">
    <header class="ep-head">
      <strong>学习面板</strong>
      <span class="ep-sub">给家长的备课练习工具，孩子请在家长陪同下使用</span>
    </header>

    <!-- 孩子档案 -->
    <section class="ep-section">
      <h4>孩子档案</h4>
      <div class="ep-form-row">
        <n-input
          v-model:value="formName"
          size="small"
          placeholder="称呼（可选，如：小明）"
          :maxlength="30"
        />
        <n-select v-model:value="formGrade" size="small" :options="gradeOptions" />
      </div>
      <n-checkbox-group v-model:value="formSubjects">
        <n-checkbox
          v-for="(label, id) in SUBJECT_LABELS"
          :key="id"
          :value="id"
          :label="label"
          size="small"
        />
      </n-checkbox-group>
      <n-button
        size="small"
        type="primary"
        :loading="edu.busy"
        :disabled="!workspaceId"
        @click="onSaveProfile"
      >
        保存档案
      </n-button>
      <p v-if="edu.profileLoaded && !edu.profile" class="ep-hint">
        还没有档案。设置年级后，出卷与辅导提示词会按年级调整难度。
      </p>
    </section>

    <!-- 一键出卷 -->
    <section class="ep-section">
      <h4>一键出卷（数学）</h4>
      <div class="ep-form-row">
        <n-select v-model:value="wsOperation" size="small" :options="operationOptions" />
        <n-input-number v-model:value="wsCount" size="small" :min="1" :max="50" />
        <n-select v-model:value="wsDifficulty" size="small" :options="difficultyOptions" />
      </div>
      <div class="ep-actions">
        <n-button size="small" type="primary" @click="onWorksheet">出练习卷</n-button>
        <n-button size="small" :disabled="!edu.mistakesExists" @click="onReview">
          出错题复习卷
        </n-button>
      </div>
      <p class="ep-hint">
        指令会填入输入框，发送后由 Agent 调用出题器完成（题目与答案由代码保证正确）。
      </p>
    </section>

    <!-- 错题本 -->
    <section class="ep-section ep-mistakes">
      <h4>
        错题本
        <n-tag v-if="edu.mistakesExists" size="small" :bordered="false">
          共 {{ edu.mistakesTotal }} 条
        </n-tag>
        <n-button
          size="tiny"
          quaternary
          :disabled="!workspaceId"
          @click="workspaceId && edu.refresh(workspaceId)"
        >
          刷新
        </n-button>
      </h4>
      <p v-if="edu.lastError" class="ep-error">{{ edu.lastError }}</p>
      <p v-if="edu.mistakesSkipped > 0" class="ep-hint">
        有 {{ edu.mistakesSkipped }} 行记录格式不完整，已跳过。
      </p>
      <template v-if="edu.mistakes.length > 0">
        <div v-for="(m, i) in edu.mistakes" :key="i" class="ep-mistake">
          <div class="ep-mistake-head">
            <n-tag size="small" :bordered="false">{{ subjectLabel(m.subject) }}</n-tag>
            <span class="ep-topic">{{ m.topic }}</span>
            <span class="ep-date">{{ m.date }}</span>
          </div>
          <div class="ep-question">{{ m.question }}</div>
          <div v-if="m.wrong || m.right" class="ep-answers">
            <span v-if="m.wrong" class="ep-wrong">错答：{{ m.wrong }}</span>
            <span v-if="m.right" class="ep-right">正解：{{ m.right }}</span>
          </div>
          <div v-if="m.note" class="ep-note">{{ m.note }}</div>
        </div>
      </template>
      <p v-else class="ep-hint">
        还没有错题记录。在会话里对 Agent 说「用 edu-mistake-book 记一道错题」即可开始积累。
      </p>
    </section>
  </div>
</template>

<style scoped>
.edu-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  min-width: 300px;
  max-width: 380px;
  overflow-y: auto;
}
.ep-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ep-sub {
  font-size: 12px;
  opacity: 0.6;
}
.ep-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--divider-color, #e0e0e6);
  border-radius: 6px;
  padding: 10px;
}
.ep-section h4 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ep-form-row {
  display: flex;
  gap: 6px;
}
.ep-form-row > * {
  flex: 1;
  min-width: 0;
}
.ep-actions {
  display: flex;
  gap: 6px;
}
.ep-hint {
  font-size: 12px;
  opacity: 0.6;
  margin: 0;
}
.ep-error {
  color: var(--error-color, #d03050);
  font-size: 12px;
  margin: 0;
}
.ep-mistakes {
  min-height: 0;
}
.ep-mistake {
  border-top: 1px solid var(--divider-color, #e0e0e6);
  padding: 6px 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 13px;
}
.ep-mistake-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ep-topic {
  font-weight: 600;
}
.ep-date {
  margin-left: auto;
  font-size: 12px;
  opacity: 0.5;
}
.ep-question {
  white-space: pre-wrap;
  word-break: break-word;
}
.ep-answers {
  display: flex;
  gap: 10px;
  font-size: 12px;
}
.ep-wrong {
  color: var(--error-color, #d03050);
}
.ep-right {
  color: var(--success-color, #18a058);
}
.ep-note {
  font-size: 12px;
  opacity: 0.7;
}
</style>
