/**
 * Git 编码能力包的契约（ADR-0002 垂直能力包 / GIT-101 第一批）。
 *
 * ## 这个文件在回答什么
 *
 * `coding.git` 这个**垂直能力**对外声明的九条窄通道：仓库探测 + 状态、
 * 文件/hunk diff、逐文件 stage/unstage、安全 revert、commit、分支
 * 列举/创建/切换。每条通道的入参**只有不透明的 workspaceId + 相对路径 /
 * 分支名 / 提交信息**，没有任何绝对路径、命令行或 argv 字段——真正跑
 * `git` 的地方在主进程（`main/git/**`），渲染进程在结构上表达不出
 * 「执行这条命令」。
 *
 * ## 为什么 diff 复用 changeset 的 review 原语
 *
 * ADR-0002「已知未决」把行级 hunk 的归属留到第二阶段，但**渲染层的 diff
 * 表示只能有一套**：workspace 变更审阅（FS-102）已经有 `ChangesetHunk` /
 * `ChangesetDiff` 与逐行 LCS（`changeset-store.diffLines`）。Git diff 直接
 * 复用同一套 hunk 形状与渲染，避免两套并存的冲突状态——因此本文件的
 * diff 返回值就是 `changesetDiffSchema`，不另造一份。
 *
 * ## 为什么所有 git 动作都要 process.git
 *
 * ADR-0002 D3：即使能力被启用，renderer 被攻陷后也不能**直接**触达 Git。
 * 这九条通道全部登记在 `CHANNEL_PERMISSION_REQUIREMENTS`（main/permission）
 * 里、需要 `process.git`，未授权时被 ipc-guard 的第五道闸挡在 handler 之外
 * ——连只读的 status/diff 也不例外，因为它们同样要起一个 `git` 子进程。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";
import { changesetDiffSchema } from "./workspace.js";

// ---------------------------------------------------------------- 状态

/**
 * 一条工作区变更的状态（`git status --porcelain` 的一行）。
 *
 * `x` / `y` 是 porcelain 的两位状态码（index 侧 / worktree 侧），原样带上
 * 而不是折成一个枚举：折叠会丢掉「同一个文件既有已暂存的修改、又有未暂存
 * 的新修改」这类真实存在的组合态，而那正是逐文件 stage/unstage 要区分的。
 */
export const gitFileEntrySchema = z
  .object({
    /** 仓库根相对路径（来自 git 自己的输出，天然在仓库内） */
    relativePath: z.string().min(1),
    /** index 侧状态码（M/A/D/R/C/?/空格…） */
    x: z.string().max(1),
    /** worktree 侧状态码 */
    y: z.string().max(1),
    /** index 与 HEAD 不同（有已暂存改动） */
    staged: z.boolean(),
    /** 未被 git 跟踪 */
    untracked: z.boolean(),
    /** 重命名/复制的来源路径；否则 null */
    renamedFrom: z.string().nullable(),
  })
  .strict();
export type GitFileEntry = z.infer<typeof gitFileEntrySchema>;

/**
 * `git:status` 的返回。
 *
 * **不含仓库根的绝对路径**：与 workspace-registry 一贯口径一致，真实磁盘
 * 位置只活在主进程。渲染进程拿到的只有「是不是仓库、当前分支、有哪些
 * 相对路径的改动」。
 */
export const gitStatusResultSchema = z
  .object({
    isRepo: z.boolean(),
    /** 当前分支名；detached / 未探测到时为 null */
    branch: z.string().nullable(),
    /** HEAD 处于游离态（detached HEAD） */
    detached: z.boolean(),
    entries: z.array(gitFileEntrySchema),
  })
  .strict();
export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;

export const gitStatusRequestSchema = z.object({ workspaceId: z.string().min(1) }).strict();
export type GitStatusRequest = z.infer<typeof gitStatusRequestSchema>;

// ---------------------------------------------------------------- diff

/**
 * `git:diff` 的入参。
 *
 * `staged` 选的是比较的两端：
 *   - `false`（未暂存）：index ↔ worktree —— 「我还没 stage 的改动」；
 *   - `true`（已暂存）：HEAD ↔ index —— 「我 stage 了、即将提交的改动」。
 * 返回值直接复用 changeset 的 `ChangesetDiff`（见文件头）。
 */
export const gitDiffRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
    staged: z.boolean().default(false),
  })
  .strict();
export type GitDiffRequest = z.infer<typeof gitDiffRequestSchema>;

// ---------------------------------------------------------------- 动作结果

