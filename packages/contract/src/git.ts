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

// ================================================================
//  Git 补完整（coding.git v2 / GIT-101·102 剩余）
// ================================================================
//
// v1（上方九条）刻意 defer 了网络与危险类。这一段补上：网络（fetch/pull/push）、
// worktree、stash、history、危险操作（force push / reset --hard / branch -D，走额外
// 原生二次确认）与 hunk 级 stage。全部仍以不透明 workspaceId + 已校验的 ref /
// 相对路径 / 不透明 worktree id 为入参，没有任何 argv 或命令行字段。

// ---------------------------------------------------------------- 网络

/** `git:fetch` 入参。remote 省略时用默认（origin / 当前分支的上游）。 */
export const gitFetchRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** remote 名（如 "origin"）；省略走 git 默认。主进程侧过 assertSafeRemoteName */
    remote: z.string().min(1).nullable().default(null),
  })
  .strict();
export type GitFetchRequest = z.infer<typeof gitFetchRequestSchema>;

/** `git:pull` 入参。 */
export const gitPullRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    remote: z.string().min(1).nullable().default(null),
    branch: z.string().min(1).nullable().default(null),
  })
  .strict();
export type GitPullRequest = z.infer<typeof gitPullRequestSchema>;

/** `git:push` 入参。setUpstream=true 时带 `-u`（第一次推新分支）。 */
export const gitPushRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    remote: z.string().min(1).nullable().default(null),
    branch: z.string().min(1).nullable().default(null),
    setUpstream: z.boolean().default(false),
  })
  .strict();
export type GitPushRequest = z.infer<typeof gitPushRequestSchema>;

/**
 * 网络操作结果。
 *
 * 比 `GitActionResult` 多一个 `output`：fetch/pull/push 的 git 输出（「已是最新」
 * 「Fast-forward」「rejected non-fast-forward」之类）对用户有意义，脱敏截断后带上。
 */
export const gitNetworkResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().nullable(),
    /** git 的一段输出（已脱敏、已截断）；无输出时为 null */
    output: z.string().nullable(),
  })
  .strict();
export type GitNetworkResult = z.infer<typeof gitNetworkResultSchema>;

// ---------------------------------------------------------------- 危险操作

/**
 * `git:force-push` 入参。
 *
 * remote / branch 必填（危险操作不接受「默认目标」——精确范围要能在确认框里逐字
 * 列出）。主进程用 `--force-with-lease` 而非裸 `--force`：别人在你 fetch 之后又推了
 * 东西时会被拒，而不是无声覆盖掉。即便如此，仍走一次原生二次确认。
 */
export const gitForcePushRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    remote: z.string().min(1),
    branch: z.string().min(1),
  })
  .strict();
export type GitForcePushRequest = z.infer<typeof gitForcePushRequestSchema>;

/**
 * `git:reset-hard` 入参。
 *
 * ref 是要 reset 到的目标（如 "HEAD~1" / 一个 short hash）。`git reset --hard` 会
 * **丢弃工作树与暂存区的全部改动**并移动 HEAD，走原生二次确认。
 */
export const gitResetHardRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** reset 目标 ref。主进程侧过 assertSafeRef（拒选项注入与非法 ref） */
    ref: z.string().min(1),
  })
  .strict();
export type GitResetHardRequest = z.infer<typeof gitResetHardRequestSchema>;

// ---------------------------------------------------------------- stash

export const gitStashSaveRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** 备注信息（经 argv 传）；省略时 git 自动生成 */
    message: z.string().nullable().default(null),
    /** 一并 stash 未跟踪文件（`-u`） */
    includeUntracked: z.boolean().default(false),
  })
  .strict();
export type GitStashSaveRequest = z.infer<typeof gitStashSaveRequestSchema>;

/** `git:stash-pop` / `git:stash-drop` 入参：按 stash 栈下标。 */
export const gitStashIndexRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** stash 栈下标（0 = 最近一条，对应 stash@{0}） */
    index: z.number().int().nonnegative(),
  })
  .strict();
export type GitStashIndexRequest = z.infer<typeof gitStashIndexRequestSchema>;

export const gitStashEntrySchema = z
  .object({
    index: z.number().int().nonnegative(),
    /** stash 的描述（`stash@{0}: WIP on main: …`）中冒号后的部分 */
    message: z.string(),
    /** stash 所基于的分支；解析不出时为 null */
    branch: z.string().nullable(),
  })
  .strict();
