<script setup lang="ts">
/**
 * CodeMirror 文本编辑器（FS-101）。
 *
 * ## 冲突对话框为什么给三个动作而不是「确定 / 取消」
 *
 * 两个编辑器同时改同一个文件时，用户需要的从来不是「要不要覆盖」这个
 * 是非题 —— 他得先知道对方改了什么。所以这里给的是：
 *   查看差异   把磁盘上的当前内容摆出来（**不动磁盘**）
 *   重新载入   丢弃自己的编辑，接受对方的
 *   覆盖       坚持自己的（这一步之后才真的写盘）
 * 只给「覆盖 / 取消」的实现会训练用户闭眼点覆盖，而那正是丢工作的方式。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { NButton, useMessage } from "naive-ui";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { useWorkspaceStore } from "../stores/workspace";

const ws = useWorkspaceStore();
const message = useMessage();

const host = ref<HTMLDivElement | null>(null);
const view = shallowRef<EditorView | null>(null);

const tab = computed(() => ws.activeTab);

/** 未保存圆点。判据是缓冲区与磁盘内容不同，不是「有没有按过键」。 */
function dirtyOf(relativePath: string): boolean {
  const t = ws.tabs.find((x) => x.relativePath === relativePath);
  return !!t && t.content !== t.savedContent;
}

function mountEditor(): void {
  if (!host.value || view.value) return;
  view.value = new EditorView({
    parent: host.value,
    state: buildState(tab.value?.content ?? ""),
  });
}

function buildState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const current = ws.activeTab;
        if (current) current.content = update.state.doc.toString();
      }),
    ],
  });
}

/** 切 tab / 重新载入时整体换文档，而不是 dispatch 一堆增量。 */
function syncDoc(): void {
  const editor = view.value;
  const current = tab.value;
  if (!editor || !current) return;
  if (editor.state.doc.toString() === current.content) return;
  editor.setState(buildState(current.content));
  if (current.gotoLine && current.gotoLine > 0) {
    const line = editor.state.doc.line(Math.min(current.gotoLine, editor.state.doc.lines));
    editor.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    current.gotoLine = null;
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

/**
 * 宿主 div 出现的那一刻才建编辑器。
 *
 * 组件挂载时还**没有**打开任何文件，`<div ref="host">` 在 `v-else` 里根本
 * 没渲染出来 —— 在 onMounted 里 mount 一次就等于永远不 mount：双击文件后
 * tab 出来了、编码/换行也显示了，唯独正文区是空的。typecheck、单测、构建
 * 全绿，只有真机点一遍才看得见。
 */
watch(
  host,
  (el) => {
    if (!el) return;
    mountEditor();
    void nextTick(syncDoc);
  },
  { immediate: true, flush: "post" }
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  view.value?.destroy();
  view.value = null;
});

watch(
  () => [ws.activePath, tab.value?.savedContent] as const,
  () => void nextTick(syncDoc)
);

async function onKeydown(e: KeyboardEvent): Promise<void> {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
  e.preventDefault();
  await save();
}

/**
 * 点「×」关 tab。
 *
 * `closeTab` 对有未保存编辑的 tab 会先问三选一，取消时返回 false 并把
 * tab 原样留下 —— 所以这里除了把保存失败的原因说出来之外无事可做。
 * 包一层是为了不把一个 Promise 直接挂在模板的事件处理器上（拒绝时会变成
 * unhandledrejection，控制台里一片红，用户什么也看不到）。
 */
async function requestClose(relativePath: string): Promise<void> {
  const closed = await ws.closeTab(relativePath);
  if (!closed && ws.saveError) message.error(ws.saveError);
}

async function save(overwrite = false): Promise<void> {
  if (!tab.value) return;
  const result = await ws.saveActive(overwrite);
  if (result === "saved") message.success("已保存");
  else if (result === "error") message.error(ws.saveError || "保存失败");
  // conflict 不弹 toast：下面那块冲突面板本身就是提示，再来一条 toast 只会
  // 把用户的注意力从三个可选动作上引开。
}
</script>

<template>
  <section class="editor-pane">
    <nav class="tabs">
      <button
        v-for="t in ws.tabs"
        :key="t.relativePath"
        class="tab"
        :class="{ active: t.relativePath === ws.activePath }"
        @click="ws.activePath = t.relativePath"
      >
        <span class="tab-name">{{ t.relativePath }}</span>
        <span v-if="dirtyOf(t.relativePath)" class="dot" title="未保存">●</span>
        <span class="close" @click.stop="requestClose(t.relativePath)">×</span>
      </button>
    </nav>

    <div v-if="!tab" class="empty">在左边双击一个文本文件就能开始编辑</div>

    <template v-else>
      <div class="meta">
        <span>{{ tab.encoding }}</span>
        <span>{{ tab.newline === "crlf" ? "CRLF" : "LF" }}</span>
        <span v-if="tab.binary" class="warn">二进制文件，不支持编辑</span>
        <span v-else-if="tab.tooLarge" class="warn">文件过大，不支持编辑</span>
        <span class="spacer" />
        <n-button size="tiny" :disabled="tab.binary || tab.tooLarge" @click="save()">
          保存（Ctrl+S）
        </n-button>
      </div>

      <!--
        冲突面板。出现在这里就意味着**磁盘一个字节都没被写过** ——
        三个动作各自对应一种真实意图，没有默认选中项。
      -->
      <div v-if="tab.conflict" class="conflict">
        <p>
          这个文件在你编辑期间被别的程序改过了。直接保存会盖掉对方的修改，
          所以我先停下来问你。
        </p>
        <div class="conflict-actions">
          <n-button size="tiny" @click="tab.showDiff = !tab.showDiff">查看差异</n-button>
          <n-button size="tiny" @click="ws.reloadActive()">重新载入</n-button>
          <n-button size="tiny" type="warning" @click="save(true)">覆盖</n-button>
        </div>
        <pre v-if="tab.showDiff" class="conflict-diff">{{ tab.conflict.preview }}</pre>
      </div>

      <div ref="host" class="cm-host" />
    </template>
  </section>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  border-top: 1px solid var(--n-border-color, #eee);
}
.tabs {
  display: flex;
  gap: 2px;
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: transparent;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
  max-width: 260px;
}
.tab.active {
  background: rgba(128, 128, 128, 0.16);
}
.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  color: #e08600;
}
.close {
  opacity: 0.5;
}
.meta {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 11px;
  opacity: 0.75;
  padding: 2px 8px;
}
.meta .spacer {
  flex: 1;
}
.meta .warn {
  color: #c62828;
  opacity: 1;
}
.conflict {
  background: #fff4e5;
  border: 1px solid #ffb74d;
  border-radius: 4px;
  margin: 6px 8px;
  padding: 8px;
  font-size: 12px;
  color: #7a4a00;
}
.conflict-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.conflict-diff {
  max-height: 180px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.05);
  padding: 6px;
  margin-top: 8px;
  white-space: pre-wrap;
}
.cm-host {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.empty {
  padding: 24px;
  opacity: 0.6;
  font-size: 13px;
}
</style>
