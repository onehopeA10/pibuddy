<script setup lang="ts">
import { computed, ref } from "vue";
import { NSpin } from "naive-ui";
import type { ToolCallContent } from "@sdk";
import { describeTool } from "../friendly";
import { useAppStore } from "../stores/app";

const props = defineProps<{ call: ToolCallContent }>();
const store = useAppStore();
const expanded = ref(false);

const run = computed(() => store.toolRuns[props.call.id]);
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
    <div class="tool-chip" @click="expanded = !expanded">
      <span>{{ label.icon }}</span>
      <span>{{ label.title }}</span>
      <span v-if="label.detail" class="detail">{{ label.detail }}</span>
      <n-spin v-if="!run || run.status === 'running'" :size="14" />
      <span v-else-if="run.status === 'done'" class="state-done">✓</span>
      <span v-else class="state-error">✗ 失败</span>
    </div>
    <div v-if="expanded" class="tool-expand">
      <div style="color: #8a8f98">做了什么：</div>
      <pre>{{ argsPreview }}</pre>
      <template v-if="run && run.output">
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
