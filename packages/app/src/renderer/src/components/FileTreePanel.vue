<script setup lang="ts">
/**
 * 文件树（FS-101）。
 *
 * 渲染成**扁平列表**而不是递归组件：递归组件在几千个节点上会让每一次
 * 展开都重建一整条组件链，而扁平列表只是数组变长。缩进由 depth 决定，
 * 视觉上没有区别。
 *
 * 超大目录不硬渲染：主进程返回 `truncated` 时这里显示一条「目录过大，
 * 已折叠，点击加载」——把十万个条目铺进 DOM 的表现是整个窗口假死。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { NButton, NInput, NSpin, useDialog, useMessage } from "naive-ui";
import type { FileTreeEntry } from "@contract";
import { useAppStore } from "../stores/app";
import { useWorkspaceStore } from "../stores/workspace";
import { useArtifactsStore } from "../stores/artifacts";

const app = useAppStore();
const ws = useWorkspaceStore();
const artifacts = useArtifactsStore();
const dialog = useDialog();
const message = useMessage();

/**
 * 跟随当前工作区。
 *
 * `attach` 现在是异步的、而且**可以被用户取消**（有未保存的编辑时它会先
 * 问三选一）。真正的取消发生在上游 —— app.chooseWorkspace 在 adopt 之前
 * 就问过一次了，所以走到这里时 attach 基本不会再被拒。这里保留返回值
 * 判定只是为了不把「被拒了」当成「切成功了」。
 */
watch(
  () => app.workspaceId,
  (id) => {
    if (id) void ws.attach(id);
  },
  { immediate: true }
);

onBeforeUnmount(() => ws.detach());

/**
 * 扁平列表里的一行：要么是一个真实条目，要么是一条「这层太大，已折叠」。
 *
 * 折叠提示必须**按目录**出现在它自己的位置上。早先它只绑在工作区根上，
 * 真机验证抓到的表现是：根目录顶着一条说「9 项过大」的假提示，而真正
 * 有 5200 个文件的那个子目录一声不吭地把 5000 个节点铺进了 DOM ——
 * 一次展开 3.9 秒、5006 个行节点，正是这条提示本来要避免的事。
 */
type FlatRow =
  | { kind: "entry"; entry: FileTreeEntry; depth: number }
  | { kind: "folded"; dir: string; total: number; depth: number };

/**
 * 把 pages + expanded 摊平成一条可渲染的列表。
 *
 * 只遍历**已展开**的层：没展开的目录一个字节都不列，这正是惰性加载的
 * 全部意义。
 */
const rows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = [];
  const walk = (dir: string, depth: number): void => {
    if (ws.isFolded(dir)) {
      out.push({ kind: "folded", dir, total: ws.totalOf(dir), depth });
      return;
    }
    for (const entry of ws.entriesOf(dir)) {
      out.push({ kind: "entry", entry, depth });
      if (entry.isDirectory && ws.isExpanded(entry.relativePath)) {
        walk(entry.relativePath, depth + 1);
      }
    }
  };
  walk("", 0);
  return out;
});

function rowKey(row: FlatRow): string {
  return row.kind === "entry" ? `e:${row.entry.relativePath}` : `t:${row.dir}`;
}

async function onRowClick(entry: FileTreeEntry): Promise<void> {
  // 符号链接不跟随：展开它等于把工作区外的内容当成工作区内容展示
  if (entry.isSymlink) {
    message.info("这是一个符号链接，PiBuddy 不跟随它");
    return;
  }
  if (entry.isDirectory) {
    await ws.toggleDir(entry.relativePath);
    return;
  }
  // 单击文件 = 看一眼（只读预览），双击才进编辑器。
  //
  // 没有这一步的话，预览面板挂在界面上却**没有任何东西会去调它** ——
  // 转换链路、沙箱窗口、错误建议表全都在，用户点遍整棵文件树也永远
  // 看到「选一个文件来看看」。这类「两端齐全、中间没人接」的缺口不会
  // 让任何一道门禁变红。
  const workspaceId = app.workspaceId;
  if (workspaceId) void artifacts.preview({ workspaceId, relativePath: entry.relativePath });
}

async function onRowDouble(entry: FileTreeEntry): Promise<void> {
  if (entry.isDirectory || entry.isSymlink) return;
  try {
    await ws.openFile(entry.relativePath);
  } catch (err) {
    message.error(err instanceof Error ? err.message : "打开失败");
  }
}

// ---------------------------------------------------------------- 右键菜单

const menuFor = ref<FileTreeEntry | null>(null);
const menuX = ref(0);
const menuY = ref(0);

