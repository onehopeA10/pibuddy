<script setup lang="ts">
/**
 * 消息里的一条产物链接（ART-102 的核心不变量）。
 *
 * 组件的 props 里**没有路径字段**，只有 `artifactId` 与 `version`：
 * 文件被挪走、被重命名、上面又生成了三个新版本，这条链接照样解析得到
 * 当时那一版 —— 因为解析走的是 artifacts 表，一个字节的路径信息都没用到。
 *
 * 产物在回收站里时不显示成一个死链，而是给出「点击恢复」——「我明明
 * 让它做了个文件，现在点开什么都没有」是最让人不知所措的一种失败。
 */
import { computed, onMounted, ref } from "vue";
import { NButton, NTag } from "naive-ui";
import type { ArtifactRecord } from "@contract";
import { useAppStore } from "../stores/app";
import { useArtifactsStore } from "../stores/artifacts";
import { useChatArtifactsStore } from "../stores/chat-artifacts";

const props = defineProps<{
  artifactId: string;
  version: number;
  /** 生成当时的显示名，作为解析失败时的兜底文案 */
  name?: string;
}>();

const app = useAppStore();
const store = useArtifactsStore();
const chatArtifacts = useChatArtifactsStore();

const record = ref<ArtifactRecord | null>(null);
const pendingChangeId = ref<string | null>(null);
const reviewError = ref("");
const reviewing = ref(false);
const missing = ref(false);

const trashed = computed(() => record.value?.status === "trashed");
/**
 * 还没解析出结果，且不是「确认找不到」。
 *
 * 必须与 missing 分开：把「还没解析完」画成正常链接的话，用户在那一
 * 瞬间点下去会打开一个不存在的东西；画成「找不到」又会在每次打开
 * 会话时闪一下红字。
 */
const pending = computed(() => !missing.value && record.value === null);
const label = computed(() => record.value?.name ?? props.name ?? "产物");

async function resolve(): Promise<void> {
  const workspaceId = app.workspaceId;
  // 没有工作区就没有产物库可查。这是「解析不出来」而不是「还在解析」。
  if (!workspaceId) {
    missing.value = true;
    return;
  }
  try {
    // 同一会话里的链接共用一轮查询。切会话时绝不能每条消息各扫一遍产物表。
    const sessionId = app.switchingSessionId || app.currentSessionId || undefined;
    await chatArtifacts.ensureResolved(workspaceId, sessionId);
    const hit = chatArtifacts.resolveRecord(props.artifactId, props.version);
    if (!hit) {
      missing.value = true;
      return;
    }
    record.value = hit;
    pendingChangeId.value = chatArtifacts.pendingChangeIdFor(hit);
  } catch {
    missing.value = true;
  }
}

onMounted(() => void resolve());

function open(): void {
  if (!record.value) return;
  void store.preview({
    workspaceId: record.value.workspaceId,
    relativePath: record.value.exportPath,
    artifactId: record.value.id,
  });
  store.panelOpen = false;
}

async function restore(): Promise<void> {
  if (!record.value) return;
  await store.restore(record.value.workspaceId, record.value.id);
  chatArtifacts.invalidateRecords();
  await resolve();
}

function reviewFailMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/conflict|hash|mismatch/i.test(raw)) return "这份后来又被动过，没法替你退回。";
  return raw || "这次没办成，按钮还在，可以再试。";
}

async function acceptChange(): Promise<void> {
  const id = pendingChangeId.value;
  if (!id || !window.piBuddy.workspace?.acceptChange || reviewing.value) return;
  reviewing.value = true;
  reviewError.value = "";
  try {
    const result = await window.piBuddy.workspace.acceptChange(id);
    if (!result?.ok) {
      reviewError.value = reviewFailMessage(result?.message ?? "这次没办成");
      return;
    }
    pendingChangeId.value = null;
  } catch (err) {
    reviewError.value = reviewFailMessage(err);
  } finally {
    reviewing.value = false;
  }
}

async function rejectChange(): Promise<void> {
  const id = pendingChangeId.value;
  if (!id || !window.piBuddy.workspace?.rejectChange || reviewing.value) return;
  reviewing.value = true;
  reviewError.value = "";
  try {
    const result = await window.piBuddy.workspace.rejectChange(id);
    if (!result.ok) {
      reviewError.value = reviewFailMessage(result.message ?? result.errorCode ?? "这次没办成");
      return;
    }
    pendingChangeId.value = null;
  } catch (err) {
    reviewError.value = reviewFailMessage(err);
  } finally {
    reviewing.value = false;
  }
}
</script>

<template>
  <span class="artifact-link">
    <template v-if="missing">
      <n-tag size="small" type="warning">找不到这个产物（{{ label }}）</n-tag>
    </template>
    <template v-else-if="pending">
      <n-tag size="small">读取产物中…</n-tag>
    </template>
    <template v-else-if="trashed">
      📄 {{ label }}
      <n-tag size="small">v{{ props.version }}</n-tag>
      <n-button size="tiny" quaternary aria-label="恢复这个产物" @click="restore">
        已移入回收站，点击恢复
      </n-button>
    </template>
    <template v-else>
      <n-button
        size="tiny"
        quaternary
        :aria-label="`打开产物 ${label} 的第 ${props.version} 版`"
        @click="open"
      >
        📄 {{ label }}
      </n-button>
      <n-tag size="small">v{{ props.version }}</n-tag>
      <n-tag v-if="record?.status === 'generating'" size="small" type="info">生成中</n-tag>
      <n-tag v-else-if="record?.status === 'failed'" size="small" type="error">生成失败</n-tag>
      <n-tag v-else-if="record?.status === 'conflicted'" size="small" type="warning">
        已被外部改动
      </n-tag>
      <template v-if="pendingChangeId">
        <n-button
          size="tiny"
          type="primary"
          secondary
          :loading="reviewing"
          aria-label="留下这份改动"
          @click="acceptChange"
        >
          留下这份
        </n-button>
        <n-button
          size="tiny"
          quaternary
          :disabled="reviewing"
          aria-label="退回这次改动"
          @click="rejectChange"
        >
          退回这次
        </n-button>
      </template>
      <n-tag v-if="reviewError" size="small" type="error">{{ reviewError }}</n-tag>
    </template>
  </span>
</template>

<style scoped>
.artifact-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0;
}
</style>
