/**
 * `window.piBuddy.git`（coding.git / GIT-101）。
 *
 * 九个方法、九条窄通道。渲染进程能表达的极限是「查状态 / 看某文件的 diff /
 * stage / unstage / revert / commit / 列举·创建·切换分支」——**没有**任何
 * 能承载 argv 或命令行的形参，也没有 `invoke(channel, args)` 那种无约束入口
 * （D4 规则 1）。真正跑 git 的地方在主进程（execFile + shell:false），且每条
 * 通道都要 process.git 授权：渲染进程即便被攻陷，也只能发出这九个意图之一，
 * 未授权时被主进程第五道闸挡下。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（那个子入口不依赖 zod），
 * 理由见 bridge.ts 的注释。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type {
  ChangesetDiff,
  GitActionResult,
  GitBranchListResult,
  GitCommitResult,
  GitDiffHunksResult,
  GitLogResult,
  GitNetworkResult,
  GitShowResult,
  GitStashListResult,
  GitStatusResult,
  GitWorktreeCompareResult,
  GitWorktreeListResult,
  GitWorktreeOpenResult,
} from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const git = {
  /** 仓库探测 + 当前分支 + 逐文件状态。 */
  status: (workspaceId: string) =>
    invoke<GitStatusResult>(CHANNELS.gitStatus, { workspaceId }),

  /** 某文件的逐行 diff（staged=false 未暂存 / true 已暂存），复用 changeset 的 hunk 表示。 */
  diff: (workspaceId: string, relativePath: string, staged = false) =>
    invoke<ChangesetDiff>(CHANNELS.gitDiff, { workspaceId, relativePath, staged }),

  /** 暂存一个文件。 */
  stage: (workspaceId: string, relativePath: string) =>
    invoke<GitActionResult>(CHANNELS.gitStage, { workspaceId, relativePath }),

  /** 取消暂存一个文件。 */
  unstage: (workspaceId: string, relativePath: string) =>
    invoke<GitActionResult>(CHANNELS.gitUnstage, { workspaceId, relativePath }),

  /** 安全回退一个文件未提交的改动（丢弃前先备份）。 */
  revert: (workspaceId: string, relativePath: string) =>
    invoke<GitActionResult>(CHANNELS.gitRevert, { workspaceId, relativePath }),

  /** 提交已暂存的改动。message 经 argv 传，不拼进任何 shell。 */
  commit: (workspaceId: string, message: string) =>
    invoke<GitCommitResult>(CHANNELS.gitCommit, { workspaceId, message }),

  /** 本地分支列表 + 当前分支。 */
  branchList: (workspaceId: string) =>
    invoke<GitBranchListResult>(CHANNELS.gitBranchList, { workspaceId }),

  /** 创建分支（不切换）。 */
  branchCreate: (workspaceId: string, name: string) =>
    invoke<GitActionResult>(CHANNELS.gitBranchCreate, { workspaceId, name }),

  /** 切换分支。工作树有冲突时 git 自己会拒绝，如实返回原因。 */
  branchSwitch: (workspaceId: string, name: string) =>
    invoke<GitActionResult>(CHANNELS.gitBranchSwitch, { workspaceId, name }),

  // ---- v2：网络（凭据由 git 子进程经 credential helper 处理，PiBuddy 不经手 token） ----
  /** fetch。remote 省略走 git 默认。 */
  fetch: (workspaceId: string, remote: string | null = null) =>
    invoke<GitNetworkResult>(CHANNELS.gitFetch, { workspaceId, remote }),
  /** pull（fetch + 合并）。 */
  pull: (workspaceId: string, remote: string | null = null, branch: string | null = null) =>
    invoke<GitNetworkResult>(CHANNELS.gitPull, { workspaceId, remote, branch }),
  /** push（普通推送，非 force）。setUpstream=true 时带 -u。 */
  push: (
    workspaceId: string,
    remote: string | null = null,
    branch: string | null = null,
    setUpstream = false
  ) => invoke<GitNetworkResult>(CHANNELS.gitPush, { workspaceId, remote, branch, setUpstream }),

  // ---- v2：危险操作（除 process.git 外，主进程再走一次原生二次确认） ----
  /** force push（--force-with-lease）。主进程弹原生二次确认，列出精确范围。 */
  forcePush: (workspaceId: string, remote: string, branch: string) =>
    invoke<GitNetworkResult>(CHANNELS.gitForcePush, { workspaceId, remote, branch }),
  /** reset --hard 到某 ref。主进程弹原生二次确认。 */
  resetHard: (workspaceId: string, ref: string) =>
    invoke<GitActionResult>(CHANNELS.gitResetHard, { workspaceId, ref }),
  /** 强制删除分支（-D）。主进程弹原生二次确认。 */
  branchDelete: (workspaceId: string, name: string) =>
    invoke<GitActionResult>(CHANNELS.gitBranchDelete, { workspaceId, name }),

  // ---- v2：stash ----
  stashSave: (
    workspaceId: string,
    message: string | null = null,
    includeUntracked = false
  ) => invoke<GitActionResult>(CHANNELS.gitStashSave, { workspaceId, message, includeUntracked }),
  stashList: (workspaceId: string) =>
    invoke<GitStashListResult>(CHANNELS.gitStashList, { workspaceId }),
  stashPop: (workspaceId: string, index: number) =>
    invoke<GitActionResult>(CHANNELS.gitStashPop, { workspaceId, index }),
  stashDrop: (workspaceId: string, index: number) =>
    invoke<GitActionResult>(CHANNELS.gitStashDrop, { workspaceId, index }),

  // ---- v2：history ----
  log: (
    workspaceId: string,
    relativePath: string | null = null,
    limit = 50,
    skip = 0
  ) => invoke<GitLogResult>(CHANNELS.gitLog, { workspaceId, relativePath, limit, skip }),
  show: (workspaceId: string, ref: string) =>
    invoke<GitShowResult>(CHANNELS.gitShow, { workspaceId, ref }),

  // ---- v2：worktree（不透明 id，路径不外发） ----
  worktreeCreate: (workspaceId: string, name: string, branch: string, newBranch = false) =>
    invoke<GitActionResult>(CHANNELS.gitWorktreeCreate, { workspaceId, name, branch, newBranch }),
  worktreeList: (workspaceId: string) =>
    invoke<GitWorktreeListResult>(CHANNELS.gitWorktreeList, { workspaceId }),
  /** open：把 worktree 注册成工作区，回 workspaceId 供切过去。 */
  worktreeOpen: (workspaceId: string, id: string) =>
    invoke<GitWorktreeOpenResult>(CHANNELS.gitWorktreeOpen, { workspaceId, id }),
  worktreeRename: (workspaceId: string, id: string, newName: string) =>
    invoke<GitActionResult>(CHANNELS.gitWorktreeRename, { workspaceId, id, newName }),
  worktreeCompare: (workspaceId: string, id: string, otherId: string | null = null) =>
    invoke<GitWorktreeCompareResult>(CHANNELS.gitWorktreeCompare, { workspaceId, id, otherId }),
  /** remove：默认脏检查，脏则拒绝；force=true 时强制删。 */
  worktreeRemove: (workspaceId: string, id: string, force = false) =>
    invoke<GitActionResult>(CHANNELS.gitWorktreeRemove, { workspaceId, id, force }),

  // ---- v2：hunk 级 stage ----
  diffHunks: (workspaceId: string, relativePath: string, staged = false) =>
    invoke<GitDiffHunksResult>(CHANNELS.gitDiffHunks, { workspaceId, relativePath, staged }),
  stageHunk: (workspaceId: string, relativePath: string, hunkIndex: number) =>
    invoke<GitActionResult>(CHANNELS.gitStageHunk, { workspaceId, relativePath, hunkIndex }),
  unstageHunk: (workspaceId: string, relativePath: string, hunkIndex: number) =>
    invoke<GitActionResult>(CHANNELS.gitUnstageHunk, { workspaceId, relativePath, hunkIndex }),
};
