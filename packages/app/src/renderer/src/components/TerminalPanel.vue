<script setup lang="ts">
/**
 * 终端面板（coding.terminal / PTY-101）。
 *
 * 存在的理由：把一个真正的多标签页终端装进 PiBuddy，而**开 shell 这件事经主
 * 进程的 process.shell 授权**——面板本身只发意图，未授权时主进程第五道闸挡下，
 * 面板据此弹「授权终端」。
 *
 * ## 输出 / 重连
 *
 * 每个 tab 一个 xterm 实例。PTY 输出经 `terminal.onEvent` 推上来（
 * PiEnvelope<TerminalEventPayload>），用 `shouldAcceptEnvelope` 的代际 + 序号
 * 丢弃规则**逐 tab**对齐，丢掉上一代 PTY（restart 之后）的迟到输出。窗口 reload
 * 之后内存全没，靠 `terminal.snapshot` 把主进程有界 ring buffer 的当前内容 + 最后
 * 序号取回来重建屏幕，再从推送流里只接受更大序号的块——events 在 term 就绪前
 * 先入队，snapshot 落定后再按同一条丢弃规则回放，避免重复。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NButton, NInput, NSelect } from "naive-ui";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  shouldAcceptEnvelope,
  type PiEnvelope,
  type SequencedFrame,
  type TerminalEventPayload,
  type TerminalWslDistrosResult,
} from "@contract";
import { useAppStore } from "../stores/app";
import { useTerminalStore } from "../stores/terminal";

const app = useAppStore();
const store = useTerminalStore();

const workspaceId = computed(() => app.workspaceId);
const selectedProfile = ref<string | null>(null);
const searchQuery = ref("");

/**
 * WSL 发行版信息（R5.1）。经 terminal:wsl-distros 查询通道取一次：无 WSL /
 * 非 Windows 机器上主进程返回 {available:false}（不抛错），这里保持 null，
 * 模板里因此不渲染任何 WSL 相关的字样——选项本身也不会出现（profiles 里
 * 没有 wsl:* 条目）。
 */
const wslInfo = ref<TerminalWslDistrosResult | null>(null);

/** 当前选中的 profile 若是 WSL 发行版，给一行去向提示。 */
const selectedWslDistro = computed(() => {
  const id = selectedProfile.value;
  if (!id || !id.startsWith("wsl:")) return null;
  const name = id.slice("wsl:".length);
  return wslInfo.value?.distros.find((d) => d.name === name) ?? { name, isDefault: false, state: "", version: "" };
});

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLElement;
  lastFrame: SequencedFrame | null;
  ready: boolean;
  queue: PiEnvelope<TerminalEventPayload>[];
  ro: ResizeObserver;
}

const entries = new Map<string, TermEntry>();
let unsubscribe: (() => void) | null = null;

const profileOptions = computed(() =>
  store.profiles.map((p) => ({ label: p.label, value: p.id }))
);

function apply(entry: TermEntry, e: PiEnvelope<TerminalEventPayload>): void {
  const frame: SequencedFrame = { generation: e.generation, sequence: e.sequence };
  if (!shouldAcceptEnvelope(entry.lastFrame, frame)) return;
  entry.lastFrame = frame;
  if (e.payload.kind === "data") {
    entry.term.write(e.payload.data);
  } else {
    const code = e.payload.exitCode;
    entry.term.write(`\r\n\x1b[90m[进程已退出${code === null ? "" : `，退出码 ${code}`}]\x1b[0m\r\n`);
  }
}

function onEvent(e: PiEnvelope<TerminalEventPayload>): void {
  const entry = entries.get(e.payload.tabId);
  if (!entry) return;
  if (!entry.ready) {
    entry.queue.push(e);
    return;
  }
  apply(entry, e);
}

/** 从主进程 ring buffer 取快照重建屏幕，落定后回放入队事件（同一条丢弃规则去重）。 */
async function seed(tabId: string, entry: TermEntry, reset: boolean): Promise<void> {
  const ws = workspaceId.value;
  if (!ws) return;
  if (reset) entry.term.reset();
  entry.ready = false;
  entry.lastFrame = null;
  try {
    const snap = await window.piBuddy.terminal.snapshot(ws, tabId);
    if (snap.found) {
      if (snap.text) entry.term.write(snap.text);
      entry.lastFrame = { generation: snap.generation, sequence: snap.sequence };
    }
  } catch {
    /* 未授权 / tab 没了：留空即可，store 会处理授权态 */
  }
  entry.ready = true;
  const queued = entry.queue;
  entry.queue = [];
  for (const e of queued) apply(entry, e);
  doFit(tabId);
}

function doFit(tabId: string): void {
  const entry = entries.get(tabId);
  const ws = workspaceId.value;
  if (!entry || !ws) return;
  try {
    entry.fit.fit();
    void window.piBuddy.terminal.resize(ws, tabId, entry.term.cols, entry.term.rows);
  } catch {
    /* 容器还没布局好 */
  }
}

