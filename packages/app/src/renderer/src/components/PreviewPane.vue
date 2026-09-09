<script setup lang="ts">
/**
 * 预览面板（ART-101 的界面出口）。
 *
 * ## 为什么失败态也要渲染出东西
 *
 * 损坏 / 有密码 / 太大 / 不支持这四类里，任何一类如果表现成一片空白，
 * 用户能得到的信息是零。这里的规则是：`result.text` 非空就渲染 text，
 * `result.code !== 'ok'` 就同时把 `result.suggestion` 显示出来 ——
 * 而 suggestion 逐字来自 main/preview/convert-worker.ts 的 SUGGESTION 表，
 * 界面上不再有第二处文案。
 *
 * ## 为什么这里用 `<pre>` 而不是 v-html
 *
 * 预览的是不可信内容。哪怕主窗口的 CSP 已经把 script-src 钉死成 'self'，
 * 把一段来历不明的 HTML 塞进 v-html 仍然会带来 DOM 注入（表单、样式覆盖、
 * 伪造的界面元素）。文本类内容一律走文本节点；需要富一点的呈现时走
 * openInWindow —— 那个窗口的 JS 引擎是关的。
 */
import { computed } from "vue";
import { NButton, NSpin, NTag } from "naive-ui";
import { useArtifactsStore } from "../stores/artifacts";

const props = defineProps<{
  /** attachment token、产物 id 或 workspaceId+relativePath */
  token?: string;
  workspaceId?: string;
  relativePath?: string;
  artifactId?: string;
}>();

const store = useArtifactsStore();

const result = computed(() => store.current);
const failed = computed(() => result.value !== null && result.value.code !== "ok");

const KIND_LABEL: Record<string, string> = {
  markdown: "Markdown",
  text: "文本",
  json: "JSON",
  csv: "表格 (CSV)",
  image: "图片",
  "media-metadata": "音视频信息",
  pdf: "PDF",
  word: "Word",
  excel: "Excel",
  ppt: "PPT",
};

function reload(): void {
  void store.preview({
    token: props.token,
    workspaceId: props.workspaceId,
    relativePath: props.relativePath,
    artifactId: props.artifactId,
  });
}

function openWindow(): void {
  void store.openInWindow({
    token: props.token,
    workspaceId: props.workspaceId,
    relativePath: props.relativePath,
    artifactId: props.artifactId,
  });
}
</script>

<template>
  <section class="preview-pane" aria-label="文件预览">
    <header class="preview-head">
      <strong>{{ result?.sourceName ?? "预览" }}</strong>
      <n-tag v-if="result" size="small">{{ KIND_LABEL[result.kind] ?? result.kind }}</n-tag>
      <n-tag v-if="failed" size="small" type="warning">{{ result?.code }}</n-tag>
      <span class="spacer" />
      <n-button size="tiny" quaternary @click="reload">重新读取</n-button>
      <n-button size="tiny" quaternary @click="openWindow">在独立窗口打开</n-button>
    </header>

    <div v-if="store.previewing" class="preview-body center"><n-spin size="small" /></div>

    <div v-else-if="result" class="preview-body">
      <!-- 失败时**先**给出可行动的那句话，正文（如果还抽出了一些）照常显示 -->
      <p v-if="failed" class="preview-suggestion" role="alert">{{ result.suggestion }}</p>

      <!-- 安全提示与 tables/text 两条渲染分支都无关：无论走哪条都要显示 -->
      <ul v-if="result.notices.length > 0" class="preview-notices" role="alert">
        <li v-for="(n, i) in result.notices" :key="i">{{ n }}</li>
      </ul>

      <img
        v-if="result.dataUrl"
        :src="result.dataUrl"
        :alt="result.sourceName"
        class="preview-image"
      />

      <table v-for="(table, ti) in result.tables" :key="ti" class="preview-table">
        <caption v-if="table.name">{{ table.name }}</caption>
        <tbody>
          <tr v-for="(row, ri) in table.rows" :key="ri">
            <td v-for="(c, ci) in row" :key="ci">{{ c }}</td>
          </tr>
        </tbody>
      </table>

      <pre v-if="result.tables.length === 0" class="preview-text">{{ result.text }}</pre>
    </div>

    <div v-else class="preview-body center muted">选一个文件来看看。</div>
  </section>
</template>

<style scoped>
.preview-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid #e5e7eb;
}
.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #eef0f3;
  font-size: 13px;
}
.spacer {
  flex: 1;
}
.preview-body {
  overflow: auto;
  padding: 10px 12px;
  max-height: 320px;
}
.preview-body.center {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
}
.muted {
  color: #9ca3af;
  font-size: 13px;
}
.preview-suggestion {
  background: #fff7ed;
  border: 1px solid #fdba74;
  border-radius: 6px;
  padding: 8px 10px;
  margin: 0 0 10px;
  font-size: 13px;
}
.preview-notices {
  background: #fff7ed;
  border: 1px solid #fdba74;
  border-radius: 6px;
  padding: 8px 10px 8px 26px;
  margin: 0 0 10px;
  font-size: 12.5px;
  word-break: break-all;
}
.preview-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
  margin: 0;
}
.preview-image {
  max-width: 100%;
  display: block;
  margin-bottom: 10px;
}
.preview-table {
  border-collapse: collapse;
  font-size: 12.5px;
  margin-bottom: 12px;
}
.preview-table td {
  border: 1px solid #e5e7eb;
  padding: 2px 6px;
}
.preview-table caption {
  text-align: left;
  font-weight: 600;
  padding: 4px 0;
}
</style>