export type GitStashEntry = z.infer<typeof gitStashEntrySchema>;

export const gitStashListResultSchema = z
  .object({ entries: z.array(gitStashEntrySchema) })
  .strict();
export type GitStashListResult = z.infer<typeof gitStashListResultSchema>;

// ---------------------------------------------------------------- history

/** `git:log` 入参。relativePath 非空时只看该文件的历史。 */
export const gitLogRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1).nullable().default(null),
    /** 取多少条（上限由主进程夹住，防一次拉进十万条历史） */
    limit: z.number().int().positive().max(500).default(50),
    /** 跳过前 N 条（翻页） */
    skip: z.number().int().nonnegative().default(0),
  })
  .strict();
export type GitLogRequest = z.infer<typeof gitLogRequestSchema>;

export const gitCommitSummarySchema = z
  .object({
    hash: z.string(),
    shortHash: z.string(),
    author: z.string(),
    /** 作者日期，ISO 8601 */
    date: z.string(),
    subject: z.string(),
  })
  .strict();
export type GitCommitSummary = z.infer<typeof gitCommitSummarySchema>;

export const gitLogResultSchema = z
  .object({ commits: z.array(gitCommitSummarySchema) })
  .strict();
export type GitLogResult = z.infer<typeof gitLogResultSchema>;

/** `git:show` 入参：看某个提交的详情。 */
export const gitShowRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** 提交 ref（short/long hash / HEAD 等）。主进程侧过 assertSafeRef */
    ref: z.string().min(1),
  })
  .strict();
export type GitShowRequest = z.infer<typeof gitShowRequestSchema>;

/** 一个提交里改动的文件（`--name-status` 的一行）。 */
export const gitShowFileSchema = z
  .object({
    /** 状态码（A/M/D/R…） */
    status: z.string().max(3),
    relativePath: z.string(),
  })
  .strict();
export type GitShowFile = z.infer<typeof gitShowFileSchema>;

export const gitShowResultSchema = z
  .object({
    /** 提交不存在时 found=false，其余字段为空 */
    found: z.boolean(),
    hash: z.string(),
    author: z.string(),
    date: z.string(),
    subject: z.string(),
    body: z.string(),
    files: z.array(gitShowFileSchema),
  })
  .strict();
export type GitShowResult = z.infer<typeof gitShowResultSchema>;

// ---------------------------------------------------------------- worktree

/**
 * `git:worktree-create` 入参。
 *
 * 主进程决定落盘位置（`<userData>/git-worktrees/<workspaceId>/<name>`），渲染进程
 * 只给一个受校验的 name。branch 为要 checkout 的分支；newBranch=true 时同时用
 * `-b` 新建它。
 */
export const gitWorktreeCreateRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** worktree 目录名（过 assertSafeBranchName 同款白名单，防路径穿越） */
    name: z.string().min(1),
    /** 要 checkout 的分支名 */
    branch: z.string().min(1),
    /** true 时用 `-b` 从当前 HEAD 新建 branch，再 checkout 到新 worktree */
    newBranch: z.boolean().default(false),
  })
  .strict();
export type GitWorktreeCreateRequest = z.infer<typeof gitWorktreeCreateRequestSchema>;

/**
 * 一个 worktree 的渲染侧视图。
 *
 * **不含绝对路径**：`id` 是 sha256(worktreePath) 派生的不透明标识，open/rename/
 * remove/compare 都用它回指；`name` 是末段目录名，仅供显示。
 */
export const gitWorktreeEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** 该 worktree checkout 的分支；detached 时为 null */
    branch: z.string().nullable(),
    /** HEAD 短 hash */
    head: z.string(),
    /** 是不是主工作树（仓库根自己那个，不可移除） */
    isMain: z.boolean(),
    /** git 是否给它上了锁（`git worktree lock`） */
    locked: z.boolean(),
  })
  .strict();
export type GitWorktreeEntry = z.infer<typeof gitWorktreeEntrySchema>;

export const gitWorktreeListResultSchema = z
  .object({ worktrees: z.array(gitWorktreeEntrySchema) })
  .strict();
export type GitWorktreeListResult = z.infer<typeof gitWorktreeListResultSchema>;

/** `git:worktree-open` / `git:worktree-remove` 等按不透明 worktree id 定位。 */
export const gitWorktreeIdRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** worktree-list 返回的不透明 id */
    id: z.string().min(1),
  })
  .strict();
