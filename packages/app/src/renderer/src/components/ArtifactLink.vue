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

const props = defineProps<{
  artifactId: string;
  version: number;
  /** 生成当时的显示名，作为解析失败时的兜底文案 */
  name?: string;
}>();

const app = useAppStore();
const store = useArtifactsStore();

const record = ref<ArtifactRecord | null>(null);
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
    // 用 artifactId 精确定位，再在版本链里挑出消息当时引用的那一版。
    const page = await window.piBuddy.artifacts.query({ workspaceId, limit: 1000 });
    const trash = await window.piBuddy.artifacts.query({
      workspaceId,
      trashed: true,
      limit: 1000,
    });
    const all = [...page.items, ...trash.items];
    const anchor = all.find((a) => a.id === props.artifactId);
    if (!anchor) {
      missing.value = true;
      return;
    }
    record.value =
      all.find(
        (a) =>
          a.logicalKey === anchor.logicalKey &&
          a.workspaceId === anchor.workspaceId &&
          a.version === props.version
      ) ?? anchor;
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
  });
  store.panelOpen = false;
}

async function restore(): Promise<void> {
  if (!record.value) return;
  await store.restore(record.value.workspaceId, record.value.id);
  await resolve();
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
