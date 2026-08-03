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
  GitStatusResult,
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
};
