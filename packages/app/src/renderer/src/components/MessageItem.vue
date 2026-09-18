<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { NAlert, NSpin } from "naive-ui";
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
import { formatDuration } from "../duration";
import { openThinking, thinkingKey } from "../stores/chat-ui";
import ToolActivity from "./ToolActivity.vue";
import { stripPlanInstruction } from "../../../lib/work-mode";
import ArtifactLink from "./ArtifactLink.vue";
import { appLogo } from "../brand";

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
  /** 这一轮回复的起止时刻（见 message-groups.ts），用于「已完成 2m32s」。 */
  startedAt?: number;
  endedAt?: number;
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
/**
 * 把一轮回复拆成「过程」与「回答」。
 *
 * 最后一个 thinking / toolCall 之前的全部内容——思考、中间叙述（「仓库没有
 * 写死…我再核对…」）、工具调用——都是过程，收进一个可折叠组；它之后的文本
 * 才是回答，留在外面。没有任何 thinking / toolCall 的消息不出折叠组。
 */
const processEndIdx = computed(() => {
  let idx = -1;
  blocks.value.forEach((b, i) => {
    if (b.type === "thinking" || b.type === "toolCall") idx = i;
  });
  return idx;
});
const processBlocks = computed(() => blocks.value.slice(0, processEndIdx.value + 1));
const answerBlocks = computed(() => blocks.value.slice(processEndIdx.value + 1));
const hasProcess = computed(() => processBlocks.value.length > 0);
/**
 * 整轮还在流就不能写「已完成」。
 *
 * 早先还加了「回答一个字都没开始」：模型在最后一次工具调用后面先吐一句
 * 过渡（「我再核对…」），过程组立刻收成已完成，顶上却仍在执行。工具失败
 * 后续写时最明显。流式期间标题跟 streaming 走，展开默认只在还没作答时打开。
 */
const processActive = computed(() => props.streaming === true);
const processTitle = computed(() => {
  if (!processActive.value) return "已完成";
  return answerBlocks.value.length > 0 ? "生成中" : "思考中";
});

const errorMessage = computed(
  () => (props.message as AssistantMessage).errorMessage
);
const aborted = computed(
  () => (props.message as AssistantMessage).stopReason === "aborted"
);

/** 「复制这条回复」只复制回答；没有回答（中断 / 出错）时退回全部文本。 */
const assistantText = computed(() => {
  const pick = (list: AssistantContent[]): string =>
    list
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  return pick(answerBlocks.value) || pick(blocks.value);
});

// --- 过程组的开合：进行中默认展开，完成后默认收起；用户点过就只认用户的 ---
const processKey = computed(() => thinkingKey(keyBase.value, "process"));
const processOpen = computed(
  () => openThinking[processKey.value] ?? (processActive.value && answerBlocks.value.length === 0)
);

function toggleProcess(): void {
  openThinking[processKey.value] = !processOpen.value;
}

// --- 过程时长：进行中每秒走一格，完成后钉在 endedAt - startedAt ---
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

function stopTicker(): void {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
}

watch(
  processActive,
  (active) => {
    stopTicker();
    if (!active) return;
    now.value = Date.now();
    ticker = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  },
  { immediate: true }
);
onBeforeUnmount(stopTicker);

const processDuration = computed(() => {
  const start = props.startedAt;
  if (start === undefined) return "";
  const end = processActive.value ? now.value : (props.endedAt ?? start);
  return formatDuration(end - start);
});

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
      <img class="msg-avatar" :src="appLogo" alt="" />
      <div class="msg-body">
        <!--
          过程组：最后一个 thinking / 工具调用之前的一切——思考、中间叙述、
          工具卡片——全在这一个折叠里。进行中默认展开、完成后默认收起。
        -->
        <div v-if="hasProcess" class="process-group" :class="{ active: processActive }">
          <button
            type="button"
            class="process-toggle"
            :aria-expanded="processOpen"
            aria-label="展开或收起思考过程"
            @click="toggleProcess"
          >
            <n-spin v-if="processActive" :size="12" />
            <span class="process-title">{{ processTitle }}</span>
            <span v-if="processDuration" class="process-duration">{{ processDuration }}</span>
            <span class="process-chevron" aria-hidden="true">{{ processOpen ? "⌃" : "⌄" }}</span>
          </button>
          <div v-if="processOpen" class="process-body" role="region">
            <template v-for="(block, i) in processBlocks" :key="i">
              <div v-if="block.type === 'thinking' && block.thinking" class="thinking-content">
                {{ block.thinking }}
              </div>
              <template v-else-if="block.type === 'text' && block.text">
                <div v-if="props.streaming" class="process-text stream-text">{{ block.text }}</div>
                <div
                  v-else
                  class="process-text markdown"
                  v-html="renderMarkdown(truncateToolOutput(block.text))"
                />
              </template>
              <ToolActivity v-else-if="block.type === 'toolCall'" :call="block" />
            </template>
          </div>
        </div>

        <!-- 回答 -->
        <template v-for="(block, i) in answerBlocks" :key="`a${i}`">
          <template v-if="block.type === 'text' && block.text">
            <!--
              流式期间**不进 Markdown**：每帧重新解析一遍越来越长的前缀是
              O(n²)，长回复到后段会把主线程压死。完成的消息才进缓存。
            -->
            <div v-if="props.streaming" class="stream-text">{{ block.text }}</div>
            <div
              v-else
              class="markdown"
              v-html="renderMarkdown(truncateToolOutput(block.text))"
            />
          </template>
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
.stream-text {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
