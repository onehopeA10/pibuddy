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
 *
 * ## 未保存的编辑不能被静默丢弃
 *
 * 关 tab 和切工作区都会让一个 tab 消失。它们此前都是直接从数组里删，
 * dirty 标记明明就画在界面上，内容却一声不响地没了。现在两条路径统一
 * 走 `askDirty`：保存 / 放弃 / 取消三选一，**取消真的中止**这次关闭或
 * 切换（`closeTab` 与 `attach` 都返回 boolean，false = 什么都没发生）。
 *
 * ## tab 必须记住自己属于哪个工作区
 *
 * `openFile` 是异步的。在 A 里双击一个文件、结果还没回来就切到了 B，
 * 旧写法会无条件把 tab 加进来；而保存时用的是**当前** workspaceId ——
 * 于是 A 的内容被写进了 B 的同名文件。这是真实的数据破坏，不是显示错乱。
 * 修法参照 main/pi-supervisor.ts 的代际口径：切换即 `++generation`，
 * 异步结果落地前先验代际，保存前再验 tab.workspaceId 是否还是当前。
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

/**
 * 未保存编辑的三选一。
 *
 * 没有第四个选项，也没有默认值：这三个各自对应一种真实意图，而
 * 「默认放弃」正是这次修复要消灭的东西。
 */
export type DirtyDecision = "save" | "discard" | "cancel";

/**
 * 由 UI 层注入的询问实现（naive-ui 的 dialog 住在组件里，store 够不着）。
 *
 * 没装的时候默认返回 `"cancel"` —— 宁可让「关不掉」这个问题显形，也不能
 * 因为一个装配疏漏就退回到静默丢弃。
 */
export type DirtyPrompt = (tabs: EditorTab[]) => Promise<DirtyDecision>;

let dirtyPrompt: DirtyPrompt | null = null;

/** 安装未保存编辑的询问实现（传 null 卸载）。由 AppShell 在挂载时调一次。 */
export function setDirtyPrompt(prompt: DirtyPrompt | null): void {
  dirtyPrompt = prompt;
}

/** 三选一对话框的回调面。字段名与 naive-ui 的 DialogOptions 对齐。 */
export interface DirtyDialogHandlers {
  onPositiveClick: () => void;
  onNegativeClick: () => void;
  onClose: () => void;
  onEsc: () => void;
  onMaskClick: () => void;
  onAfterLeave: () => void;
}

/**
 * 把「对话框的每一条出口」和「一个只会 settle 一次的 Promise」绑在一起。
 *
 * 住在 store 模块而不是组件里，是为了**可测**：这段逻辑第一版只在
 * `onAfterLeave` 里 resolve，真机验证当场打脸 —— 窗口不可见时
 * （`document.visibilityState === "hidden"`）CSS 离场过渡不会跑完，
 * transitionend 不触发，onAfterLeave 就永远不触发，于是点了「放弃修改」
 * 之后 closeTab 的 Promise 永久挂起：tab 既不关也不报错。
 *
 * 所以判据是：**每一条按钮出口都必须自己 resolve，一次都不能依赖
 * onAfterLeave**。onAfterLeave 只作兜底。
 */
export function createDirtyDialog(): {
  handlers: DirtyDialogHandlers;
  decision: Promise<DirtyDecision>;
} {
  let settle: (d: DirtyDecision) => void = () => undefined;
  const decision = new Promise<DirtyDecision>((resolve) => {
    let settled = false;
    settle = (d) => {
      if (settled) return;
      settled = true;
      resolve(d);
    };
  });
  return {
    decision,
    handlers: {
      onPositiveClick: () => settle("save"),
      onNegativeClick: () => settle("discard"),
      // × / Esc / 点遮罩都是「我还没想好」，一律按取消处理
      onClose: () => settle("cancel"),
      onEsc: () => settle("cancel"),
      onMaskClick: () => settle("cancel"),
      onAfterLeave: () => settle("cancel"),
    },
  };
}

/** 编辑器里打开的一个文件。 */
export interface EditorTab {
  /**
   * 这个 tab 属于哪个工作区。
   *
   * 不是冗余字段：保存时拿它和当前 workspaceId 比对，不一致就拒绝下发。
   * 少了它，「A 的迟到读取被保存到 B」在类型上完全表达得出来。
   */
  workspaceId: string;
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

