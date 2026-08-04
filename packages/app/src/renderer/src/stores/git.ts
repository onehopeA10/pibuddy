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
  GitCommitSummary,
  GitDiffHunksResult,
  GitFileEntry,
  GitStashEntry,
  GitStatusResult,
  GitWorktreeEntry,
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
  // ---- v2 状态 ----
  const commits = shallowRef<GitCommitSummary[]>([]);
  const stashes = shallowRef<GitStashEntry[]>([]);
  const worktrees = shallowRef<GitWorktreeEntry[]>([]);
  /** fetch/pull/push 的最近一段输出（供面板显示「Fast-forward」「已是最新」等）。 */
  const networkOutput = ref("");
  /** hunk 级 diff 缓存，key 用 `${staged}:${relativePath}`。 */
  const hunks = shallowRef<Record<string, GitDiffHunksResult>>({});

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

  // ---- v2：网络 ----

  /** 跑一个返回 GitNetworkResult 的动作，记下它的输出再刷新状态。 */
  async function runNetwork(
    ws: string,
    action: () => Promise<{ ok: boolean; message: string | null; output: string | null }>
  ): Promise<boolean> {
    busy.value = true;
    try {
      const res = await action();
      networkOutput.value = res.output ?? "";
      lastError.value = res.ok ? "" : res.message ?? "";
      await refresh(ws);
      return res.ok;
    } catch (err) {
      handleError(err);
      return false;
    } finally {
      busy.value = false;
    }
  }

  const fetch = (ws: string, remote: string | null = null) =>
    runNetwork(ws, () => window.piBuddy.git.fetch(ws, remote));
  const pull = (ws: string, remote: string | null = null, branch: string | null = null) =>
    runNetwork(ws, () => window.piBuddy.git.pull(ws, remote, branch));
  const push = (
    ws: string,
    remote: string | null = null,
    branch: string | null = null,
    setUpstream = false
  ) => runNetwork(ws, () => window.piBuddy.git.push(ws, remote, branch, setUpstream));

  // ---- v2：危险操作（主进程会再弹一次原生二次确认，此处只发意图） ----
  const forcePush = (ws: string, remote: string, branch: string) =>
    runNetwork(ws, () => window.piBuddy.git.forcePush(ws, remote, branch));
  const resetHard = (ws: string, ref: string) =>
    run(ws, () => window.piBuddy.git.resetHard(ws, ref));
  const branchDelete = (ws: string, name: string) =>
    run(ws, () => window.piBuddy.git.branchDelete(ws, name));

  // ---- v2：stash ----
  const stashSave = (ws: string, message: string | null = null, includeUntracked = false) =>
    run(ws, () => window.piBuddy.git.stashSave(ws, message, includeUntracked));
  async function loadStashes(ws: string): Promise<void> {
    try {
      const res = await window.piBuddy.git.stashList(ws);
      stashes.value = res.entries;
    } catch (err) {
      handleError(err);
    }
  }
  const stashPop = async (ws: string, index: number): Promise<boolean> => {
    const ok = await run(ws, () => window.piBuddy.git.stashPop(ws, index));
    await loadStashes(ws);
    return ok;
  };
  const stashDrop = async (ws: string, index: number): Promise<boolean> => {
    const ok = await run(ws, () => window.piBuddy.git.stashDrop(ws, index));
    await loadStashes(ws);
    return ok;
  };

  // ---- v2：history ----
  async function loadLog(
    ws: string,
    relativePath: string | null = null,
    limit = 50
  ): Promise<void> {
    try {
      const res = await window.piBuddy.git.log(ws, relativePath, limit, 0);
      commits.value = res.commits;
    } catch (err) {
      handleError(err);
    }
  }

  // ---- v2：worktree ----
  async function loadWorktrees(ws: string): Promise<void> {
    try {
      const res = await window.piBuddy.git.worktreeList(ws);
      worktrees.value = res.worktrees;
    } catch (err) {
      handleError(err);
    }
  }
  const worktreeCreate = async (
    ws: string,
    name: string,
    branch: string,
    newBranch = false
  ): Promise<boolean> => {
    const ok = await run(ws, () => window.piBuddy.git.worktreeCreate(ws, name, branch, newBranch));
    await loadWorktrees(ws);
    return ok;
  };
  const worktreeRemove = async (ws: string, id: string, force = false): Promise<boolean> => {
    const ok = await run(ws, () => window.piBuddy.git.worktreeRemove(ws, id, force));
    await loadWorktrees(ws);
    return ok;
  };
  /** open 返回被打开 worktree 的 workspaceId（成功时），供上层切换工作区。 */
  async function worktreeOpen(ws: string, id: string): Promise<string | null> {
    try {
      const res = await window.piBuddy.git.worktreeOpen(ws, id);
      if (!res.opened) lastError.value = res.message ?? "打开失败";
      return res.opened ? res.workspaceId : null;
    } catch (err) {
      handleError(err);
      return null;
    }
  }

  // ---- v2：hunk 级 stage ----
  async function loadHunks(ws: string, relativePath: string, stagedSide: boolean): Promise<void> {
    try {
      const res = await window.piBuddy.git.diffHunks(ws, relativePath, stagedSide);
      hunks.value = { ...hunks.value, [`${stagedSide}:${relativePath}`]: res };
    } catch (err) {
      handleError(err);
    }
  }
  function hunksFor(relativePath: string, stagedSide: boolean): GitDiffHunksResult | undefined {
    return hunks.value[`${stagedSide}:${relativePath}`];
  }
  const stageHunk = async (ws: string, relativePath: string, hunkIndex: number): Promise<boolean> => {
    const ok = await run(ws, () => window.piBuddy.git.stageHunk(ws, relativePath, hunkIndex));
    await loadHunks(ws, relativePath, false);
    return ok;
  };
  const unstageHunk = async (ws: string, relativePath: string, hunkIndex: number): Promise<boolean> => {
    const ok = await run(ws, () => window.piBuddy.git.unstageHunk(ws, relativePath, hunkIndex));
    await loadHunks(ws, relativePath, true);
    return ok;
  };

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
    // v2 状态
    commits,
    stashes,
    worktrees,
    networkOutput,
    hunks,
    // v2 动作
    fetch,
    pull,
    push,
    forcePush,
    resetHard,
    branchDelete,
    stashSave,
    loadStashes,
    stashPop,
    stashDrop,
    loadLog,
    loadWorktrees,
    worktreeCreate,
    worktreeRemove,
    worktreeOpen,
    loadHunks,
    hunksFor,
    stageHunk,
    unstageHunk,
  };
});
