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
import type { ArtifactLink as ArtifactLinkRef } from "@contract";
import { renderMarkdown, truncateToolOutput } from "../markdown";
import { openThinking, thinkingKey } from "../stores/chat-ui";
import ToolActivity from "./ToolActivity.vue";
import { stripPlanInstruction } from "../../../lib/work-mode";
import ArtifactLink from "./ArtifactLink.vue";

const props = defineProps<{
  message: AgentMessage;
  streaming?: boolean;
  /** 消息在列表中的稳定 key；展开态按它归一化到 store。 */
  messageKey?: number | string;
  /**
   * 这条消息产出的产物（ART-102）。
   *
   * 每一项只有 artifactId + version + 显示名，**没有路径** —— 于是
   * 「消息里存了个会失效的路径」在类型层就表达不出来。文件后来被挪到
   * 哪里、被重命名成什么，这条链接照样解析得到当时那一版。
   */
  artifacts?: ArtifactLinkRef[];
}>();

const emit = defineEmits<{
  (e: "resend", text: string): void;
}>();

const role = computed(() => props.message.role);
/** liveAssistant 没有列表 key，用一个固定值即可（同时只有一条）。 */
const keyBase = computed(() => props.messageKey ?? "live");

// --- 用户消息 ---
const userText = computed(() => {
  const m = props.message as UserMessage;
  const raw =
    typeof m.content === "string"
      ? m.content
      : (m.content ?? [])
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");
  return stripPlanInstruction(raw);
});
const userImages = computed(() => {
  const m = props.message as UserMessage;
  if (typeof m.content === "string") return [];
  return (m.content ?? []).filter(
    (b): b is ImageContent =>
      b.type === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(b.mimeType)
  );
});

// --- 助手消息 ---
const blocks = computed<AssistantContent[]>(() => {
  const raw = (props.message as AssistantMessage).content ?? [];
  // 相邻的同类块在展示层合并成一块：有的模型会把一段思考拆成很多个
  // thinking 块推上来，原样渲染就是一屏「思考过程」条。只动展示，不动数据。
  const merged: AssistantContent[] = [];
  for (const block of raw) {
    const prev = merged[merged.length - 1];
    if (block.type === "thinking" && prev?.type === "thinking") {
      merged[merged.length - 1] = {
        type: "thinking",
        thinking: (prev.thinking ?? "") + (block.thinking ?? ""),
      };
    } else if (block.type === "text" && prev?.type === "text") {
      merged[merged.length - 1] = { type: "text", text: (prev.text ?? "") + (block.text ?? "") };
    } else {
      merged.push(block);
    }
  }
  return merged;
});
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
    <div class="msg-actions user-actions">
      <button
        type="button"
        aria-label="复制这条消息"
        title="复制"
        @click="copyText(userText)"
      >
        <span aria-hidden="true">⧉</span>
      </button>
      <button
        type="button"
        aria-label="重新发送这条消息"
        title="重新发送"
        @click="emit('resend', userText)"
      >
        <span aria-hidden="true">↻</span>
      </button>
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
              思考过程 {{ isThinkingOpen(i) ? "收起" : "展开" }}
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

        <!-- 工具生成的文件：渲染成产物链接而不是一行路径文本 -->
        <div v-if="(props.artifacts?.length ?? 0) > 0" class="artifact-row">
          <ArtifactLink
            v-for="link in props.artifacts"
            :key="`${link.artifactId}@${link.version}`"
            :artifact-id="link.artifactId"
            :version="link.version"
            :name="link.name"
          />
        </div>

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
          style="color: var(--text-tertiary); font-size: 12px; margin-top: 6px"
        >
          已按你的要求停止
        </div>

        <div v-if="!props.streaming" class="msg-actions">
          <button
            type="button"
            aria-label="复制这条回复"
            title="复制"
            @click="copyText(assistantText)"
          >
            <span aria-hidden="true">⧉</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.artifact-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}
.msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 28px;
  margin-top: 3px;
}
.user-actions {
  justify-content: flex-end;
}
.msg-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-tertiary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.msg-actions button:hover,
.msg-actions button:focus-visible {
  background: var(--bg-hover);
  color: var(--text-primary);
  outline: none;
}
.msg-actions button:focus-visible {
  box-shadow: 0 0 0 1px var(--accent);
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
