/**
 * 定时任务的渲染侧状态（Durable Tasks，AUT-101 的界面出口）。
 *
 * 渲染进程只是主进程调度状态的一个观察者：它在不在都不影响任务是否触发
 * （调度器 headless 活在主进程）。因此这里不维护任何「下一次几点」的本地推算——
 * 一切以主进程返回的权威快照为准，避免两侧对时间的理解分叉。
 */
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { TaskCreateRequest, TaskDetail, TaskListItem, TaskUpdateRequest } from "@contract";

export const useTasksStore = defineStore("tasks", () => {
  const panelOpen = ref(false);
  const items = shallowRef<TaskListItem[]>([]);
  const detail = shallowRef<TaskDetail | null>(null);
  const selectedId = ref<string | null>(null);
  const lastError = ref("");
  const loading = ref(false);

  function fail(err: unknown): void {
    lastError.value = (err as Error).message;
  }

  async function refresh(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    loading.value = true;
    try {
      items.value = (await window.piBuddy.tasks.list(workspaceId)).items;
      lastError.value = "";
      // 当前选中的任务详情也刷新一遍（run 状态会变）。
      if (selectedId.value) await select(workspaceId, selectedId.value);
    } catch (err) {
      fail(err);
    } finally {
      loading.value = false;
    }
  }

  async function select(workspaceId: string, id: string): Promise<void> {
    selectedId.value = id;
    try {
      detail.value = await window.piBuddy.tasks.get(workspaceId, id);
      lastError.value = "";
    } catch (err) {
      fail(err);
    }
  }

  function clearSelection(): void {
    selectedId.value = null;
    detail.value = null;
  }

  async function create(req: TaskCreateRequest): Promise<boolean> {
    try {
      const d = await window.piBuddy.tasks.create(req);
      await refresh(req.workspaceId);
      await select(req.workspaceId, d.task.id);
      lastError.value = "";
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async function update(req: TaskUpdateRequest): Promise<void> {
    try {
      await window.piBuddy.tasks.update(req);
      await refresh(req.workspaceId);
    } catch (err) {
      fail(err);
    }
  }

  async function remove(workspaceId: string, id: string): Promise<void> {
    try {
      items.value = (await window.piBuddy.tasks.delete(workspaceId, id)).items;
      if (selectedId.value === id) clearSelection();
    } catch (err) {
      fail(err);
    }
  }

  async function pause(workspaceId: string, id: string): Promise<void> {
    try {
      await window.piBuddy.tasks.pause(workspaceId, id);
      await refresh(workspaceId);
    } catch (err) {
      fail(err);
    }
  }

  async function resume(workspaceId: string, id: string): Promise<void> {
    try {
      await window.piBuddy.tasks.resume(workspaceId, id);
      await refresh(workspaceId);
    } catch (err) {
      fail(err);
    }
  }

  async function runNow(workspaceId: string, id: string): Promise<void> {
    try {
      await window.piBuddy.tasks.runNow(workspaceId, id);
      await refresh(workspaceId);
    } catch (err) {
      fail(err);
    }
  }

  async function cancelRun(workspaceId: string, taskId: string, runId: string): Promise<void> {
    try {
      await window.piBuddy.tasks.cancelRun(workspaceId, taskId, runId);
      await refresh(workspaceId);
    } catch (err) {
      fail(err);
    }
  }

  async function retryRun(workspaceId: string, taskId: string, runId: string): Promise<void> {
    try {
      await window.piBuddy.tasks.retryRun(workspaceId, taskId, runId);
      await refresh(workspaceId);
    } catch (err) {
      fail(err);
    }
  }

  async function duplicate(workspaceId: string, id: string): Promise<void> {
    try {
      await window.piBuddy.tasks.duplicate(workspaceId, id);
      await refresh(workspaceId);
    } catch (err) {
      fail(err);
    }
  }

  return {
    panelOpen,
    items,
    detail,
    selectedId,
    lastError,
    loading,
    refresh,
    select,
    clearSelection,
    create,
    update,
    remove,
    pause,
    resume,
    runNow,
    cancelRun,
    retryRun,
    duplicate,
  };
});