export type GitWorktreeIdRequest = z.infer<typeof gitWorktreeIdRequestSchema>;

/**
 * `git:worktree-open` 的结果。
 *
 * open 把该 worktree 目录**注册成一个工作区**并回一个不透明 workspaceId，渲染进程
 * 据它切过去（与 dialog:choose-folder 同一形态）。**不含绝对路径**——displayPath
 * 仅供显示，与 WorkspaceRef 一致。这里自带一份 schema 而不 import ipc-contract 的
 * WorkspaceRef，是因为 ipc-contract 反过来 import 本文件（会成环）。
 */
export const gitWorktreeOpenResultSchema = z
  .object({
    opened: z.boolean(),
    workspaceId: z.string().nullable(),
    displayPath: z.string().nullable(),
    message: z.string().nullable(),
  })
  .strict();
export type GitWorktreeOpenResult = z.infer<typeof gitWorktreeOpenResultSchema>;

export const gitWorktreeRenameRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    id: z.string().min(1),
    /** 新目录名（过 assertSafeBranchName 同款白名单） */
    newName: z.string().min(1),
  })
  .strict();
export type GitWorktreeRenameRequest = z.infer<typeof gitWorktreeRenameRequestSchema>;

/**
 * `git:worktree-remove` 入参。
 *
 * 默认 `force=false`：主进程会先检查目标 worktree 是否 dirty / 有未跟踪 / 有未合并
 * 改动，脏就拒绝并如实说明。用户在界面上再次确认后才带 `force=true` 重试。
 */
export const gitWorktreeRemoveRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    id: z.string().min(1),
    force: z.boolean().default(false),
  })
  .strict();
export type GitWorktreeRemoveRequest = z.infer<typeof gitWorktreeRemoveRequestSchema>;

/** `git:worktree-compare` 入参：比 worktree 的分支与当前分支（otherId 省略）。 */
export const gitWorktreeCompareRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    id: z.string().min(1),
    /** 另一个 worktree id；省略时与当前工作区的分支比 */
    otherId: z.string().min(1).nullable().default(null),
  })
  .strict();
export type GitWorktreeCompareRequest = z.infer<typeof gitWorktreeCompareRequestSchema>;

export const gitWorktreeCompareResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().nullable(),
    /** 目标分支相对基准分支领先 / 落后的提交数 */
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    /** 两分支间改动的文件（`--name-status`） */
    files: z.array(gitShowFileSchema),
  })
  .strict();
export type GitWorktreeCompareResult = z.infer<typeof gitWorktreeCompareResultSchema>;

// ---------------------------------------------------------------- hunk 级 stage

/** `git:diff-hunks` 入参：取 git 原生 unified-diff 的逐 hunk 文本（用于 hunk 级暂存）。 */
export const gitDiffHunksRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
    /** false=工作树↔index（未暂存）；true=index↔HEAD（已暂存） */
    staged: z.boolean().default(false),
  })
  .strict();
export type GitDiffHunksRequest = z.infer<typeof gitDiffHunksRequestSchema>;

/**
 * 一段 git 原生 hunk。
 *
 * 与 changeset 的 `ChangesetHunk`（LCS 逐行、供**渲染**）不同：这里是 git
 * unified diff 的**原始补丁片段**（`@@ … @@` + 上下文/增删行），因为 hunk 级
 * 暂存必须靠 `git apply --cached` 吃回一段合法补丁，而补丁格式只有 git diff 给得出。
 */
export const gitHunkSchema = z
  .object({
    index: z.number().int().nonnegative(),
    /** hunk 头（`@@ -a,b +c,d @@ …`） */
    header: z.string(),
    /** hunk 正文行（含前导 ` ` / `+` / `-`），逐行 */
    lines: z.array(z.string()),
  })
  .strict();
export type GitHunk = z.infer<typeof gitHunkSchema>;

export const gitDiffHunksResultSchema = z
  .object({
    hunks: z.array(gitHunkSchema),
    /** 二进制 / 超大 / 非仓库时的降级说明；非空时 hunks 为空 */
    degraded: z.string().nullable(),
  })
  .strict();
export type GitDiffHunksResult = z.infer<typeof gitDiffHunksResultSchema>;

/** `git:stage-hunk` / `git:unstage-hunk` 入参：按 diff-hunks 返回的下标。 */
export const gitHunkActionRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
    /** 要暂存 / 取消暂存的 hunk 下标（对应 diff-hunks 的 index） */
    hunkIndex: z.number().int().nonnegative(),
  })
  .strict();
