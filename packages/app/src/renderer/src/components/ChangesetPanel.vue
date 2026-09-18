<script setup lang="ts">
/**
 * Agent 变更审阅面板（FS-102）。
 *
 * 这个面板存在的唯一理由是：让「Agent 改了我的文件」这件事从一个事后
 * 才发现的意外，变成一个用户点头之后才发生的动作。因此：
 *   - 每条变更都能看到逐行 diff，可以整文件接受，也可以只接受某几段；
 *   - 拒绝**不写盘**（磁盘上此刻是什么就还是什么）；
 *   - 没抓到改动前快照的条目标成「需人工确认」，批量接受会跳过它们并
 *     在提示里点名 —— 静默跳过和静默接受一样糟；
 *   - 二进制 / 超大文件明确降级成摘要，而不是渲染一屏乱码。
 */
import { computed, ref } from "vue";
import { NButton, NTag } from "naive-ui";
import { useWorkspaceStore } from "../stores/workspace";

const ws = useWorkspaceStore();

/** 展开了 diff 的变更 id。 */
const open = ref<string[]>([]);
/** `${changeId}:${hunkIndex}` → 选中。逐 hunk 接受靠它。 */
const pickedHunks = ref<string[]>([]);

function toggleOpen(id: string): void {
  open.value = open.value.includes(id) ? open.value.filter((x) => x !== id) : [...open.value, id];
}

function isOpen(id: string): boolean {
  return open.value.includes(id);
}

function hunkKey(id: string, index: number): string {
  return `${id}:${index}`;
}

function toggleHunk(id: string, index: number): void {
  const key = hunkKey(id, index);
  pickedHunks.value = pickedHunks.value.includes(key)
    ? pickedHunks.value.filter((x) => x !== key)
    : [...pickedHunks.value, key];
}

function pickedFor(id: string): number[] {
  return pickedHunks.value
    .filter((k) => k.startsWith(`${id}:`))
    .map((k) => Number(k.slice(id.length + 1)));
}

const statusLabel: Record<string, string> = {
  pending: "待审阅",
  applied: "已接受",
  rejected: "已拒绝",
  unverified: "需人工确认",
  conflict: "有冲突",
};

const hasPending = computed(() => ws.changes.some((c) => c.status === "pending"));

async function acceptWhole(id: string): Promise<void> {
  await ws.acceptChange(id);
}

async function acceptPicked(id: string): Promise<void> {
  const picked = pickedFor(id);
  await ws.acceptChange(id, picked.length > 0 ? picked : undefined);
  pickedHunks.value = pickedHunks.value.filter((k) => !k.startsWith(`${id}:`));
}

async function jumpTo(relativePath: string, line: number): Promise<void> {
  await ws.openFile(relativePath, line);
}
</script>

<template>
  <section class="changeset">
    <header>
      <strong>Agent 的改动</strong>
      <n-tag v-if="ws.pendingChanges.length > 0" size="small" type="warning">
        {{ ws.pendingChanges.length }} 条待处理
      </n-tag>
      <span class="spacer" />
      <n-button size="tiny" @click="ws.refreshChanges()">刷新</n-button>
      <n-button size="tiny" type="primary" :disabled="!hasPending" @click="ws.acceptAll()">
        全部接受
      </n-button>
    </header>

    <p v-if="ws.changeNotice" class="notice">{{ ws.changeNotice }}</p>

    <p v-if="ws.changes.length === 0" class="empty">Agent 还没有改过工作区里的文件。</p>

    <ul class="list">
      <li v-for="change in ws.changes" :key="change.id" class="item">
        <div class="row" @click="toggleOpen(change.id)">
          <span class="kind">{{ change.kind }}</span>
          <span class="path">{{ change.relativePath }}</span>
          <n-tag size="tiny" :type="change.status === 'unverified' ? 'error' : 'default'">
            {{ statusLabel[change.status] ?? change.status }}
          </n-tag>
        </div>

        <div v-if="isOpen(change.id)" class="detail">
          <p v-if="ws.diffFor(change.id)?.degraded" class="degraded">
            {{ ws.diffFor(change.id)?.degraded }} —— 只能整文件接受或拒绝
          </p>

          <div
            v-for="hunk in ws.diffFor(change.id)?.hunks ?? []"
            :key="hunk.index"
            class="hunk"
            :class="{ picked: pickedHunks.includes(hunkKey(change.id, hunk.index)) }"
          >
            <div class="hunk-head">
              <label>
                <input
                  type="checkbox"
                  :checked="pickedHunks.includes(hunkKey(change.id, hunk.index))"
                  @change="toggleHunk(change.id, hunk.index)"
                />
                第 {{ hunk.beforeStart + 1 }} 行起
              </label>
              <n-button
                size="tiny"
                quaternary
                @click="jumpTo(change.relativePath, hunk.afterStart + 1)"
              >
                在编辑器中打开
              </n-button>
            </div>
            <pre class="del" v-for="(l, i) in hunk.beforeLines" :key="`d${i}`">- {{ l }}</pre>
            <pre class="add" v-for="(l, i) in hunk.afterLines" :key="`a${i}`">+ {{ l }}</pre>
          </div>

          <div class="actions">
            <n-button
              size="tiny"
              type="primary"
              :disabled="change.status !== 'pending'"
              @click="acceptWhole(change.id)"
            >
              接受整个文件
            </n-button>
            <n-button
              size="tiny"
              :disabled="change.status !== 'pending' || pickedFor(change.id).length === 0"
              @click="acceptPicked(change.id)"
            >
              只接受勾选的 {{ pickedFor(change.id).length }} 段
            </n-button>
            <n-button size="tiny" :disabled="change.status === 'applied'" @click="ws.rejectChange(change.id)">
              拒绝
            </n-button>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.changeset {
  border-top: var(--border-w) solid var(--border-subtle);
  padding: 8px;
  max-height: 320px;
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
  background: var(--warning-bg);
  border: var(--border-w) solid var(--status-warning);
  color: var(--status-warning);
  padding: 6px 8px;
  border-radius: var(--radius-l);
  font-size: var(--font-ui-12);
}
.empty {
  opacity: 0.6;
  font-size: 12px;
}
.list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.item {
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  cursor: pointer;
  padding: 4px 0;
  font-size: 12px;
}
.row .path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind {
  font-family: monospace;
  opacity: 0.7;
}
.detail {
  padding: 4px 0 10px;
}
.degraded {
  font-size: var(--font-ui-12);
  color: var(--status-warning);
}
.hunk {
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-m);
  margin-bottom: 6px;
  padding: 4px;
}
.hunk.picked {
  border-color: var(--status-success);
}
.hunk-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  opacity: 0.8;
}
.hunk-head label {
  flex: 1;
  display: flex;
  gap: 4px;
  align-items: center;
}
pre {
  margin: 0;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
pre.del {
  background: var(--danger-bg);
}
pre.add {
  background: color-mix(in srgb, var(--status-success) 16%, transparent);
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
</style>