/**
 * 一次 git 动作（stage/unstage/revert/branch）的结果。
 *
 * 无论成败都结构化返回、绝不向上抛：这条链路的终点是一个面板，抛异常只会
 * 变成「点了没反应」。`message` 是给人看的补充（失败原因 / git 的一句
 * stderr），已在主进程侧脱敏。
 */
export const gitActionResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().nullable(),
  })
  .strict();
export type GitActionResult = z.infer<typeof gitActionResultSchema>;

export const gitPathRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
  })
  .strict();
export type GitPathRequest = z.infer<typeof gitPathRequestSchema>;

// ---------------------------------------------------------------- commit

export const gitCommitRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** 提交信息。经 argv 传给 git，不拼进任何 shell */
    message: z.string().min(1),
  })
  .strict();
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;

/**
 * `git:commit` 的结果。
 *
 * `nothingToCommit` 与 `ok:false` 分开：前者是「暂存区空，没什么可提交」
 * （用户的下一步是先 stage），后者是真实故障（缺 user.name / 冲突中 / 磁盘）。
 * 把它们混成一个布尔，用户会对着「提交失败」发呆而不知道其实只是没 stage。
 */
export const gitCommitResultSchema = z
  .object({
    ok: z.boolean(),
    nothingToCommit: z.boolean(),
    /** 新提交的短 hash；未成功时为 null */
    commit: z.string().nullable(),
    message: z.string().nullable(),
  })
  .strict();
export type GitCommitResult = z.infer<typeof gitCommitResultSchema>;

// ---------------------------------------------------------------- 分支

export const gitBranchListResultSchema = z
  .object({
    /** 本地分支名，按 git 输出顺序 */
    branches: z.array(z.string()),
    /** 当前分支；detached 时为 null */
    current: z.string().nullable(),
  })
  .strict();
export type GitBranchListResult = z.infer<typeof gitBranchListResultSchema>;

export const gitBranchNameRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** 分支名。主进程侧过一遍 assertSafeBranchName，拒绝选项注入与非法 ref */
    name: z.string().min(1),
  })
  .strict();
export type GitBranchNameRequest = z.infer<typeof gitBranchNameRequestSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `coding.git` 的九条通道。
 *
 * 分片 id 是 capabilityId 的第二段（`coding.git` → `git`），drift test 据此
 * 把「manifest 声明的通道」与「本分片的键集合」逐条对账。
 */
export const gitContractShard = defineContractShard("git", {
  [CHANNELS.gitStatus]: {
    request: gitStatusRequestSchema,
    response: gitStatusResultSchema,
  },
  [CHANNELS.gitDiff]: {
    request: gitDiffRequestSchema,
    response: changesetDiffSchema,
  },
  [CHANNELS.gitStage]: {
    request: gitPathRequestSchema,
    response: gitActionResultSchema,
  },
  [CHANNELS.gitUnstage]: {
    request: gitPathRequestSchema,
    response: gitActionResultSchema,
  },
  [CHANNELS.gitRevert]: {
    request: gitPathRequestSchema,
    response: gitActionResultSchema,
  },
  [CHANNELS.gitCommit]: {
    request: gitCommitRequestSchema,
    response: gitCommitResultSchema,
  },
  [CHANNELS.gitBranchList]: {
    request: gitStatusRequestSchema,
    response: gitBranchListResultSchema,
  },
  [CHANNELS.gitBranchCreate]: {
    request: gitBranchNameRequestSchema,
    response: gitActionResultSchema,
  },
  [CHANNELS.gitBranchSwitch]: {
    request: gitBranchNameRequestSchema,
    response: gitActionResultSchema,
  },
});

/**
 * `coding.git` 声明的能力 id 与它申请的危险权限。
 *
 * main/permission 的需求表把这九条通道全部指向 `coding.git` / `process.git`，
 * 因此未授权时任意一条 git 通道都被第五道闸挡下。集中在契约层导出，避免
 * 主进程侧散落一堆字符串常量。
 */
export const GIT_CAPABILITY_ID = "coding.git";
export const GIT_PERMISSION = "process.git";

/** 需要 process.git 授权的全部 git 通道（供 main/permission 的需求表引用）。 */
export const GIT_GATED_CHANNELS = [
  CHANNELS.gitStatus,
  CHANNELS.gitDiff,
  CHANNELS.gitStage,
  CHANNELS.gitUnstage,
  CHANNELS.gitRevert,
  CHANNELS.gitCommit,
  CHANNELS.gitBranchList,
  CHANNELS.gitBranchCreate,
  CHANNELS.gitBranchSwitch,
] as const;
