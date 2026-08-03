/**
 * Git 能力包的渲染侧状态（coding.git / GIT-101）。
 *
 * 渲染进程只做两件事：**把仓库状态与 diff 画出来**、**把用户的意图交给
 * 主进程**。真正跑 git、决定放不放行都在主进程——因此这里没有任何「直接
 * 执行」的能力。每条 git 通道都要 process.git 授权，未授权时主进程第五道闸
 * 会抛 `IPC_PERMISSION_DENIED`，本 store 据此**唤起权限裁决弹窗**
 * （复用 permission store），用户授权后再重试即可。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type {
  ChangesetDiff,
  GitFileEntry,
  GitStatusResult,
} from "@contract";

import { usePermissionStore } from "./permission";

/** 未授权时主进程第五道闸抛出的错误前缀。 */
const PERMISSION_DENIED = "IPC_PERMISSION_DENIED";

export const useGitStore = defineStore("git", () => {
  const isRepo = ref(false);
  const branch = ref<string | null>(null);
  const detached = ref(false);
  const entries = shallowRef<GitFileEntry[]>([]);
  const branches = shallowRef<string[]>([]);
  const diffs = shallowRef<Record<string, ChangesetDiff>>({});
  const lastError = ref("");
  /** 上一次操作是否因缺 process.git 授权被挡下（供面板显示「去授权」）。 */
  const needsPermission = ref(false);
  const busy = ref(false);

  const staged = computed(() => entries.value.filter((e) => e.staged));
  const unstaged = computed(() => entries.value.filter((e) => !e.staged || e.y !== " "));

  /**
   * 统一的错误收口：把「被权限挡下」与真实故障分开。前者唤起裁决弹窗，
   * 后者只记一条错误。返回 true 表示这次调用被权限挡下（调用方据此中止）。
   */
  function handleError(err: unknown): boolean {
    const message = (err as Error)?.message ?? String(err);
    if (message.includes(PERMISSION_DENIED)) {
      needsPermission.value = true;
      usePermissionStore().request({
        capabilityId: "coding.git",
        permission: "process.git",
        resource: null,
      });
      lastError.value = "";
      return true;
    }
    lastError.value = message;
    return false;
  }

  /** 拉一次仓库状态（探测 + 分支 + 逐文件状态）。 */
  async function refresh(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    busy.value = true;
    try {
      const state: GitStatusResult = await window.piBuddy.git.status(workspaceId);
      isRepo.value = state.isRepo;
      branch.value = state.branch;
      detached.value = state.detached;
      entries.value = state.entries;
      needsPermission.value = false;
      lastError.value = "";
      if (state.isRepo) await loadBranches(workspaceId);
    } catch (err) {
      handleError(err);
    } finally {
      busy.value = false;
    }
  }

  async function loadBranches(workspaceId: string): Promise<void> {
    try {
      const res = await window.piBuddy.git.branchList(workspaceId);
      branches.value = res.branches;
      if (res.current) branch.value = res.current;
    } catch (err) {
      handleError(err);
    }
  }

  /** 取某文件的 diff 并缓存（key 用 `${staged}:${relativePath}`）。 */
  async function loadDiff(
    workspaceId: string,
    relativePath: string,
    stagedSide: boolean
  ): Promise<void> {
    try {
      const diff = await window.piBuddy.git.diff(workspaceId, relativePath, stagedSide);
      diffs.value = { ...diffs.value, [`${stagedSide}:${relativePath}`]: diff };
    } catch (err) {
      handleError(err);
    }
  }

  function diffFor(relativePath: string, stagedSide: boolean): ChangesetDiff | undefined {
    return diffs.value[`${stagedSide}:${relativePath}`];
  }

  /** 把一个 git 动作跑完再刷新状态；被权限挡下则不刷新（状态没变）。 */
  async function run(
    workspaceId: string,
    action: () => Promise<{ ok: boolean; message?: string | null }>
  ): Promise<boolean> {
    busy.value = true;
    try {
      const res = await action();
      if (!res.ok && res.message) lastError.value = res.message;
      else lastError.value = "";
      await refresh(workspaceId);
      return res.ok;
    } catch (err) {
      handleError(err);
      return false;
    } finally {
      busy.value = false;
    }
  }

  const stage = (ws: string, p: string) => run(ws, () => window.piBuddy.git.stage(ws, p));
  const unstage = (ws: string, p: string) => run(ws, () => window.piBuddy.git.unstage(ws, p));
  const revert = (ws: string, p: string) => run(ws, () => window.piBuddy.git.revert(ws, p));
  const commit = (ws: string, message: string) =>
    run(ws, () => window.piBuddy.git.commit(ws, message));
  const branchCreate = (ws: string, name: string) =>
    run(ws, () => window.piBuddy.git.branchCreate(ws, name));
  const branchSwitch = (ws: string, name: string) =>
    run(ws, () => window.piBuddy.git.branchSwitch(ws, name));

  return {
    isRepo,
    branch,
    detached,
    entries,
    branches,
    diffs,
    lastError,
    needsPermission,
    busy,
    staged,
    unstaged,
    refresh,
    loadBranches,
    loadDiff,
    diffFor,
    stage,
    unstage,
    revert,
    commit,
    branchCreate,
    branchSwitch,
  };
});