function openMenu(e: MouseEvent, entry: FileTreeEntry): void {
  e.preventDefault();
  menuFor.value = entry;
  menuX.value = e.clientX;
  menuY.value = e.clientY;
}
function closeMenu(): void {
  menuFor.value = null;
}

function parentOf(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? "" : relativePath.slice(0, i);
}

async function mutate(
  kind: "create-file" | "create-dir" | "rename" | "move" | "copy" | "trash",
  relativePath: string,
  targetPath?: string
): Promise<void> {
  const result = await window.piBuddy.workspace.mutate({
    workspaceId: app.workspaceId,
    kind,
    relativePath,
    ...(targetPath ? { targetPath } : {}),
  });
  if (!result.ok) {
    message.error(result.message ?? "操作失败");
    return;
  }
  await ws.refreshTree();
}

const promptOpen = ref(false);
const promptTitle = ref("");
const promptValue = ref("");
let promptResolve: ((value: string | null) => void) | null = null;

function askText(title: string, initial: string): Promise<string | null> {
  promptTitle.value = title;
  promptValue.value = initial;
  promptOpen.value = true;
  return new Promise((resolve) => {
    promptResolve = resolve;
  });
}
function settlePrompt(value: string | null): void {
  promptOpen.value = false;
  promptResolve?.(value);
  promptResolve = null;
}

async function doCreate(isDir: boolean): Promise<void> {
  const base = menuFor.value;
  closeMenu();
  const dir = base ? (base.isDirectory ? base.relativePath : parentOf(base.relativePath)) : "";
  const name = await askText(isDir ? "新建文件夹" : "新建文件", "");
  if (!name) return;
  await mutate(isDir ? "create-dir" : "create-file", dir ? `${dir}/${name}` : name);
}

async function doRename(): Promise<void> {
  const entry = menuFor.value;
  closeMenu();
  if (!entry) return;
  const name = await askText("重命名", entry.name);
  if (!name || name === entry.name) return;
  const dir = parentOf(entry.relativePath);
  await mutate("rename", entry.relativePath, dir ? `${dir}/${name}` : name);
}

async function doCopy(): Promise<void> {
  const entry = menuFor.value;
  closeMenu();
  if (!entry) return;
  const name = await askText("复制为", `${entry.name}-副本`);
  if (!name) return;
  const dir = parentOf(entry.relativePath);
  await mutate("copy", entry.relativePath, dir ? `${dir}/${name}` : name);
}

/**
 * 删除。
 *
 * 破坏性动作必须**显示精确范围**：删一个目录时到底会带走什么，用户在点
 * 确认之前就该看见。这里先向主进程要一次范围预览再弹确认。
 */
async function doTrash(): Promise<void> {
  const entry = menuFor.value;
  closeMenu();
  if (!entry) return;
  const scope = entry.isDirectory
    ? "这个文件夹连同它里面的全部内容"
    : `文件「${entry.relativePath}」`;
  dialog.warning({
    title: "移到回收站",
    content: `将把 ${scope} 移到系统回收站，之后可以在回收站里找回。`,
    positiveText: "移到回收站",
    negativeText: "取消",
    onPositiveClick: async () => {
      await mutate("trash", entry.relativePath);
    },
  });
}

async function attachToInput(): Promise<void> {
  const entry = menuFor.value;
  closeMenu();
  if (!entry || entry.isDirectory) return;
  try {
    const descriptor = await window.piBuddy.workspace.createAttachment(
      app.workspaceId,
      entry.relativePath
    );
    app.inboundAttachments = [
      ...app.inboundAttachments,
      {
        token: descriptor.token,
        name: descriptor.sourceName,
        size: descriptor.sizeBytes,
        kind: descriptor.mimeType.startsWith("image/") ? "image" : "other",
        relativePath: descriptor.relativePath,
      },
    ];
    message.success(`已把 ${descriptor.relativePath} 加入输入框附件`);
  } catch (err) {
    message.error(err instanceof Error ? err.message : "加入失败");
  }
}

async function onSearchEnter(): Promise<void> {
  await ws.runSearch();
}
</script>

