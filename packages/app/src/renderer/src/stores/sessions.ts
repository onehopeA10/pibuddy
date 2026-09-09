import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { SessionRow, SessionStatus } from "@contract";

/**
 * 会话中心的渲染侧状态（SES-101）。
 *
 * 这个 store **不 import app store**：会话列表只需要一个 workspaceId，由调用方
 * 传进来即可。反向依赖会在 app.ts ↔ sessions.ts 之间形成一个循环，而循环
 * 在 Vite 里表现为「某个 store 在首帧是 undefined」这类极难定位的问题。
 *
 * 列表里的每一条只有不透明的 `sessionId`：JSONL 的绝对路径全程留在主进程。
 */

/** 搜索框停止输入多久之后才真正查一次。 */
const SEARCH_DEBOUNCE_MS = 220;

/** 会话没有显式名称时，使用首条用户消息的前 5 个字符。 */
export function sessionDisplayName(row: Pick<SessionRow, "name" | "preview">): string {
  const explicitName = row.name?.trim();
  if (explicitName) return explicitName;

  const preview = row.preview.trim().replace(/\s+/g, " ");
  return Array.from(preview).slice(0, 5).join("") || "未命名任务";
}

export interface SessionFilters {
  search: string;
  status: SessionStatus;
  modelId: string;
  /** 修改时间下界（Unix ms）；0 表示不限 */
  from: number;
  /** 修改时间上界（Unix ms）；0 表示不限 */
  to: number;
}

function emptyFilters(): SessionFilters {
  return { search: "", status: "active", modelId: "", from: 0, to: 0 };
}

