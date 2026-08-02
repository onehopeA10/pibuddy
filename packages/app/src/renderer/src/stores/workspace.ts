/**
 * 工作区面板的渲染侧状态（FS-101 / FS-102）。
 *
 * 这里从头到尾**只有相对路径**：主进程不下发绝对路径，因此这个 store 里
 * 也不存在能装绝对路径的字段。任何「顺手把真实位置缓存一下」的写法在这里
 * 连类型都过不了。
 *
 * ## 保存冲突为什么必须由 store 持有
 *
 * 冲突是一个**需要用户做决定**的状态，不是一次失败的调用。挂在组件局部
 * 变量上的话，用户切到别的 tab 再切回来，那个待决定的状态就没了 ——
 * 而磁盘上依然躺着两份不同的内容。
 */
import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
import type {
  ChangesetDiff,
  ChangesetEntry,
  FileTreeEntry,
  FileTreePage,
  WorkspaceSearchHit,
} from "@contract";

/** 编辑器里打开的一个文件。 */
export interface EditorTab {
  relativePath: string;
  /** 磁盘上读到的内容（换行已归一成 LF） */
  savedContent: string;
  /** 编辑缓冲区 */
  content: string;
  encoding: string;
  newline: string;
  baseMtimeMs: number;
  baseSha256: string;
  binary: boolean;
  tooLarge: boolean;
  /** 待用户决定的冲突：磁盘内容已不是 baseSha256 那一份 */
  conflict: { mtimeMs: number; sha256: string; preview: string } | null;
  /** 冲突面板里「查看差异」是否展开 */
  showDiff: boolean;
  /** 从变更面板跳过来时要定位的行 */
  gotoLine: number | null;
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const workspaceId = ref("");

  // ------------------------------------------------------------ 文件树

  /** relativePath → 该层的列表结果。空串键 = 工作区根。 */
  const pages = reactive<Record<string, FileTreePage>>({});
  /** 已展开的目录集合（用数组而不是 Set：Vue 的响应式对 Set 支持有坑） */
  const expanded = ref<string[]>([]);
  const showIgnored = ref(false);
  const treeError = ref("");

  function isExpanded(relativePath: string): boolean {
    return expanded.value.includes(relativePath);
  }

