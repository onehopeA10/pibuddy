/**
 * Git 能力包的 IPC handler（coding.git v1 + v2）——**恰 30 条通道**。
 *
 * 全部以不透明 workspaceId + 相对路径 / 分支名·ref / 提交信息 / 不透明 worktree id
 * 为入参：真正跑 `git` 的地方在 git-cli（execFile + shell:false），渲染进程在结构上
 * 表达不出「执行这条命令」。三十条全部登记在 main/permission 的需求表里、需要
 * process.git，未授权时被 ipc-guard 第五道闸挡在 handler 之外。危险类三条
 * （force push / reset --hard / branch -D）除 process.git 外，handler 内再走一次主进程
 * 原生二次确认（见 git-danger）。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。它是 manifest
 * 的 exposure.module，drift test 据 registerHandler 的通道集合与 manifest.channels 逐条对账。
 */
import {
  CHANNELS,
  gitBranchNameRequestSchema,
  gitCommitRequestSchema,
  gitDiffHunksRequestSchema,
  gitDiffRequestSchema,
  gitFetchRequestSchema,
  gitForcePushRequestSchema,
  gitHunkActionRequestSchema,
  gitLogRequestSchema,
  gitPathRequestSchema,
  gitPullRequestSchema,
  gitPushRequestSchema,
  gitResetHardRequestSchema,
  gitShowRequestSchema,
  gitStashIndexRequestSchema,
  gitStashSaveRequestSchema,
  gitStatusRequestSchema,
  gitWorktreeCompareRequestSchema,
  gitWorktreeCreateRequestSchema,
  gitWorktreeIdRequestSchema,
  gitWorktreeRemoveRequestSchema,
  gitWorktreeRenameRequestSchema,
  type InvokeChannel,
} from "@pibuddy/contract";

import { registerHandler } from "../ipc-guard.js";
import {
  branchCreate,
  branchList,
  branchSwitch,
  commit,
  revertPath,
  stagePath,
  unstagePath,
} from "./git-actions.js";
import { disposeGitCli } from "./git-cli.js";
import { branchDelete, forcePush, resetHard } from "./git-danger.js";
import { getDiff } from "./git-diff.js";
import { diffHunks, stageHunk, unstageHunk } from "./git-hunk.js";
import { log, show } from "./git-history.js";
import { fetch, pull, push } from "./git-network.js";
import { getStatus } from "./git-repo.js";
import { stashDrop, stashList, stashPop, stashSave } from "./git-stash.js";
import {
  worktreeCompare,
  worktreeCreate,
  worktreeList,
  worktreeOpen,
  worktreeRemove,
  worktreeRename,
} from "./git-worktree.js";

/** 本域注册的全部通道。单测据它断言注册面。 */
export const GIT_CHANNELS: InvokeChannel[] = [
  CHANNELS.gitStatus,
  CHANNELS.gitDiff,
  CHANNELS.gitStage,
  CHANNELS.gitUnstage,
  CHANNELS.gitRevert,
  CHANNELS.gitCommit,
  CHANNELS.gitBranchList,
  CHANNELS.gitBranchCreate,
  CHANNELS.gitBranchSwitch,
  CHANNELS.gitFetch,
  CHANNELS.gitPull,
  CHANNELS.gitPush,
  CHANNELS.gitForcePush,
  CHANNELS.gitResetHard,
  CHANNELS.gitBranchDelete,
  CHANNELS.gitStashSave,
  CHANNELS.gitStashList,
  CHANNELS.gitStashPop,
  CHANNELS.gitStashDrop,
  CHANNELS.gitLog,
  CHANNELS.gitShow,
  CHANNELS.gitWorktreeCreate,
  CHANNELS.gitWorktreeList,
  CHANNELS.gitWorktreeOpen,
  CHANNELS.gitWorktreeRename,
  CHANNELS.gitWorktreeCompare,
  CHANNELS.gitWorktreeRemove,
  CHANNELS.gitDiffHunks,
  CHANNELS.gitStageHunk,
  CHANNELS.gitUnstageHunk,
];