  /**
   * 工作区代际。每 attach 一次自增，口径同 main/pi-supervisor.ts。
   *
   * 一切「发出去之后才回来」的结果落地之前都要对一次代际：切换发生过就
   * 整份丢弃。只比 workspaceId 不够 —— 用户完全可能切走再切回来，那时
   * id 相同但中间已经清过一轮状态，旧结果照样是脏的。
   */
  const generation = ref(0);

  /** 当前代际是否仍然是 `gen`（异步结果落地前的唯一判据）。 */
  function isCurrent(gen: number): boolean {
    return generation.value === gen;
  }

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
    const gen = generation.value;
    try {
      const page = await window.piBuddy.workspace.listDir(workspaceId.value, relativePath, {
        includeIgnored: showIgnored.value,
        ...(limit ? { limit } : {}),
      });
      // 切换期间回来的旧结果直接丢：attach 已经把 pages 清空过了，
      // 写回去等于把上一个工作区的目录内容贴到新工作区的树上。
      if (!isCurrent(gen)) return;
      pages[relativePath] = page;
      treeError.value = "";
    } catch (err) {
      if (!isCurrent(gen)) return;
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

  /**
   * 打开一个文件。
   *
   * 读取是异步的，而工作区可能在这期间被换掉。落地前必须验代际：验不过
   * 就整份丢弃 —— 这条 tab 的内容属于上一个工作区，留下它就等于给「保存
   * 到错误的工作区」留了入口。
   */
  async function openFile(relativePath: string, line: number | null = null): Promise<void> {
    const existing = tabs.value.find((t) => t.relativePath === relativePath);
    if (existing) {
      existing.gotoLine = line;
      activePath.value = relativePath;
      return;
    }
    const gen = generation.value;
    const owner = workspaceId.value;
    const result = await window.piBuddy.workspace.readFile(owner, relativePath);
    if (!isCurrent(gen) || workspaceId.value !== owner) return;
    tabs.value = [
      ...tabs.value,
      {
        workspaceId: owner,
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

  /** 从数组里摘掉一条 tab（不问任何问题）。仅供已经问过的调用方使用。 */
  function dropTab(relativePath: string): void {
    tabs.value = tabs.value.filter((t) => t.relativePath !== relativePath);
    if (activePath.value === relativePath) activePath.value = tabs.value[0]?.relativePath ?? "";
  }

  /** 问一次三选一。没装 prompt 时按最保守的「取消」处理。 */
  async function askDirty(dirty: EditorTab[]): Promise<DirtyDecision> {
    if (!dirtyPrompt) return "cancel";
    return dirtyPrompt(dirty);
  }

  /**
   * 关闭一条 tab。
   *
   * 返回 false = **什么都没发生**，tab 还在。用户点了取消，或者选了保存
   * 但保存没成功（冲突 / 磁盘错）—— 后一种情况把 tab 关掉同样是丢数据。
   */
  async function closeTab(relativePath: string): Promise<boolean> {
    const tab = tabs.value.find((t) => t.relativePath === relativePath);
    if (!tab) return true;
    if (!isDirty(tab)) {
      dropTab(relativePath);
      return true;
    }

    const decision = await askDirty([tab]);
    if (decision === "cancel") return false;
    if (decision === "save") {
      const result = await saveTab(tab);
      // 保存没成功就绝不关：冲突面板还等着用户处理，关掉它等于替用户
      // 选了「放弃」。
      if (result !== "saved") {
        activePath.value = relativePath;
        return false;
      }
    }
    dropTab(relativePath);
    return true;
  }

  /**
   * 离开当前工作区前的统一关卡（切换 / 卸载都走它）。
   *
   * 返回 false = 用户取消，调用方**必须**中止这次切换。
   */
  async function confirmLeave(): Promise<boolean> {
    const dirty = tabs.value.filter((t) => isDirty(t));
    if (dirty.length === 0) return true;

    const decision = await askDirty(dirty);
    if (decision === "cancel") return false;
    if (decision === "discard") return true;

    for (const tab of dirty) {
      const result = await saveTab(tab);
      if (result !== "saved") {
        // 有一条没保存成功就停下：继续切过去，剩下那些编辑就没了。
        activePath.value = tab.relativePath;
        return false;
      }
    }
    return true;
  }

  /**
   * 保存指定 tab。返回 `"conflict"` 时**磁盘一个字节都没动** —— 调用方
   * 据此弹三选一对话框，而不是假设保存成功了。
   *
   * 第一件事是校验 tab 属于当前工作区：不校验的话，一条从上一个工作区
   * 残留下来的 tab 会被写进当前工作区的同名路径。
   */
  async function saveTab(tab: EditorTab, overwrite = false): Promise<"saved" | "conflict" | "error"> {
    if (tab.workspaceId !== workspaceId.value) {
      saveError.value = "这个文件属于已经切走的工作区，不能保存到当前工作区（请切回去再保存）";
      return "error";
    }
    const result = await window.piBuddy.workspace.saveFile({
      workspaceId: tab.workspaceId,
      relativePath: tab.relativePath,
      content: tab.content,
      baseMtimeMs: tab.baseMtimeMs,
      baseSha256: tab.baseSha256,
      overwrite,
    });
    // 保存期间又切走了：结果一律不落地，否则 baseSha256 会被更新成另一个
    // 工作区里那个文件的 hash，下一次保存的冲突判定就此失效。
    if (tab.workspaceId !== workspaceId.value) return "error";
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

  async function saveActive(overwrite = false): Promise<"saved" | "conflict" | "error"> {
    const tab = activeTab.value;
    if (!tab) return "error";
    return saveTab(tab, overwrite);
  }

  const saveError = ref("");

  /** 冲突三选一之「重新载入」：丢弃编辑缓冲，用磁盘上的内容重开。 */
  async function reloadActive(): Promise<void> {
    const tab = activeTab.value;
    if (!tab || tab.workspaceId !== workspaceId.value) return;
    const gen = generation.value;
    const result = await window.piBuddy.workspace.readFile(tab.workspaceId, tab.relativePath);
    if (!isCurrent(gen)) return;
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

  /**
   * 切到一个工作区。
   *
   * 返回 false = 用户在「未保存的编辑怎么办」那一步点了取消，**这次切换
   * 没有发生**：workspaceId、tabs、代际全都原封不动。调用方必须据此把
   * 上层的选择也回滚掉，而不是继续往下走。
   */
  async function attach(id: string): Promise<boolean> {
    if (workspaceId.value === id) return true;
    if (!(await confirmLeave())) return false;

    const previous = workspaceId.value;
    // 换工作区即换代际：这一刻之前发出去的所有异步请求，回来时都会被
    // isCurrent 挡在门外。
    generation.value += 1;
    workspaceId.value = id;
    for (const key of Object.keys(pages)) delete pages[key];
    expanded.value = [];
    forceLoaded.value = [];
    tabs.value = [];
    activePath.value = "";
    changes.value = [];
    diffs.value = [];
    saveError.value = "";
    offTreeEvent?.();
    // 旧工作区的 watcher 与搜索子进程在 main 侧不会自己消失。不释放的话
    // 反复切换会一路累积句柄与 utility process，而且全程没有任何报错。
    releaseWorkspace(previous);
    offTreeEvent = window.piBuddy.workspace.onTreeChanged((payload) => {
      const event = payload as { workspaceId: string; relativePath: string };
      if (event.workspaceId !== workspaceId.value) return;
      void loadDir(event.relativePath);
    });
    void loadDir("");
    void refreshChanges();
    return true;
  }

  /** 告诉 main 把这个工作区占的 watcher / 搜索子进程收掉。 */
  function releaseWorkspace(id: string): void {
    if (!id) return;
    void window.piBuddy.workspace.release(id);
  }

  /**
   * 面板卸载。
   *
   * 只解事件订阅是不够的：main 侧的 watcher 与搜索子进程还挂着，而卸载
   * 之后再也没人会来关它们。
   */
  function detach(): void {
    offTreeEvent?.();
    offTreeEvent = null;
    releaseWorkspace(workspaceId.value);
  }

  return {
    workspaceId,
    generation,
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
    confirmLeave,
    saveTab,
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
