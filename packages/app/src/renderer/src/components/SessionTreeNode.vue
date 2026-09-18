<script setup lang="ts">
/**
 * 会话树的一个节点（SVG 呈现）。
 *
 * 纯呈现组件：位置、选中态、可分叉态全由父组件算好传进来，它只负责画一个
 * 圆点 + 一段截断文本，并把点击冒泡上去。节点数由主进程的性能截断兜底
 * （SESSION_TREE_NODE_CAP），因此这里用「一个节点一个组件」不会在几千节点上
 * 失控——超出上限的分支根本不会下发到渲染侧。
 */
import { computed } from "vue";
import type { SessionTreeNode } from "@contract";

const props = defineProps<{
  node: SessionTreeNode;
  x: number;
  y: number;
  selected: boolean;
  forkable: boolean;
}>();

const emit = defineEmits<{ (e: "select", id: string): void }>();

/** 不同类型给不同颜色：一眼区分 user / assistant / 压缩 / 模型变化。 */
const FILL: Record<SessionTreeNode["kind"], string> = {
  user: "var(--status-info)",
  assistant: "var(--status-success)",
  compaction: "var(--accent)",
  "model-change": "var(--status-warning)",
  session: "var(--text-tertiary)",
  other: "var(--text-secondary)",
};

const fill = computed(() => FILL[props.node.kind]);
/** 当前叶子的半径大一点、描边更重，一眼看到「我在这」。 */
const radius = computed(() => (props.node.current ? 9 : 6));
const label = computed(() => {
  const text = props.node.preview.trim();
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
});
</script>

<template>
  <g
    class="tree-node"
    :class="{ selected, current: node.current, forkable }"
    :transform="`translate(${x}, ${y})`"
    role="button"
    tabindex="0"
    :aria-label="`${node.kind} ${label}`"
    @click="emit('select', node.id)"
    @keydown.enter="emit('select', node.id)"
  >
    <!-- 分支点用一圈外环标出（该节点下有多条分支） -->
    <circle v-if="node.branchPoint" class="branch-ring" :r="radius + 4" />
    <circle
      class="dot"
      :r="radius"
      :fill="fill"
      :stroke="selected ? 'var(--bg-app)' : node.current ? fill : 'var(--text-on-accent)'"
      :stroke-width="selected ? 3 : 2"
    />
    <!-- 可分叉的 user 消息加一个小三角提示 -->
    <text v-if="forkable" class="fork-mark" x="0" :y="-radius - 6" text-anchor="middle">⑂</text>
    <text class="label" :x="radius + 6" y="4">{{ label }}</text>
  </g>
</template>

<style scoped>
.tree-node {
  cursor: pointer;
}
.tree-node:focus {
  outline: none;
}
.dot {
  transition: r 0.1s ease;
}
.branch-ring {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 1.5;
  stroke-dasharray: 3 2;
}
.label {
  font-size: var(--font-ui-12);
  fill: var(--text-secondary);
  pointer-events: none;
  user-select: none;
}
.tree-node.selected .label {
  fill: var(--text-primary);
  font-weight: 600;
}
.fork-mark {
  font-size: var(--font-ui-11);
  fill: var(--status-info);
  pointer-events: none;
}
</style>