export type GitHunkActionRequest = z.infer<typeof gitHunkActionRequestSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `coding.git` 的全部通道（v1 九条 + v2 二十一条 = 三十条）。
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
  // ---- v2：网络 ----
  [CHANNELS.gitFetch]: { request: gitFetchRequestSchema, response: gitNetworkResultSchema },
  [CHANNELS.gitPull]: { request: gitPullRequestSchema, response: gitNetworkResultSchema },
  [CHANNELS.gitPush]: { request: gitPushRequestSchema, response: gitNetworkResultSchema },
  // ---- v2：危险操作（handler 内再走原生二次确认） ----
  [CHANNELS.gitForcePush]: { request: gitForcePushRequestSchema, response: gitNetworkResultSchema },
  [CHANNELS.gitResetHard]: { request: gitResetHardRequestSchema, response: gitActionResultSchema },
  [CHANNELS.gitBranchDelete]: {
    request: gitBranchNameRequestSchema,
    response: gitActionResultSchema,
  },
  // ---- v2：stash ----
  [CHANNELS.gitStashSave]: { request: gitStashSaveRequestSchema, response: gitActionResultSchema },
  [CHANNELS.gitStashList]: { request: gitStatusRequestSchema, response: gitStashListResultSchema },
  [CHANNELS.gitStashPop]: { request: gitStashIndexRequestSchema, response: gitActionResultSchema },
  [CHANNELS.gitStashDrop]: { request: gitStashIndexRequestSchema, response: gitActionResultSchema },
  // ---- v2：history ----
  [CHANNELS.gitLog]: { request: gitLogRequestSchema, response: gitLogResultSchema },
  [CHANNELS.gitShow]: { request: gitShowRequestSchema, response: gitShowResultSchema },
  // ---- v2：worktree ----
  [CHANNELS.gitWorktreeCreate]: {
    request: gitWorktreeCreateRequestSchema,
    response: gitActionResultSchema,
  },
  [CHANNELS.gitWorktreeList]: {
    request: gitStatusRequestSchema,
    response: gitWorktreeListResultSchema,
  },
  [CHANNELS.gitWorktreeOpen]: {
    request: gitWorktreeIdRequestSchema,
    response: gitWorktreeOpenResultSchema,
  },
  [CHANNELS.gitWorktreeRename]: {
    request: gitWorktreeRenameRequestSchema,
    response: gitActionResultSchema,
  },
  [CHANNELS.gitWorktreeCompare]: {
    request: gitWorktreeCompareRequestSchema,
    response: gitWorktreeCompareResultSchema,
  },
  [CHANNELS.gitWorktreeRemove]: {
    request: gitWorktreeRemoveRequestSchema,
    response: gitActionResultSchema,
  },
  // ---- v2：hunk 级 stage ----
  [CHANNELS.gitDiffHunks]: {
    request: gitDiffHunksRequestSchema,
    response: gitDiffHunksResultSchema,
  },
  [CHANNELS.gitStageHunk]: {
    request: gitHunkActionRequestSchema,
    response: gitActionResultSchema,
  },
  [CHANNELS.gitUnstageHunk]: {
    request: gitHunkActionRequestSchema,
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

/**
 * 需要 process.git 授权的全部 git 通道（供 main/permission 的需求表引用）。
 *
 * v2 补上的网络 / worktree / stash / history / 危险 / hunk 通道**一律**在册：
 * 连只读的 log/show/worktree-list/diff-hunks 也要起 git 子进程，因此同样受 process.git
 * 管辖。permission-store 的需求表由本数组派生（`GIT_GATED_CHANNELS.map(...)`），故
 * 扩这个数组即自动给新通道接上第五道闸，无需改动 main/permission 的任何逻辑。
 */
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
  // v2
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
] as const;

/**
 * 危险类 git 通道：process.git 之外还要 handler 内一次**主进程原生二次确认**
 * （精确范围）。仅作文档 / 测试对账用途——实际二次确认由 main/git 的 danger
 * confirmer 实施，与 process.git 的第五道闸相互独立、两道都要过。
 */
export const GIT_DANGEROUS_CHANNELS = [
  CHANNELS.gitForcePush,
  CHANNELS.gitResetHard,
  CHANNELS.gitBranchDelete,
] as const;
