<script setup lang="ts">
import { computed } from "vue";
import { NSpin } from "naive-ui";
import type { ToolCallContent } from "@sdk";
import { describeTool } from "../friendly";
import { useAppStore } from "../stores/app";
import { expandedTools } from "../stores/chat-ui";

const props = defineProps<{ call: ToolCallContent }>();
const store = useAppStore();

/**
 * 展开态放在 store 里，key 是 toolCallId。
 *
 * 早先是组件内的 `ref(false)`：分段数据源回收并重建组件实例时，用户展开过
 * 的工具输出会自己收起来，而且不报任何错。
 */
const expanded = computed({
  get: () => expandedTools[props.call.id] === true,
  set: (v: boolean) => {
    expandedTools[props.call.id] = v;
  },
});

const run = computed(() => store.toolRuns[props.call.id]);
/**
 * 「查不到这次工具运行」与「正在运行」是两件事。
 *
 * 把「查不到」并进「运行中」的后果是：历史会话里没有 tool_execution 事件、
 * toolRuns 恒为空，于是每张工具卡片都永久转圈 —— 界面看上去像卡死了，
 * 而实际上只是记录不在内存里。
 */
const missing = computed(() => !run.value);
const running = computed(() => run.value?.status === "running");

const label = computed(() => describeTool(props.call.name, props.call.arguments ?? {}));

const argsPreview = computed(() => {
  const args = props.call.arguments ?? {};
  if (typeof args.command === "string") return args.command;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
});

// 工具输出可能有几百 KB，全量渲染会卡住主线程，只展示末尾部分
const outputPreview = computed(() => {
  const output = run.value?.output ?? "";
  if (output.length <= 4000) return output;
  return `…（内容较长，已省略前 ${output.length - 4000} 个字符）\n${output.slice(-4000)}`;
});
</script>

<template>
  <div>
    <button
      type="button"
      class="tool-chip"
      :aria-expanded="expanded"
      aria-label="展开或收起工具详情"
      @click="expanded = !expanded"
    >
      <span>{{ label.icon }}</span>
      <span>{{ label.title }}</span>
      <span v-if="label.detail" class="detail">{{ label.detail }}</span>
      <span v-if="missing" class="state-missing">工具记录已不可用</span>
      <n-spin v-else-if="running" :size="14" />
      <span v-else-if="run.status === 'done'" class="state-done">✓</span>
      <span v-else class="state-error">✗ 失败</span>
    </button>
    <div v-if="expanded" class="tool-expand" role="region">
      <div style="color: #8a8f98">做了什么：</div>
      <pre>{{ argsPreview }}</pre>
      <div v-if="missing" style="color: #8a8f98; margin-top: 8px">
        这次运行的结果没有留在本次会话里，无法展示。
      </div>
      <template v-else-if="run.output">
        <div style="color: #8a8f98; margin-top: 8px">结果：</div>
        <pre>{{ outputPreview }}</pre>
      </template>
      <img
        v-for="(img, i) in run?.images ?? []"
        :key="i"
        :src="`data:${img.mimeType};base64,${img.data}`"
        alt="工具输出图片"
      />
    </div>
  </div>
</template>

<style scoped>
.tool-chip {
  background: none;
  border: none;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.state-missing {
  color: #9ca3af;
  font-size: 12px;
}
</style>