/**
 * xterm 的颜色从 tokens.css 的代码块 token 取（深 / 浅两套都有），而不是
 * 写死一套深色 —— 浅色界面里嵌一块黑终端很割裂。取值走 getComputedStyle，
 * 这样 data-theme 一切，重读一次就是新色。
 */
function terminalTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--code-bg", "#14181f"),
    foreground: read("--code-text", "#d5dbe3"),
    cursor: read("--text-primary", "#e6e8ec"),
    selectionBackground: read("--bg-selected", "#262b38"),
  };
}

// 配色切换后把已开着的终端一起换色（xterm 的 theme 是可热改的 option）
watch(
  () => app.settings.theme,
  () => {
    const theme = terminalTheme();
    for (const entry of entries.values()) entry.term.options.theme = theme;
  },
  { flush: "post" }
);

function ensureTerm(tabId: string, el: HTMLElement): void {
  if (entries.has(tabId)) return;
  const ws = workspaceId.value;
  if (!ws) return;
  const term = new Terminal({
    fontFamily: 'Menlo, Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.open(el);
  term.onData((data) => {
    void window.piBuddy.terminal.input(ws, tabId, data);
  });
  // Ctrl+Shift+C 复制 / Ctrl+Shift+V 粘贴：终端里 Ctrl+C 是发 SIGINT，不能占用。
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyC") {
      void copySelection(tabId);
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === "KeyV") {
      void pasteClipboard(tabId);
      return false;
    }
    return true;
  });
  const ro = new ResizeObserver(() => doFit(tabId));
  ro.observe(el);
  const entry: TermEntry = { term, fit, search, el, lastFrame: null, ready: false, queue: [], ro };
  entries.set(tabId, entry);
  void seed(tabId, entry, false);
}

function disposeTerm(tabId: string): void {
  const entry = entries.get(tabId);
  if (!entry) return;
  entry.ro.disconnect();
  entry.term.dispose();
  entries.delete(tabId);
}

function setEl(tabId: string, el: Element | null): void {
  if (el instanceof HTMLElement) ensureTerm(tabId, el);
}

async function copySelection(tabId: string): Promise<void> {
  const sel = entries.get(tabId)?.term.getSelection();
  if (sel) {
    try {
      await navigator.clipboard.writeText(sel);
    } catch {
      /* 剪贴板不可用 */
    }
  }
}

async function pasteClipboard(tabId: string): Promise<void> {
  const ws = workspaceId.value;
  if (!ws) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) await window.piBuddy.terminal.input(ws, tabId, text);
  } catch {
    /* 剪贴板不可用 */
  }
}

async function openTerminal(): Promise<void> {
  await store.open(selectedProfile.value ?? null);
}

async function killTab(tabId: string): Promise<void> {
  await store.kill(tabId);
  disposeTerm(tabId);
}

async function restartTab(tabId: string): Promise<void> {
  const meta = await store.restart(tabId);
  const entry = entries.get(tabId);
  if (meta && entry) void seed(tabId, entry, true);
}

async function clearTab(tabId: string): Promise<void> {
  const ws = workspaceId.value;
  if (!ws) return;
  entries.get(tabId)?.term.clear();
  await window.piBuddy.terminal.clear(ws, tabId);
}

function renameTab(tabId: string): void {
  const current = store.tabs.find((t) => t.tabId === tabId);
  const next = window.prompt("终端标题", current?.title ?? "");
  if (next && next.trim()) void store.rename(tabId, next.trim());
}

function searchNext(): void {
  if (store.activeTabId && searchQuery.value) {
    entries.get(store.activeTabId)?.search.findNext(searchQuery.value);
  }
}
function searchPrev(): void {
  if (store.activeTabId && searchQuery.value) {
    entries.get(store.activeTabId)?.search.findPrevious(searchQuery.value);
  }
}

async function authorize(): Promise<void> {
  const ok = await store.requestPermission();
  if (ok) {
    await store.refreshProfiles();
    await store.refresh();
  }
}

// 活跃 tab 变了：给它一次 fit（v-show 的容器从 display:none 回来时尺寸才对）。
watch(
  () => store.activeTabId,
  (id) => {
    if (id) requestAnimationFrame(() => doFit(id));
  }
);

onMounted(async () => {
  const ws = workspaceId.value;
  if (ws) await store.init(ws);
  selectedProfile.value = store.defaultProfileId || null;
  unsubscribe = window.piBuddy.terminal.onEvent(onEvent);
  if (ws) {
    try {
      const info = await window.piBuddy.terminal.wslDistros(ws);
      wslInfo.value = info.available ? info : null;
    } catch {
      /* 未授权 process.shell：授权后 refreshProfiles 那条路径会再显形，这里保持无提示 */
    }
  }
});

onBeforeUnmount(() => {
  if (unsubscribe) unsubscribe();
  for (const tabId of [...entries.keys()]) disposeTerm(tabId);
  store.dispose();
});
</script>

