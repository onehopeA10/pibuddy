<script setup lang="ts">
import { computed } from "vue";
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
import { openThinking, thinkingKey } from "../stores/chat-ui";
import ToolActivity from "./ToolActivity.vue";

const props = defineProps<{
  message: AgentMessage;
  streaming?: boolean;
  /** 消息在列表中的稳定 key；展开态按它归一化到 store。 */
  messageKey?: number | string;
}>();

const emit = defineEmits<{
  (e: "resend", text: string): void;
  (e: "fork"): void;
}>();

const role = computed(() => props.message.role);
/** liveAssistant 没有列表 key，用一个固定值即可（同时只有一条）。 */
const keyBase = computed(() => props.messageKey ?? "live");

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

/** 助手正文的纯文本，供「复制」使用。 */
const assistantText = computed(() =>
  blocks.value
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n")
);

function toggleThinking(index: number): void {
  const key = thinkingKey(keyBase.value, index);
  openThinking[key] = !openThinking[key];
}

function isThinkingOpen(index: number): boolean {
  return openThinking[thinkingKey(keyBase.value, index)] === true;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板被系统策略拒绝时静默失败：这里弹错比复制失败本身更打扰。
  }
}
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
    <div class="msg-actions">
      <button type="button" aria-label="复制这条消息" @click="copyText(userText)">复制</button>
      <button type="button" aria-label="重新发送这条消息" @click="emit('resend', userText)">
        重新发送
      </button>
      <button type="button" aria-label="从这条消息分叉" @click="emit('fork')">分叉</button>
    </div>
  </div>

  <!-- 助手 -->
  <div v-else-if="role === 'assistant'" class="msg-row">
    <div class="msg-assistant">
      <div class="msg-avatar">π</div>
      <div class="msg-body">
        <template v-for="(block, i) in blocks" :key="i">
          <div v-if="block.type === 'thinking' && block.thinking" class="thinking-block">
            <button
              type="button"
              class="thinking-toggle"
              :aria-expanded="isThinkingOpen(i)"
              aria-label="展开或收起思考过程"
              @click="toggleThinking(i)"
            >
              💭 思考过程 {{ isThinkingOpen(i) ? "▲" : "▼" }}
            </button>
            <div v-if="isThinkingOpen(i)" class="thinking-content" role="region">
              {{ block.thinking }}
            </div>
          </div>

          <template v-else-if="block.type === 'text' && block.text">
            <!--
              流式期间**不进 Markdown**：每帧重新解析一遍越来越长的前缀是
              O(n²)，长回复到后段会把主线程压死。完成的消息才进缓存。
            -->
            <div v-if="props.streaming" class="stream-text">{{ block.text }}</div>
            <div
              v-else-if="!props.streaming"
              class="markdown"
              v-html="renderMarkdown(truncateToolOutput(block.text))"
            />
          </template>

          <ToolActivity v-else-if="block.type === 'toolCall'" :call="block" />
        </template>

        <n-alert
          v-if="errorMessage"
          type="error"
          :show-icon="true"
          style="margin-top: 8px"
          title="出错了"
        >
          <details>
            <summary aria-label="展开错误详情">出了点问题，点这里看详细原因</summary>
            <pre>{{ errorMessage }}</pre>
          </details>
        </n-alert>
        <div
          v-else-if="aborted"
          style="color: #9ca3af; font-size: 12.5px; margin-top: 6px"
        >
          ⏹ 已按你的要求停止
        </div>

        <div v-if="!props.streaming" class="msg-actions">
          <button
            type="button"
            aria-label="复制这条回复"
            @click="copyText(assistantText)"
          >
            复制
          </button>
          <button type="button" aria-label="从这条消息分叉" @click="emit('fork')">
            分叉
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.msg-actions button {
  background: none;
  border: none;
  color: #8a8f98;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
}
.msg-actions button:hover,
.msg-actions button:focus-visible {
  color: #4b5563;
  text-decoration: underline;
}
.thinking-toggle {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.stream-text {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