<template>
  <aside class="file-tree" @click="closeMenu">
    <header class="tree-head">
      <strong>文件</strong>
      <n-button size="tiny" quaternary @click="ws.refreshTree()">刷新</n-button>
      <n-button
        size="tiny"
        quaternary
        :type="ws.showIgnored ? 'primary' : 'default'"
        @click="
          ws.showIgnored = !ws.showIgnored;
          ws.refreshTree();
        "
      >
        隐藏项
      </n-button>
    </header>

    <n-input
      v-model:value="ws.searchQuery"
      size="small"
      placeholder="搜索文件名或内容"
      clearable
      @keydown.enter="onSearchEnter"
    />

    <div v-if="ws.searching" class="tree-hint"><n-spin size="small" /> 搜索中…</div>

    <ul v-if="ws.searchHits.length > 0" class="hits">
      <li v-for="(hit, i) in ws.searchHits" :key="i" @click="ws.openFile(hit.relativePath, hit.line)">
        <span class="hit-path">{{ hit.relativePath }}</span>
        <span v-if="hit.line > 0" class="hit-line">:{{ hit.line }}</span>
        <span class="hit-preview">{{ hit.preview }}</span>
      </li>
      <li v-if="ws.searchTruncated" class="more" @click="ws.runSearch(true)">加载更多结果…</li>
    </ul>

    <p v-if="ws.treeError" class="tree-error">{{ ws.treeError }}</p>

    <ul class="rows">
      <template v-for="row in rows" :key="rowKey(row)">
        <!--
          超大目录：显示可点击的提示而不是硬渲染那几千个节点。数字给的是
          真实条目总数，用户据它判断要不要真的展开。
        -->
        <li
          v-if="row.kind === 'folded'"
          class="truncated"
          :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
          @click="ws.loadTruncated(row.dir)"
        >
          目录过大（{{ row.total }} 项），已折叠，点击加载
        </li>
        <li
          v-else
          class="row"
          :class="{ ignored: row.entry.ignored }"
          :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
          @click="onRowClick(row.entry)"
          @dblclick="onRowDouble(row.entry)"
          @contextmenu="openMenu($event, row.entry)"
        >
          <span class="icon">
            {{ row.entry.isSymlink ? "@" : row.entry.isDirectory ? (ws.isExpanded(row.entry.relativePath) ? "▾" : "▸") : "" }}
          </span>
          <span class="name">{{ row.entry.name }}</span>
        </li>
      </template>
    </ul>

    <div
      v-if="menuFor"
      class="ctx"
      :style="{ left: `${menuX}px`, top: `${menuY}px` }"
      @click.stop
    >
      <button @click="doCreate(false)">新建文件</button>
      <button @click="doCreate(true)">新建文件夹</button>
      <button @click="doRename">重命名</button>
      <button @click="doCopy">复制</button>
      <button v-if="!menuFor.isDirectory" @click="attachToInput">加入输入框附件</button>
      <button class="danger" @click="doTrash">移到回收站</button>
    </div>

    <div v-if="promptOpen" class="prompt-mask" @click.self="settlePrompt(null)">
      <div class="prompt">
        <h4>{{ promptTitle }}</h4>
        <n-input v-model:value="promptValue" size="small" @keydown.enter="settlePrompt(promptValue)" />
        <div class="prompt-actions">
          <n-button size="tiny" @click="settlePrompt(null)">取消</n-button>
          <n-button size="tiny" type="primary" @click="settlePrompt(promptValue)">确定</n-button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.file-tree {
  width: 100%;
  flex: 1;
  min-height: 0;
  border-right: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  overflow: auto;
}
.tree-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tree-head strong {
  flex: 1;
}
.rows,
.hits {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
  cursor: pointer;
  font-size: 13px;
  line-height: 22px;
  white-space: nowrap;
  overflow: hidden;
}
.row:hover {
  background: var(--bg-hover);
}
.row.ignored {
  opacity: 0.45;
}
.truncated {
  font-size: 12px;
  color: var(--status-warning);
  cursor: pointer;
  padding: 4px;
}
.tree-error {
  color: var(--status-error);
  font-size: 12px;
}
.tree-hint {
  font-size: 12px;
  opacity: 0.7;
}
.hits li {
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-path {
  font-weight: 600;
}
.hit-line {
  opacity: 0.6;
}
.hit-preview {
  margin-left: 6px;
  opacity: 0.7;
}
.ctx {
  position: fixed;
  z-index: 3000;
  background: var(--bg-surface-raised);
  border: var(--border-w) solid var(--border-strong);
  border-radius: var(--radius-s);
  box-shadow: var(--shadow-menu);
  display: flex;
  flex-direction: column;
  min-width: 150px;
}
.ctx button {
  border: 0;
  background: transparent;
  text-align: left;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
}
.ctx button:hover {
  background: var(--bg-hover);
}
.ctx .danger {
  color: var(--status-error);
}
.prompt-mask {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3100;
}
.prompt {
  background: var(--bg-surface-raised);
  padding: 16px;
  border-radius: var(--radius-m);
  min-width: 280px;
}
.prompt-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
