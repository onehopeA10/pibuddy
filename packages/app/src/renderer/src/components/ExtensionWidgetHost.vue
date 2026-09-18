<script setup lang="ts">
/**
 * 扩展 widget 的渲染区（rpc.md:1275 setWidget）。
 *
 * widget 是扩展贴在输入框上方/下方的一块**纯文本行**。改造前这个 method
 * 落进 `default: break` 被静默丢弃 —— 它是 fire-and-forget，丢了不会挂起
 * 任何东西，所以既不报错也不失败，只是扩展写出来的东西永远显示不出来。
 *
 * 两处约束是这个组件存在的理由：
 *
 *  - **高度上限 30vh**。widgetLines 的长度完全由扩展决定，一个循环里
 *    push 一千行的扩展会把输入框整个挤出屏幕。超出部分滚动，而不是撑高
 *    整个输入区。
 *  - **稳定 key**。widgetKey 是扩展给的标识，同 key 覆盖、缺 lines 即删。
 *    用数组下标当 key 会让「删掉第一个」表现为「所有内容往上串一格」。
 *
 * 与弹窗同一条纪律：纯文本插值，没有 v-html。
 */
import { computed } from "vue";
import { useExtensionUiStore } from "../stores/extensionUi";

const props = defineProps<{ placement: "aboveEditor" | "belowEditor" }>();

const extUi = useExtensionUiStore();
const widgets = computed(() =>
  props.placement === "aboveEditor" ? extUi.aboveEditorWidgets : extUi.belowEditorWidgets
);
</script>

<template>
  <div v-if="widgets.length > 0" class="widget-host">
    <section v-for="w in widgets" :key="w.key" class="widget" :aria-label="`扩展面板 ${w.key}`">
      <div v-for="(line, i) in w.lines" :key="i" class="widget-line">{{ line }}</div>
    </section>
  </div>
</template>

<style scoped>
.widget-host {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 16px;
}
/* 30vh 是单个 widget 的高度上限：超出滚动，不撑高输入区 */
.widget {
  max-height: 30vh;
  overflow-y: auto;
  padding: 6px 10px;
  border: 1px solid var(--pb-border, var(--border-subtle));
  border-radius: var(--radius-m);
  background: var(--pb-widget-bg, var(--bg-hover));
  font-size: 12px;
  line-height: 1.6;
}
.widget-line {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--pb-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
}
</style>
