<script setup lang="ts">
/**
 * Git 面板（coding.git / GIT-101）。
 *
 * 存在的理由：让「用 git」这件事不必打开终端，同时**每一个写动作都经主进程
 * 的 process.git 授权**——面板本身只是发意图，未授权时主进程第五道闸会挡下，
 * 面板据此弹出「去授权」。diff 复用变更审阅的逐行 hunk 渲染（同一套 review
 * 原语），不另造。
 *
 * 危险类（force push / reset --hard / branch -D）本批不提供，见 FEAT-git.md。
 */
import { computed, onMounted, ref, watch } from "vue";
import { NButton, NInput, NTag } from "naive-ui";
import { useAppStore } from "../stores/app";
import { useGitStore } from "../stores/git";
import { usePermissionStore } from "../stores/permission";

const app = useAppStore();
const git = useGitStore();
const permission = usePermissionStore();

const workspaceId = computed(() => app.workspaceId);
const commitMessage = ref("");
const newBranch = ref("");
/** 展开了 diff 的文件 key（`${staged}:${path}`）。 */
const openDiffs = ref<string[]>([]);

function diffKey(path: string, staged: boolean): string {
  return `${staged}:${path}`;
}

async function toggleDiff(path: string, staged: boolean): Promise<void> {
  const key = diffKey(path, staged);
  if (openDiffs.value.includes(key)) {
    openDiffs.value = openDiffs.value.filter((k) => k !== key);
    return;
  }
  openDiffs.value = [...openDiffs.value, key];
  if (workspaceId.value) await git.loadDiff(workspaceId.value, path, staged);
}

function isDiffOpen(path: string, staged: boolean): boolean {
  return openDiffs.value.includes(diffKey(path, staged));
}

async function doCommit(): Promise<void> {
  if (!workspaceId.value || commitMessage.value.trim().length === 0) return;
  const ok = await git.commit(workspaceId.value, commitMessage.value);
  if (ok) commitMessage.value = "";
}

async function doCreateBranch(): Promise<void> {
  if (!workspaceId.value || newBranch.value.trim().length === 0) return;
  const ok = await git.branchCreate(workspaceId.value, newBranch.value.trim());
  if (ok) newBranch.value = "";
}

/** 用户在授权弹窗上点了「允许」之后，重新拉一次状态。 */
async function grantAndRetry(): Promise<void> {
  permission.request({ capabilityId: "coding.git", permission: "process.git", resource: null });
  if (workspaceId.value) await git.refresh(workspaceId.value);
}

onMounted(() => {
  if (workspaceId.value) void git.refresh(workspaceId.value);
});
watch(workspaceId, (id) => {
  if (id) void git.refresh(id);
});
</script>

