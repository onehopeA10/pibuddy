import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { SessionRow, SessionStatus, WorkspaceListItem } from "@contract";

/**
 * 项目（工作目录）维度的侧栏状态。
 *
 * Codex 式两级侧栏：项目 → 该项目下的会话。当前项目的会话列表仍由 sessions
 * store 负责（它带搜索 / 分页 / 整理动作）；这里只管**其它**项目的展开态与
 * 惰性拉取的只读行 —— 别的项目的会话只能「点开」，重命名 / 归档等整理动作
 * 要等切过去之后再做（sessions store 的整理动作恒作用于它加载的那个工作区，
 * 不能跨项目误操作）。
 *
 * 与 sessions store 一样**不 import app store**：需要什么 id 由调用方传入。
 */
export interface ProjectRows {
  rows: SessionRow[];
  loading: boolean;
  error: string;
}

export const useProjectsStore = defineStore("projects", () => {
  const items = shallowRef<WorkspaceListItem[]>([]);
  const loading = ref(false);
  const error = ref("");
  /** 展开的项目 id（当前项目恒视为展开，不记在这里）。 */
  const expanded = ref<Record<string, boolean>>({});
  /** 其它项目惰性拉取的会话行。 */
  const rowsByWorkspace = ref<Record<string, ProjectRows>>({});

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      items.value = await window.piBuddy.dialog.listWorkspaces();
      error.value = "";
    } catch (err) {
      error.value = err instanceof Error ? err.message : "读取项目列表失败";
    } finally {
      loading.value = false;
    }
  }

  function isExpanded(workspaceId: string): boolean {
    return expanded.value[workspaceId] === true;
  }

  function rowsFor(workspaceId: string): ProjectRows {
    return rowsByWorkspace.value[workspaceId] ?? { rows: [], loading: false, error: "" };
  }

  /** 拉一个（非当前）项目的会话；查询条件与当前列表的状态页 / 搜索词保持一致。 */
  async function loadRows(
    workspaceId: string,
    filter: { status: SessionStatus; search: string }
  ): Promise<void> {
    rowsByWorkspace.value[workspaceId] = { ...rowsFor(workspaceId), loading: true };
    try {
      const rows = await window.piBuddy.sessions.query(workspaceId, {
        status: filter.status,
        ...(filter.search.trim() ? { search: filter.search.trim() } : {}),
      });
      rowsByWorkspace.value[workspaceId] = { rows, loading: false, error: "" };
    } catch (err) {
      rowsByWorkspace.value[workspaceId] = {
        rows: [],
        loading: false,
        error: err instanceof Error ? err.message : "读取会话列表失败",
      };
    }
  }

  function toggle(
    workspaceId: string,
    filter: { status: SessionStatus; search: string }
  ): void {
    const next = !isExpanded(workspaceId);
    expanded.value = { ...expanded.value, [workspaceId]: next };
    if (next) void loadRows(workspaceId, filter);
  }

  /** 状态页 / 搜索词变化时，已展开的其它项目跟着重查一次。 */
  async function reloadExpanded(
    currentWorkspaceId: string,
    filter: { status: SessionStatus; search: string }
  ): Promise<void> {
    const ids = Object.keys(expanded.value).filter(
      (id) => expanded.value[id] && id !== currentWorkspaceId
    );
    await Promise.all(ids.map((id) => loadRows(id, filter)));
  }

  return {
    items,
    loading,
    error,
    expanded,
    refresh,
    isExpanded,
    rowsFor,
    loadRows,
    toggle,
    reloadExpanded,
  };
});
