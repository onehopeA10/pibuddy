/**
 * Git 能力包的 IPC handler（coding.git / GIT-101）——**恰 9 条通道**。
 *
 * 九条都以不透明 workspaceId + 相对路径 / 分支名 / 提交信息为入参：真正跑
 * `git` 的地方在 git-cli（execFile + shell:false），渲染进程在结构上表达不出
 * 「执行这条命令」。九条全部登记在 main/permission 的需求表里、需要
 * process.git，未授权时被 ipc-guard 第五道闸挡在 handler 之外——因此这些
 * handler 被调到，本身就意味着该 workspace 上下文已经拿到了 process.git 授权。
 *
 * 本文件不出现 ipcMain.handle：注册一律经 ipc-guard 的 registerHandler。
 * 它是 manifest 的 exposure.module，drift test 据 registerHandler 的通道集合
 * 与 manifest.channels 逐条对账。
 */
import {
  CHANNELS,
  gitBranchNameRequestSchema,
  gitCommitRequestSchema,
  gitDiffRequestSchema,
  gitPathRequestSchema,
  gitStatusRequestSchema,
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
import { getDiff } from "./git-diff.js";
import { getStatus } from "./git-repo.js";

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
];

export function registerGitIpc(): void {
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
}

/**
 * 拆卸本能力的运行期资源（ADR-0002 D4 规则 4）。
 *
 * 只收「还在跑」的 git 子进程（disposeGitCli）。**磁盘上的仓库一个字节不动**
 * ——规则 5：禁用 Git 面板不等于同意丢掉用户的工作树或历史。
 */
export function disposeGitResources(): void {
  disposeGitCli();
}