<template>
  <div class="terminal-panel">
    <div class="terminal-toolbar">
      <n-select
        v-model:value="selectedProfile"
        size="tiny"
        class="profile-select"
        :options="profileOptions"
        placeholder="Shell"
      />
      <n-button size="tiny" type="primary" @click="openTerminal">＋ 新建终端</n-button>
      <div class="spacer" />
      <n-input
        v-model:value="searchQuery"
        size="tiny"
        class="search-box"
        placeholder="搜索"
        @keyup.enter="searchNext"
      />
      <n-button size="tiny" quaternary title="上一个" @click="searchPrev">▲</n-button>
      <n-button size="tiny" quaternary title="下一个" @click="searchNext">▼</n-button>
    </div>

    <div v-if="selectedWslDistro" class="terminal-wsl-hint">
      新终端将进入 WSL 发行版 {{ selectedWslDistro.name
      }}<template v-if="selectedWslDistro.state">（{{ selectedWslDistro.state }}）</template>；
      工作目录自动映射：Windows 盘符 → /mnt/*，本发行版内的目录 → 原 Linux 路径。
    </div>

    <div v-if="store.permissionDenied" class="terminal-authorize">
      <p>终端需要 <code>process.shell</code> 授权才能开 shell。</p>
      <n-button size="small" type="primary" @click="authorize">授权终端（本次运行）</n-button>
    </div>

    <div class="terminal-tabs">
      <div
        v-for="tab in store.tabs"
        :key="tab.tabId"
        class="terminal-tab"
        :class="{ active: tab.tabId === store.activeTabId, exited: !tab.running }"
        @click="store.setActive(tab.tabId)"
        @dblclick="renameTab(tab.tabId)"
      >
        <span class="tab-title">{{ tab.title }}</span>
        <span v-if="!tab.running" class="tab-exit">已退出</span>
        <span class="tab-close" title="关闭" @click.stop="killTab(tab.tabId)">✕</span>
      </div>
      <div v-if="store.tabs.length === 0" class="terminal-empty">还没有终端。点「新建终端」开一个。</div>
    </div>

    <div v-if="store.activeTabId" class="terminal-actions">
      <n-button size="tiny" quaternary @click="clearTab(store.activeTabId)">清屏</n-button>
      <n-button size="tiny" quaternary @click="restartTab(store.activeTabId)">重启</n-button>
      <n-button size="tiny" quaternary @click="renameTab(store.activeTabId)">重命名</n-button>
      <n-button size="tiny" quaternary @click="copySelection(store.activeTabId)">复制</n-button>
      <n-button size="tiny" quaternary @click="pasteClipboard(store.activeTabId)">粘贴</n-button>
    </div>

    <div class="terminal-views">
      <div
        v-for="tab in store.tabs"
        v-show="tab.tabId === store.activeTabId"
        :key="tab.tabId"
        class="terminal-view"
        :ref="(el) => setEl(tab.tabId, el as Element | null)"
      />
    </div>

    <div v-if="store.lastError && !store.permissionDenied" class="terminal-error">
      {{ store.lastError }}
    </div>
  </div>
</template>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 240px;
  margin: var(--space-4) var(--space-6) var(--space-6);
  border: var(--border-w) solid var(--border-subtle);
  border-radius: var(--radius-l);
  overflow: hidden;
  background: var(--code-bg);
  color: var(--code-text);
}
.terminal-toolbar,
.terminal-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.profile-select {
  width: 160px;
}
.search-box {
  width: 140px;
}
.spacer {
  flex: 1;
}
.terminal-authorize {
  padding: 12px;
  text-align: center;
}
.terminal-wsl-hint {
  padding: 3px 8px;
  font-size: var(--font-ui-11);
  color: var(--text-secondary);
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.terminal-tabs {
  display: flex;
  gap: 6px;
  padding: 8px 12px 0;
  overflow-x: auto;
}
.terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-l) var(--radius-l) 0 0;
  background: var(--bg-surface-raised);
  cursor: pointer;
  white-space: nowrap;
  font-size: var(--font-ui-12);
}
.terminal-tab.active {
  background: var(--code-bg);
  border: var(--border-w) solid var(--border-subtle);
  border-bottom: none;
}
.terminal-tab.exited .tab-title {
  color: var(--text-tertiary);
}
.tab-exit {
  font-size: 10px;
  color: var(--status-warning);
}
.tab-close {
  color: var(--text-tertiary);
}
.tab-close:hover {
  color: var(--text-primary);
}
.terminal-empty {
  color: var(--text-tertiary);
  font-size: var(--font-ui-12);
  padding: 4px 8px;
}
.terminal-views {
  flex: 1;
  position: relative;
  min-height: 200px;
  padding: 4px;
}
.terminal-view {
  position: absolute;
  inset: 4px;
}
.terminal-error {
  padding: 4px 8px;
  color: var(--status-error);
  font-size: var(--font-ui-12);
  white-space: pre-wrap;
}
</style>