export function registerGitIpc(): void {
  // ---- v1：状态 / diff / stage / commit / branch ----
  registerHandler(CHANNELS.gitStatus, gitStatusRequestSchema, (payload) =>
    getStatus(payload.workspaceId)
  );
  registerHandler(CHANNELS.gitDiff, gitDiffRequestSchema, (payload) =>
    getDiff(payload.workspaceId, payload.relativePath, payload.staged)
  );
  registerHandler(CHANNELS.gitStage, gitPathRequestSchema, (payload) =>
    stagePath(payload.workspaceId, payload.relativePath)
  );
  registerHandler(CHANNELS.gitUnstage, gitPathRequestSchema, (payload) =>
    unstagePath(payload.workspaceId, payload.relativePath)
  );
  registerHandler(CHANNELS.gitRevert, gitPathRequestSchema, (payload) =>
    revertPath(payload.workspaceId, payload.relativePath)
  );
  registerHandler(CHANNELS.gitCommit, gitCommitRequestSchema, (payload) =>
    commit(payload.workspaceId, payload.message)
  );
  registerHandler(CHANNELS.gitBranchList, gitStatusRequestSchema, (payload) =>
    branchList(payload.workspaceId)
  );
  registerHandler(CHANNELS.gitBranchCreate, gitBranchNameRequestSchema, (payload) =>
    branchCreate(payload.workspaceId, payload.name)
  );
  registerHandler(CHANNELS.gitBranchSwitch, gitBranchNameRequestSchema, (payload) =>
    branchSwitch(payload.workspaceId, payload.name)
  );

  // ---- v2：网络 ----
  registerHandler(CHANNELS.gitFetch, gitFetchRequestSchema, (payload) =>
    fetch(payload.workspaceId, payload.remote)
  );
  registerHandler(CHANNELS.gitPull, gitPullRequestSchema, (payload) =>
    pull(payload.workspaceId, payload.remote, payload.branch)
  );
  registerHandler(CHANNELS.gitPush, gitPushRequestSchema, (payload) =>
    push(payload.workspaceId, payload.remote, payload.branch, payload.setUpstream)
  );

  // ---- v2：危险操作（handler 内二次确认） ----
  registerHandler(CHANNELS.gitForcePush, gitForcePushRequestSchema, (payload) =>
    forcePush(payload.workspaceId, payload.remote, payload.branch)
  );
  registerHandler(CHANNELS.gitResetHard, gitResetHardRequestSchema, (payload) =>
    resetHard(payload.workspaceId, payload.ref)
  );
  registerHandler(CHANNELS.gitBranchDelete, gitBranchNameRequestSchema, (payload) =>
    branchDelete(payload.workspaceId, payload.name)
  );

  // ---- v2：stash ----
  registerHandler(CHANNELS.gitStashSave, gitStashSaveRequestSchema, (payload) =>
    stashSave(payload.workspaceId, payload.message, payload.includeUntracked)
  );
  registerHandler(CHANNELS.gitStashList, gitStatusRequestSchema, (payload) =>
    stashList(payload.workspaceId)
  );
  registerHandler(CHANNELS.gitStashPop, gitStashIndexRequestSchema, (payload) =>
    stashPop(payload.workspaceId, payload.index)
  );
  registerHandler(CHANNELS.gitStashDrop, gitStashIndexRequestSchema, (payload) =>
    stashDrop(payload.workspaceId, payload.index)
  );

  // ---- v2：history ----
  registerHandler(CHANNELS.gitLog, gitLogRequestSchema, (payload) =>
    log(payload.workspaceId, payload.relativePath, payload.limit, payload.skip)
  );
  registerHandler(CHANNELS.gitShow, gitShowRequestSchema, (payload) =>
    show(payload.workspaceId, payload.ref)
  );

  // ---- v2：worktree ----
  registerHandler(CHANNELS.gitWorktreeCreate, gitWorktreeCreateRequestSchema, (payload) =>
    worktreeCreate(payload.workspaceId, payload.name, payload.branch, payload.newBranch)
  );
  registerHandler(CHANNELS.gitWorktreeList, gitStatusRequestSchema, (payload) =>
    worktreeList(payload.workspaceId)
  );
  registerHandler(CHANNELS.gitWorktreeOpen, gitWorktreeIdRequestSchema, (payload) =>
    worktreeOpen(payload.workspaceId, payload.id)
  );
  registerHandler(CHANNELS.gitWorktreeRename, gitWorktreeRenameRequestSchema, (payload) =>
    worktreeRename(payload.workspaceId, payload.id, payload.newName)
  );
  registerHandler(CHANNELS.gitWorktreeCompare, gitWorktreeCompareRequestSchema, (payload) =>
    worktreeCompare(payload.workspaceId, payload.id, payload.otherId)
  );
  registerHandler(CHANNELS.gitWorktreeRemove, gitWorktreeRemoveRequestSchema, (payload) =>
    worktreeRemove(payload.workspaceId, payload.id, payload.force)
  );

  // ---- v2：hunk 级 stage ----
  registerHandler(CHANNELS.gitDiffHunks, gitDiffHunksRequestSchema, (payload) =>
    diffHunks(payload.workspaceId, payload.relativePath, payload.staged)
  );
  registerHandler(CHANNELS.gitStageHunk, gitHunkActionRequestSchema, (payload) =>
    stageHunk(payload.workspaceId, payload.relativePath, payload.hunkIndex)
  );
  registerHandler(CHANNELS.gitUnstageHunk, gitHunkActionRequestSchema, (payload) =>
    unstageHunk(payload.workspaceId, payload.relativePath, payload.hunkIndex)
  );
}

/**
 * 拆卸本能力的运行期资源（ADR-0002 D4 规则 4）。
 *
 * 只收「还在跑」的 git 子进程（disposeGitCli）。**磁盘上的仓库一个字节不动**
 * ——规则 5：禁用 Git 面板不等于同意丢掉用户的工作树或历史。worktree 目录同理
 * 不删（卸载 ≠ 删数据）。
 */
export function disposeGitResources(): void {
  disposeGitCli();
}
