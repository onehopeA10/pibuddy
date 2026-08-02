<script setup lang="ts">
import { computed, ref } from "vue";
import { NAlert } from "naive-ui";
import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  ImageContent,
  TextContent,
  UserMessage,
} from "@sdk";
import { renderMarkdown, truncateToolOutput } from "../markdown";
import ToolActivity from "./ToolActivity.vue";

const props = defineProps<{
  message: AgentMessage;
  streaming?: boolean;
}>();

const role = computed(() => props.message.role);

// --- 用户消息 ---
const userText = computed(() => {
  const m = props.message as UserMessage;
  if (typeof m.content === "string") return m.content;
  return (m.content ?? [])
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
});
const userImages = computed(() => {
  const m = props.message as UserMessage;
  if (typeof m.content === "string") return [];
  return (m.content ?? []).filter((b): b is ImageContent => b.type === "image");
});

// --- 助手消息 ---
const blocks = computed<AssistantContent[]>(
  () => (props.message as AssistantMessage).content ?? []
);
const errorMessage = computed(
  () => (props.message as AssistantMessage).errorMessage
);
const aborted = computed(
  () => (props.message as AssistantMessage).stopReason === "aborted"
);

const openThinking = ref<Record<number, boolean>>({});
</script>

<template>
  <!-- 用户 -->
  <div v-if="role === 'user'" class="msg-row user">
    <div class="msg-user-bubble">
      <template v-if="userText">{{ userText }}</template>
      <img
        v-for="(img, i) in userImages"
        :key="i"
        :src="`data:${img.mimeType};base64,${img.data}`"
        alt="图片附件"
      />
    </div>
  </div>

  <!-- 助手 -->
  <div v-else-if="role === 'assistant'" class="msg-row">
    <div class="msg-assistant">
      <div class="msg-avatar">π</div>
      <div class="msg-body">
        <template v-for="(block, i) in blocks" :key="i">
          <div v-if="block.type === 'thinking' && block.thinking" class="thinking-block">
            <div class="thinking-toggle" @click="openThinking[i] = !openThinking[i]">
              💭 思考过程 {{ openThinking[i] ? "▲" : "▼" }}
            </div>
            <div v-if="openThinking[i]" class="thinking-content">{{ block.thinking }}</div>
          </div>

          <div
            v-else-if="block.type === 'text' && block.text"
            class="markdown"
            v-html="renderMarkdown(truncateToolOutput(block.text))"
          />

          <ToolActivity v-else-if="block.type === 'toolCall'" :call="block" />
        </template>

        <n-alert
          v-if="errorMessage"
          type="error"
          :show-icon="true"
          style="margin-top: 8px"
          title="出错了"
        >
          {{ errorMessage }}
        </n-alert>
        <div
          v-else-if="aborted"
          style="color: #9ca3af; font-size: 12.5px; margin-top: 6px"
        >
          ⏹ 已按你的要求停止
        </div>
      </div>
    </div>
  </div>
</template>