export const useSessionsStore = defineStore("sessions", () => {
  const rows = shallowRef<SessionRow[]>([]);
  const filters = ref<SessionFilters>(emptyFilters());
  const loading = ref(false);
  /** 查询失败的原因；非空时列表区显示错误条而不是「还没有历史任务」空态。 */
  const error = ref("");
  const lastWorkspaceId = ref("");

  /** 索引已经按 pinned DESC, mtime DESC 排好序，这里不再二次排序。 */
  const pinned = computed(() => rows.value.filter((r) => r.pinned));
  const unreadCount = computed(() => rows.value.filter((r) => r.unread).length);

  function rowOf(sessionId: string): SessionRow | undefined {
    return rows.value.find((r) => r.sessionId === sessionId);
  }

  /**
   * 请求序号。
   *
   * 只认最后一次发出的查询：搜索是逐字触发的，前一次查询完全可能比后一次
   * 晚回来（第一次查询还要顺带建索引，慢得多）。没有这道闸时的表现是
   * 「输入框里写着 A，列表里显示的却是 B 的结果」，而且看不出任何错误。
   */
  let requestSeq = 0;

  async function refresh(workspaceId?: string): Promise<void> {
    const ws = workspaceId || lastWorkspaceId.value;
    if (!ws) return;
    lastWorkspaceId.value = ws;
    const seq = ++requestSeq;
    loading.value = true;
    try {
      const f = filters.value;
      const result = await window.piBuddy.sessions.query(ws, {
        ...(f.search.trim() ? { search: f.search.trim() } : {}),
        status: f.status,
        ...(f.modelId ? { modelId: f.modelId } : {}),
        ...(f.from ? { from: f.from } : {}),
        ...(f.to ? { to: f.to } : {}),
      });
      if (seq !== requestSeq) return; // 已经有更新的查询在路上，这份结果作废
      rows.value = result;
      error.value = "";
    } catch (err) {
      if (seq !== requestSeq) return;
      // 不吞：查询挂了和「这个工作区没有会话」在界面上长得一模一样，
      // 用户会以为历史全没了。
      error.value = err instanceof Error ? err.message : "读取会话列表失败";
    } finally {
      if (seq === requestSeq) loading.value = false;
    }
  }

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 输入搜索词：尾沿防抖，避免每敲一个字就查一次库。 */
  function setSearch(text: string): void {
    filters.value = { ...filters.value, search: text };
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void refresh();
    }, SEARCH_DEBOUNCE_MS);
  }

  function setStatus(status: SessionStatus): void {
    filters.value = { ...filters.value, status };
    void refresh();
  }

  function setModelId(modelId: string): void {
    filters.value = { ...filters.value, modelId };
    void refresh();
  }

  function setDateRange(from: number, to: number): void {
    filters.value = { ...filters.value, from, to };
    void refresh();
  }

  function resetFilters(): void {
    filters.value = emptyFilters();
    void refresh();
  }

  // ---------- 整理动作 ----------
  //
  // 每个动作都是「调 IPC → 成功后 refresh」。刻意不做乐观更新：置顶会改变
  // 排序、归档会把条目移出当前列表，本地猜一个结果再被服务端纠正，视觉上
  // 是一次闪烁；而这些动作都不在热路径上。

  /**
   * 整理动作的工作区。
   *
   * 恒取 `lastWorkspaceId` —— 也就是这份列表**是从哪个工作区查出来的**。
   * 主进程按 (workspaceId, sessionId) 联合定位会话文件：sessionId 只在一个
   * 工作区之内唯一，复制会话文件或共用自定义 session-dir 都能让同一个 id
   * 出现两份，少了工作区限定，重命名 / 归档 / **彻底删除** 都可能落到另一
   * 个工作区的会话上。
   */
  function scope(): string {
    if (!lastWorkspaceId.value) throw new Error("WORKSPACE_UNKNOWN: 会话列表尚未加载");
    return lastWorkspaceId.value;
  }

  async function rename(sessionId: string, name: string): Promise<void> {
    await window.piBuddy.sessions.rename(scope(), sessionId, name);
    await refresh();
  }

  async function setPinned(sessionId: string, value: boolean): Promise<void> {
    await window.piBuddy.sessions.setPinned(scope(), sessionId, value);
    await refresh();
  }

  /** 归档 / 移入回收站 / 恢复为活动。**不会删除会话文件。** */
  async function moveTo(sessionId: string, status: SessionStatus): Promise<void> {
    await window.piBuddy.sessions.setStatus(scope(), sessionId, status);
    await refresh();
  }

  /** 彻底删除：会话文件被送进系统回收站。 */
  async function purge(sessionId: string): Promise<void> {
    await window.piBuddy.sessions.purge(scope(), sessionId);
    await refresh();
  }

  async function exportHtml(sessionId: string): Promise<string | null> {
    const resp = await window.piBuddy.sessions.exportHtml(scope(), sessionId);
    if (!resp.success) throw new Error(resp.error ?? "导出失败");
    return resp.data?.path ?? null;
  }

  /**
   * 批量移动。逐条串行执行并**分别记录成败**：一条失败不该让其余的也不做，
   * 用户需要知道「20 条里有 3 条没成功、分别是哪几条」。
   */
  async function moveMany(
    sessionIds: string[],
    status: SessionStatus,
    shouldCancel?: () => boolean
  ): Promise<{ done: string[]; failed: { sessionId: string; reason: string }[] }> {
    const done: string[] = [];
    const failed: { sessionId: string; reason: string }[] = [];
    const workspaceId = scope();
    for (const id of sessionIds) {
      if (shouldCancel?.()) break;
      try {
        await window.piBuddy.sessions.setStatus(workspaceId, id, status);
        done.push(id);
      } catch (err) {
        failed.push({ sessionId: id, reason: err instanceof Error ? err.message : "未知错误" });
      }
    }
    await refresh();
    return { done, failed };
  }

  return {
    rows,
    filters,
    loading,
    error,
    pinned,
    unreadCount,
    rowOf,
    refresh,
    setSearch,
    setStatus,
    setModelId,
    setDateRange,
    resetFilters,
    rename,
    setPinned,
    moveTo,
    purge,
    exportHtml,
    moveMany,
  };
});