<template>
  <section class="git-panel">
    <header>
      <strong>Git</strong>
      <n-tag v-if="git.isRepo && git.branch" size="small" type="info">🌿 {{ git.branch }}</n-tag>
      <n-tag v-else-if="git.detached" size="small" type="warning">detached HEAD</n-tag>
      <span class="spacer" />
      <n-button size="tiny" :loading="git.busy" @click="workspaceId && git.refresh(workspaceId)">
        刷新
      </n-button>
    </header>

    <p v-if="git.needsPermission" class="notice">
      Git 操作需要授权（process.git）。
      <n-button size="tiny" type="primary" @click="grantAndRetry">去授权</n-button>
    </p>
    <p v-if="git.lastError" class="error">{{ git.lastError }}</p>

    <p v-if="!git.isRepo && !git.needsPermission" class="empty">
      这个文件夹还不是 git 仓库。
    </p>

    <template v-if="git.isRepo">
      <!-- 已暂存 -->
      <div v-if="git.staged.length > 0" class="group">
        <div class="group-head">已暂存（{{ git.staged.length }}）</div>
        <ul class="list">
          <li v-for="e in git.staged" :key="`s-${e.relativePath}`" class="item">
            <div class="row">
              <span class="code">{{ e.x }}{{ e.y }}</span>
              <span class="path" @click="toggleDiff(e.relativePath, true)">{{ e.relativePath }}</span>
              <n-button size="tiny" quaternary @click="workspaceId && git.unstage(workspaceId, e.relativePath)">
                取消暂存
              </n-button>
            </div>
            <div v-if="isDiffOpen(e.relativePath, true)" class="detail">
              <p v-if="git.diffFor(e.relativePath, true)?.degraded" class="degraded">
                {{ git.diffFor(e.relativePath, true)?.degraded }}
              </p>
              <template v-for="hunk in git.diffFor(e.relativePath, true)?.hunks ?? []" :key="hunk.index">
                <pre v-for="(l, i) in hunk.beforeLines" :key="`d${i}`" class="del">- {{ l }}</pre>
                <pre v-for="(l, i) in hunk.afterLines" :key="`a${i}`" class="add">+ {{ l }}</pre>
              </template>
            </div>
          </li>
        </ul>
      </div>

      <!-- 未暂存 / 未跟踪 -->
      <div class="group">
        <div class="group-head">改动（{{ git.unstaged.length }}）</div>
        <p v-if="git.unstaged.length === 0" class="empty">工作树干净。</p>
        <ul class="list">
          <li v-for="e in git.unstaged" :key="`u-${e.relativePath}`" class="item">
            <div class="row">
              <span class="code">{{ e.x }}{{ e.y }}</span>
              <span class="path" @click="toggleDiff(e.relativePath, false)">{{ e.relativePath }}</span>
              <n-button size="tiny" quaternary @click="workspaceId && git.stage(workspaceId, e.relativePath)">
                暂存
              </n-button>
              <n-button
                v-if="!e.untracked"
                size="tiny"
                quaternary
                @click="workspaceId && git.revert(workspaceId, e.relativePath)"
              >
                回退
              </n-button>
            </div>
            <div v-if="isDiffOpen(e.relativePath, false)" class="detail">
              <p v-if="git.diffFor(e.relativePath, false)?.degraded" class="degraded">
                {{ git.diffFor(e.relativePath, false)?.degraded }}
              </p>
              <template v-for="hunk in git.diffFor(e.relativePath, false)?.hunks ?? []" :key="hunk.index">
                <pre v-for="(l, i) in hunk.beforeLines" :key="`d${i}`" class="del">- {{ l }}</pre>
                <pre v-for="(l, i) in hunk.afterLines" :key="`a${i}`" class="add">+ {{ l }}</pre>
              </template>
            </div>
          </li>
        </ul>
      </div>

      <!-- 提交 -->
      <div class="group commit">
        <n-input
          v-model:value="commitMessage"
          type="textarea"
          size="small"
          :autosize="{ minRows: 1, maxRows: 3 }"
          placeholder="提交信息"
        />
        <n-button
          size="small"
          type="primary"
          :disabled="git.staged.length === 0 || commitMessage.trim().length === 0"
          @click="doCommit"
        >
          提交已暂存（{{ git.staged.length }}）
        </n-button>
      </div>

      <!-- 分支 -->
      <div class="group branches">
        <div class="group-head">分支</div>
        <div class="branch-row">
          <n-button
            v-for="b in git.branches"
            :key="b"
            size="tiny"
            :type="b === git.branch ? 'primary' : 'default'"
            quaternary
            :disabled="b === git.branch"
            @click="workspaceId && git.branchSwitch(workspaceId, b)"
          >
            {{ b }}
          </n-button>
        </div>
        <div class="branch-row">
          <n-input v-model:value="newBranch" size="tiny" placeholder="新分支名" />
          <n-button size="tiny" :disabled="newBranch.trim().length === 0" @click="doCreateBranch">
            创建分支
          </n-button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.git-panel {
  border-top: 1px solid var(--n-border-color, #eee);
  padding: 8px;
  max-height: 360px;
  overflow: auto;
}
header {
  display: flex;
  gap: 8px;
  align-items: center;
}
header .spacer {
  flex: 1;
}
.notice {
  background: #fff4e5;
  border: 1px solid #ffb74d;
  color: #7a4a00;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.error {
  color: #c62828;
  font-size: 12px;
}
.empty {
  opacity: 0.6;
  font-size: 12px;
}
.group {
  margin-top: 8px;
}
.group-head {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
  margin-bottom: 4px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.item {
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
  font-size: 12px;
}
.row .path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.code {
  font-family: monospace;
  opacity: 0.7;
  white-space: pre;
}
.detail {
  padding: 4px 0 8px;
}
.degraded {
  font-size: 12px;
  color: #b06000;
}
.commit {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.commit :deep(.n-input) {
  flex: 1;
}
.branch-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
pre {
  margin: 0;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
pre.del {
  background: rgba(198, 40, 40, 0.12);
}
pre.add {
  background: rgba(47, 125, 49, 0.12);
}
</style>