  async function loadDir(relativePath: string, limit?: number): Promise<void> {
    if (!workspaceId.value) return;
    try {
      pages[relativePath] = await window.piBuddy.workspace.listDir(
        workspaceId.value,
        relativePath,
        { includeIgnored: showIgnored.value, ...(limit ? { limit } : {}) }
      );
      treeError.value = "";
    } catch (err) {
      treeError.value = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * 展开 / 折叠一层。
   *
   * 折叠时**必须**把 watcher 关掉：只开不关的话，用户展开折叠几百次之后
   * fs.watch 句柄就用尽了，表现是文件树突然不再自动刷新且没有任何报错。
   */
  async function toggleDir(relativePath: string): Promise<void> {
    if (isExpanded(relativePath)) {
      expanded.value = expanded.value.filter((p) => p !== relativePath);
      void window.piBuddy.workspace.watchDir(workspaceId.value, relativePath, false);
      return;
    }
    expanded.value = [...expanded.value, relativePath];
    await loadDir(relativePath);
    void window.piBuddy.workspace.watchDir(workspaceId.value, relativePath, true);
  }

  /**
   * 用户显式点了「点击加载」的超大目录。
   *
   * 没有这个集合的话，`truncated` 一直为 true，UI 就永远只显示提示、
   * 永远不显示内容 —— 用户点了没反应。
   */
  const forceLoaded = ref<string[]>([]);

  function isForceLoaded(relativePath: string): boolean {
    return forceLoaded.value.includes(relativePath);
  }

  /** 「目录过大」的加载按钮：把上限临时抬高再列一次。 */
  async function loadTruncated(relativePath: string): Promise<void> {
    await loadDir(relativePath, 100000);
    if (!isForceLoaded(relativePath)) forceLoaded.value = [...forceLoaded.value, relativePath];
  }

  /**
   * 这一层要不要折叠成一条提示。
   *
   * 真机验证抓到的问题：提示只绑在工作区根上，于是真正超限的子目录
   * 把 5000 个节点全铺进了 DOM（实测一次展开 3.9 秒、5006 个行节点），
   * 而根目录顶着一条说「9 项过大」的假提示。判定必须**按目录**来。
   */
  function isFolded(relativePath: string): boolean {
    return !!pages[relativePath]?.truncated && !isForceLoaded(relativePath);
  }

  function totalOf(relativePath: string): number {
    return pages[relativePath]?.total ?? 0;
  }

  async function refreshTree(): Promise<void> {
    await loadDir("");
    for (const dir of expanded.value) await loadDir(dir);
  }

  function entriesOf(relativePath: string): FileTreeEntry[] {
    return pages[relativePath]?.entries ?? [];
  }

  // -------------------------------------------------------------- 搜索

  const searchQuery = ref("");
  const searchMode = ref<"name" | "content">("content");
  const searchHits = shallowRef<WorkspaceSearchHit[]>([]);
  const searching = ref(false);
  const searchTruncated = ref(false);
  const searchCursor = ref<string | null>(null);
  let searchSeq = 0;
  let lastRequestId = "";

  async function runSearch(append = false): Promise<void> {
    const query = searchQuery.value.trim();
    if (!workspaceId.value || query === "") {
      searchHits.value = [];
      return;
    }
    // 上一次还没回来就先取消：不取消的话结果会按返回顺序而不是输入顺序覆盖，
    // 用户看到的是「打完字之后列表跳回上一个词的结果」。
    if (lastRequestId) void window.piBuddy.workspace.cancelSearch(lastRequestId);
    const requestId = `s${++searchSeq}`;
    lastRequestId = requestId;
    searching.value = true;
    try {
      const page = await window.piBuddy.workspace.search({
        workspaceId: workspaceId.value,
        query,
        mode: searchMode.value,
        requestId,
        cursor: append ? searchCursor.value : null,
      });
      if (lastRequestId !== requestId) return;
      searchHits.value = append ? [...searchHits.value, ...page.items] : page.items;
      searchTruncated.value = page.truncated;
      searchCursor.value = page.nextCursor;
    } finally {
      if (lastRequestId === requestId) searching.value = false;
    }
  }

  // ------------------------------------------------------------ 编辑器

  const tabs = ref<EditorTab[]>([]);
  const activePath = ref("");
  const activeTab = computed(() => tabs.value.find((t) => t.relativePath === activePath.value) ?? null);
  const dirtyCount = computed(() => tabs.value.filter((t) => t.content !== t.savedContent).length);

  function isDirty(tab: EditorTab): boolean {
    return tab.content !== tab.savedContent;
  }

  async function openFile(relativePath: string, line: number | null = null): Promise<void> {
    const existing = tabs.value.find((t) => t.relativePath === relativePath);
    if (existing) {
      existing.gotoLine = line;
      activePath.value = relativePath;
      return;
    }
    const result = await window.piBuddy.workspace.readFile(workspaceId.value, relativePath);
    tabs.value = [
      ...tabs.value,
      {
        relativePath,
        savedContent: result.content,
        content: result.content,
        encoding: result.encoding,
        newline: result.newline,
        baseMtimeMs: result.mtimeMs,
        baseSha256: result.sha256,
        binary: result.binary,
        tooLarge: result.tooLarge,
        conflict: null,
        showDiff: false,
        gotoLine: line,
      },
    ];
    activePath.value = relativePath;
  }

  function closeTab(relativePath: string): void {
    tabs.value = tabs.value.filter((t) => t.relativePath !== relativePath);
    if (activePath.value === relativePath) activePath.value = tabs.value[0]?.relativePath ?? "";
  }

  /**
   * 保存。返回 `"conflict"` 时**磁盘一个字节都没动** —— 调用方据此弹三选一
   * 对话框，而不是假设保存成功了。
   */
  async function saveActive(overwrite = false): Promise<"saved" | "conflict" | "error"> {
    const tab = activeTab.value;
    if (!tab) return "error";
    const result = await window.piBuddy.workspace.saveFile({
      workspaceId: workspaceId.value,
      relativePath: tab.relativePath,
      content: tab.content,
      baseMtimeMs: tab.baseMtimeMs,
      baseSha256: tab.baseSha256,
      overwrite,
    });
    if (result.conflict && result.current) {
      tab.conflict = result.current;
      return "conflict";
    }
    if (!result.ok) {
      saveError.value = result.message ?? "保存失败";
      return "error";
    }
    tab.savedContent = tab.content;
    tab.baseMtimeMs = result.mtimeMs ?? tab.baseMtimeMs;
    tab.baseSha256 = result.sha256 ?? tab.baseSha256;
    tab.conflict = null;
    tab.showDiff = false;
    saveError.value = "";
    return "saved";
  }

  const saveError = ref("");

  /** 冲突三选一之「重新载入」：丢弃编辑缓冲，用磁盘上的内容重开。 */
  async function reloadActive(): Promise<void> {
    const tab = activeTab.value;
    if (!tab) return;
    const result = await window.piBuddy.workspace.readFile(workspaceId.value, tab.relativePath);
    tab.savedContent = result.content;
    tab.content = result.content;
    tab.baseMtimeMs = result.mtimeMs;
    tab.baseSha256 = result.sha256;
    tab.conflict = null;
    tab.showDiff = false;
  }

  // ------------------------------------------------------------ 变更集

  const changes = ref<ChangesetEntry[]>([]);
  const diffs = ref<ChangesetDiff[]>([]);
  const changeNotice = ref("");

  function diffFor(id: string): ChangesetDiff | null {
    return diffs.value.find((d) => d.id === id) ?? null;
  }

  const pendingChanges = computed(() =>
    changes.value.filter((c) => c.status === "pending" || c.status === "unverified")
  );

  async function refreshChanges(sessionId?: string): Promise<void> {
    if (!workspaceId.value) return;
    const result = await window.piBuddy.workspace.changesets({
      workspaceId: workspaceId.value,
      ...(sessionId ? { sessionId } : {}),
    });
    changes.value = result.entries;
    diffs.value = result.diffs;
  }

  async function acceptChange(id: string, hunkIndexes?: number[]): Promise<void> {
    const result = await window.piBuddy.workspace.acceptChange(id, hunkIndexes);
    if (result.conflict) {
      changeNotice.value = "这个文件在你审阅期间被外部改过了，已拦下。请先查看差异再决定。";
    } else if (result.requiresManualReview) {
      changeNotice.value = "这条变更没有改动前的快照，需要你人工比对后再处理。";
    } else if (result.alreadyApplied) {
      changeNotice.value = "这条变更已经生效过了。";
    } else if (!result.ok) {
      changeNotice.value = result.message ?? "接受失败";
    } else {
      changeNotice.value = "";
    }
    await refreshChanges();
  }

  async function rejectChange(id: string): Promise<void> {
    const result = await window.piBuddy.workspace.rejectChange(id);
    if (!result.ok) changeNotice.value = result.message ?? "拒绝失败";
    await refreshChanges();
  }

  async function acceptAll(): Promise<void> {
    const ids = changes.value.filter((c) => c.status === "pending").map((c) => c.id);
    const result = await window.piBuddy.workspace.acceptAll(ids);
    const parts: string[] = [`已接受 ${result.applied.length} 条`];
    // 跳过的必须说出来：静默跳过会让用户以为全处理完了
    if (result.skippedUnverified.length > 0) {
      parts.push(`跳过 ${result.skippedUnverified.length} 条无快照的变更（需人工确认）`);
    }
    if (result.conflicted.length > 0) parts.push(`${result.conflicted.length} 条因外部修改被拦下`);
    if (result.failed.length > 0) parts.push(`${result.failed.length} 条失败`);
    changeNotice.value = parts.join("；");
    await refreshChanges();
  }

  // ------------------------------------------------------------ 生命周期

  let offTreeEvent: (() => void) | null = null;

  function attach(id: string): void {
    if (workspaceId.value === id) return;
    workspaceId.value = id;
    for (const key of Object.keys(pages)) delete pages[key];
    expanded.value = [];
    forceLoaded.value = [];
    tabs.value = [];
    activePath.value = "";
    changes.value = [];
    diffs.value = [];
    offTreeEvent?.();
    offTreeEvent = window.piBuddy.workspace.onTreeChanged((payload) => {
      const event = payload as { workspaceId: string; relativePath: string };
      if (event.workspaceId !== workspaceId.value) return;
      void loadDir(event.relativePath);
    });
    void loadDir("");
    void refreshChanges();
  }

  function detach(): void {
    offTreeEvent?.();
    offTreeEvent = null;
  }

  return {
    workspaceId,
    // 树
    pages,
    expanded,
    showIgnored,
    treeError,
    isExpanded,
    entriesOf,
    loadDir,
    toggleDir,
    loadTruncated,
    isFolded,
    totalOf,
    refreshTree,
    // 搜索
    searchQuery,
    searchMode,
    searchHits,
    searching,
    searchTruncated,
    runSearch,
    // 编辑器
    tabs,
    activePath,
    activeTab,
    dirtyCount,
    isDirty,
    openFile,
    closeTab,
    saveActive,
    saveError,
    reloadActive,
    // 变更集
    changes,
    diffs,
    diffFor,
    pendingChanges,
    changeNotice,
    refreshChanges,
    acceptChange,
    rejectChange,
    acceptAll,
    // 生命周期
    attach,
    detach,
  };
});
