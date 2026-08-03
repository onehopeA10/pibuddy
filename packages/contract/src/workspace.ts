/**
 * Workspace 文件服务与 Agent 变更集的契约（FS-101 / FS-102）。
 *
 * ## 这里为什么一个字段都不叫 `path`
 *
 * 跨进程边界上**只有 relativePath**。绝对路径（canonical root、文件真实
 * 位置）从头到尾只存在于主进程：渲染进程拿到一个 relativePath 推断不出
 * 磁盘布局，也无法用它去够工作区外的东西 —— 收容判定在 main 侧由
 * `resolveInWorkspace` 唯一实现（CT-18），本文件的类型只是那条判定的
 * 输入输出形状。
 *
 * ## 冲突语义为什么写进契约
 *
 * 「保存」和「接受变更」是两条完全不同的代码路径，却共享同一个判据：
 * 落盘前重算 sha256，与调用方持有的 base 不符即拒绝写入。把
 * `{ conflict: true, current: {...} }` 这个形状放在契约里，是为了让两边
 * 不可能各写一套 —— 两套判据的表现是「编辑器拦得住、变更集拦不住」，
 * 而后者一次静默覆盖就是用户的工作丢了。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

// ---------------------------------------------------------------- 基础

/** 工作区信任态。未知 = 还没问过用户。 */
export const workspaceTrustSchema = z.enum(["trusted", "untrusted", "unknown"]);
export type WorkspaceTrust = z.infer<typeof workspaceTrustSchema>;

/**
 * 文本编码标签。
 *
 * 只有这三种是**能可靠判定**的：UTF-8 BOM 靠首三字节，无 BOM UTF-8 靠
 * 严格解码是否成功，剩下的中文环境里几乎只剩 GBK。再往下猜（Latin-1、
 * Shift-JIS…）会把「猜错了就写坏文件」的风险换成一个说不清的收益。
 */
export const textEncodingSchema = z.enum(["utf8", "utf8-bom", "gbk", "binary"]);
export type TextEncodingLabel = z.infer<typeof textEncodingSchema>;

/** 换行风格。保存时原样写回，绝不「顺手规范化」用户的文件。 */
export const newlineStyleSchema = z.enum(["lf", "crlf"]);
export type NewlineStyle = z.infer<typeof newlineStyleSchema>;

/** 文件写入失败的分类。分类存在的意义是让用户看到能据以行动的那句话。 */
export const fileErrorCodeSchema = z.enum(["permission", "disk", "encoding", "missing", "conflict"]);
export type FileErrorCode = z.infer<typeof fileErrorCodeSchema>;

// ---------------------------------------------------------------- 文件树

export const fileTreeEntrySchema = z.object({
  /** 相对工作区 root 的路径，POSIX 分隔符。root 自身为空串 */
  relativePath: z.string(),
  name: z.string(),
  isDirectory: z.boolean(),
  /** 符号链接 / junction：**不跟随**，UI 上标出来但不展开 */
  isSymlink: z.boolean(),
  sizeBytes: z.number().nonnegative(),
  mtimeMs: z.number(),
  /** 被 ignore 规则命中（默认折叠，仍然列出来让用户知道它存在） */
  ignored: z.boolean(),
});
export type FileTreeEntry = z.infer<typeof fileTreeEntrySchema>;

/**
 * 列一层目录的结果。
 *
 * `truncated` 不是「出错了」而是「这一层太大，先给你前 N 项」：一个
 * 装了 12 万个文件的目录如果老老实实全列出来，主进程序列化一次、渲染
 * 进程再建 12 万个 DOM 节点，表现是整个应用假死若干秒。
 */
export const fileTreePageSchema = z.object({
  relativePath: z.string(),
  entries: z.array(fileTreeEntrySchema),
  truncated: z.boolean(),
  /** 该目录的真实条目总数（含被截断的部分） */
  total: z.number().nonnegative(),
});
export type FileTreePage = z.infer<typeof fileTreePageSchema>;

export const treeListRequestSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string(),
  /** true 时把被 ignore 的条目也一并返回（UI 上的「显示隐藏文件」） */
  includeIgnored: z.boolean().optional(),
  /** 超过它即 truncated；不传走 main 侧默认值 */
  limit: z.number().int().positive().optional(),
});

export const treeWatchRequestSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string(),
  /** false = 取消该目录的监听 */
  watching: z.boolean(),
});

/**
 * 释放一个工作区在主进程侧占用的资源（watcher + 搜索子进程）。
 *
 * 切换工作区时必须发一次：不发的话 fs.watch 句柄与 utility process 会随
 * 切换次数线性累积，而两者都**不会报错** —— 前者的表现是几小时后文件树
 * 停止刷新，后者的表现是任务管理器里越攒越多的子进程。
 */
export const workspaceReleaseRequestSchema = z.object({
  workspaceId: z.string().min(1),
});

// ---------------------------------------------------------------- 搜索

export const workspaceSearchHitSchema = z.object({
  relativePath: z.string(),
  /** 1 起的行号；文件名命中为 0 */
  line: z.number().int().nonnegative(),
  /** 受限预览，main 侧硬截断到 200 字符 */
  preview: z.string(),
});
export type WorkspaceSearchHit = z.infer<typeof workspaceSearchHitSchema>;

export const workspaceSearchPageSchema = z.object({
  items: z.array(workspaceSearchHitSchema),
  /** `${fileIndex}:${lineIndex}`；null 表示没有下一页 */
  nextCursor: z.string().nullable(),
  /** 命中数达到上限、还有更多结果没返回 */
  truncated: z.boolean(),
  /** 被 AbortSignal 取消（items 是取消前已经攒到的部分） */
  cancelled: z.boolean(),
});
export type WorkspaceSearchPage = z.infer<typeof workspaceSearchPageSchema>;

export const workspaceSearchRequestSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().min(1),
  /** name = 只搜文件名；content = 搜正文 */
  mode: z.enum(["name", "content"]).optional(),
  limit: z.number().int().positive().optional(),
  cursor: z.string().nullable().optional(),
  /** 由渲染进程生成，用于事后取消这一次搜索 */
  requestId: z.string().min(1),
});

export const workspaceSearchCancelSchema = z.object({
  requestId: z.string().min(1),
});

// ---------------------------------------------------------------- 读 / 写

export const fileReadRequestSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1),
});

export const fileReadResultSchema = z.object({
  relativePath: z.string(),
  /** 二进制或超限时为空串，由 `binary` / `tooLarge` 说明原因 */
  content: z.string(),
  encoding: textEncodingSchema,
  newline: newlineStyleSchema,
  /** 保存时回传，作为冲突判据的一半 */
  mtimeMs: z.number(),
  /** 保存时回传，作为冲突判据的另一半（也是唯一有决定权的那一半） */
  sha256: z.string(),
  sizeBytes: z.number().nonnegative(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
});
export type FileReadResult = z.infer<typeof fileReadResultSchema>;

export const fileSaveRequestSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string(),
  /** 读到这份内容时的 mtime；只用于**跳过**重算，不单独构成拒绝理由 */
  baseMtimeMs: z.number(),
  /** 读到这份内容时的 sha256 —— 冲突判定的唯一权威 */
  baseSha256: z.string(),
  /** 用户在冲突对话框里点了「覆盖」；跳过冲突检查，其余校验照做 */
  overwrite: z.boolean().optional(),
});

/** 磁盘当前状态的快照，供三方比较（编辑缓冲 / base / 磁盘）。 */
export const fileCurrentStateSchema = z.object({
  mtimeMs: z.number(),
  sha256: z.string(),
  /** 受限预览，不回传整个文件 */
  preview: z.string(),
});

export const fileSaveResultSchema = z.object({
  ok: z.boolean(),
  /** 磁盘上的内容已不是 base：**没有写任何字节** */
  conflict: z.boolean().optional(),
  current: fileCurrentStateSchema.optional(),
  errorCode: fileErrorCodeSchema.optional(),
  message: z.string().optional(),
  mtimeMs: z.number().optional(),
  sha256: z.string().optional(),
});
export type FileSaveResult = z.infer<typeof fileSaveResultSchema>;

// ---------------------------------------------------------------- 变更文件

/** 新建 / 重命名 / 移动 / 复制 / 删除（回收站） / 恢复。 */
export const fileMutateKindSchema = z.enum([
  "create-file",
  "create-dir",
  "rename",
  "move",
  "copy",
  "trash",
]);
export type FileMutateKind = z.infer<typeof fileMutateKindSchema>;

export const fileMutateRequestSchema = z.object({
  workspaceId: z.string().min(1),
  kind: fileMutateKindSchema,
  relativePath: z.string().min(1),
  /** rename / move / copy 的目标；其余动作不传 */
  targetPath: z.string().optional(),
});

export const fileMutateResultSchema = z.object({
  ok: z.boolean(),
  relativePath: z.string().optional(),
  errorCode: fileErrorCodeSchema.optional(),
  message: z.string().optional(),
  /** 破坏性动作的精确范围：将被影响的条目数与前若干条相对路径 */
  affected: z.array(z.string()).optional(),
});
export type FileMutateResult = z.infer<typeof fileMutateResultSchema>;

// ---------------------------------------------------------------- 结构化附件

/**
 * 结构化附件引用（裁定2）。
 *
 * 取代「把绝对路径当可信输入」的旧形态。八个字段一个不多一个不少 ——
 * 标识字段名恒为 `token`（全计划统一称谓），没有 `id`，更没有
 * `attachmentId`。
 */
export const attachmentDescriptorSchema = z.object({
  token: z.string().min(1),
  capability: z.enum(["read", "read-write"]),
  /** 相对工作区的路径；工作区外的单文件授权取文件名 */
  relativePath: z.string(),
  sourceName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().nonnegative(),
  sha256: z.string(),
  /** 绝对过期时刻（Unix ms），访问即滑动续期 */
  expiresAt: z.number(),
});
export type AttachmentDescriptor = z.infer<typeof attachmentDescriptorSchema>;

export const attachmentCreateRequestSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1),
  capability: z.enum(["read", "read-write"]).optional(),
});

// ---------------------------------------------------------------- 变更集

/**
 * 一条变更的状态。
 *
 * `unverified` 不是「有点可疑」而是「我们没能在工具动手之前拿到 before
 * 快照」——对这种条目做一键接受，等于用一份来历不明的内容盖掉磁盘上
 * 真实存在的东西，因此它在批量路径上被硬跳过。
 */
export const changesetStatusSchema = z.enum([
  "pending",
  "applied",
  "rejected",
  "unverified",
  "conflict",
]);
export type ChangesetStatus = z.infer<typeof changesetStatusSchema>;

export const changesetKindSchema = z.enum(["write", "edit", "delete"]);
export type ChangesetKind = z.infer<typeof changesetKindSchema>;

export const changesetEntrySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string(),
  turnId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  kind: changesetKindSchema,
  relativePath: z.string(),
  beforeSha256: z.string(),
  afterSha256: z.string(),
  status: changesetStatusSchema,
  createdAt: z.number(),
  sizeBytes: z.number().nonnegative(),
  /** 二进制或过大：UI 只显示摘要，不渲染 diff */
  binary: z.boolean(),
  tooLarge: z.boolean(),
});
export type ChangesetEntry = z.infer<typeof changesetEntrySchema>;

/** 逐行 diff 的一段。UI 的 hunk 级接受/拒绝按它切。 */
export const changesetHunkSchema = z.object({
  index: z.number().int().nonnegative(),
  beforeStart: z.number().int().nonnegative(),
  beforeLines: z.array(z.string()),
  afterStart: z.number().int().nonnegative(),
  afterLines: z.array(z.string()),
});
export type ChangesetHunk = z.infer<typeof changesetHunkSchema>;

export const changesetDiffSchema = z.object({
  id: z.string(),
  relativePath: z.string(),
  hunks: z.array(changesetHunkSchema),
  /** 降级原因（二进制 / 超大），非空时 hunks 为空数组 */
  degraded: z.string().nullable(),
});
export type ChangesetDiff = z.infer<typeof changesetDiffSchema>;

export const changesetQueryRequestSchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().optional(),
  status: changesetStatusSchema.optional(),
  limit: z.number().int().positive().optional(),
});

export const changesetQueryResultSchema = z.object({
  entries: z.array(changesetEntrySchema),
  diffs: z.array(changesetDiffSchema),
});
export type ChangesetQueryResult = z.infer<typeof changesetQueryResultSchema>;

export const changesetIdRequestSchema = z.object({
  id: z.string().min(1),
  /** 只接受这几段 hunk；不传 = 整文件 */
  hunkIndexes: z.array(z.number().int().nonnegative()).optional(),
});

export const changesetBatchRequestSchema = z.object({
  ids: z.array(z.string().min(1)),
});

/**
 * 接受 / 拒绝的结果。
 *
 * 四种「没做成」是分开的，因为用户要做的下一步完全不同：
 *   conflict            → 文件在审阅期间被外部改了，去看三方比较
 *   alreadyApplied      → 这条已经生效过，重复点击不会再写一次
 *   requiresManualReview→ before 快照缺失，必须人工看过才能落盘
 *   errorCode           → 权限 / 磁盘之类的真实故障
 */
export const changesetApplyResultSchema = z.object({
  ok: z.boolean(),
  conflict: z.boolean().optional(),
  alreadyApplied: z.boolean().optional(),
  requiresManualReview: z.boolean().optional(),
  current: fileCurrentStateSchema.optional(),
  errorCode: fileErrorCodeSchema.optional(),
  message: z.string().optional(),
});
export type ChangesetApplyResult = z.infer<typeof changesetApplyResultSchema>;

export const changesetBatchResultSchema = z.object({
  applied: z.array(z.string()),
  /** 被硬跳过的 unverified 条目 —— 必须显式列出，不能静默吞掉 */
  skippedUnverified: z.array(z.string()),
  conflicted: z.array(z.string()),
  failed: z.array(z.string()),
});
export type ChangesetBatchResult = z.infer<typeof changesetBatchResultSchema>;

/** 文件树增量事件（push 通道 workspace:tree-event 的载荷）。 */
export const workspaceTreeEventSchema = z.object({
  workspaceId: z.string(),
  relativePath: z.string(),
});
export type WorkspaceTreeEvent = z.infer<typeof workspaceTreeEventSchema>;

// ---------- 通道契约分片（ADR-0002：各分片各自声明，宿主合并时封口） ----------
//
// 拆成两片而不是一片：workspace-files 与 workspace-review 在能力包架构里是
// 两个可以分别启用的能力，通道声明从现在起就按那个边界分开。
export const workspaceFilesContractShard = defineContractShard("workspace-files", {
  [CHANNELS.workspaceTreeList]: {
    request: treeListRequestSchema,
    response: fileTreePageSchema,
  },
  [CHANNELS.workspaceTreeWatch]: {
    request: treeWatchRequestSchema,
    response: z.void(),
  },
  [CHANNELS.workspaceSearch]: {
    request: workspaceSearchRequestSchema,
    response: workspaceSearchPageSchema,
  },
  [CHANNELS.workspaceSearchCancel]: {
    request: workspaceSearchCancelSchema,
    response: z.void(),
  },
  [CHANNELS.workspaceFileRead]: {
    request: fileReadRequestSchema,
    response: fileReadResultSchema,
  },
  [CHANNELS.workspaceFileSave]: {
    request: fileSaveRequestSchema,
    response: fileSaveResultSchema,
  },
  [CHANNELS.workspaceFileMutate]: {
    request: fileMutateRequestSchema,
    response: fileMutateResultSchema,
  },
  [CHANNELS.workspaceAttachmentCreate]: {
    request: attachmentCreateRequestSchema,
    response: attachmentDescriptorSchema,
  },
  [CHANNELS.workspaceRelease]: {
    request: workspaceReleaseRequestSchema,
    response: z.void(),
  },
});

// 接受一条变更是**唯一**会由渲染进程触发的、对用户文件的写入，因此四条
// 通道一律只收不透明的 changeset id。
export const changesetContractShard = defineContractShard("workspace-review", {
  [CHANNELS.changesetQuery]: {
    request: changesetQueryRequestSchema,
    response: changesetQueryResultSchema,
  },
  [CHANNELS.changesetAccept]: {
    request: changesetIdRequestSchema,
    response: changesetApplyResultSchema,
  },
  [CHANNELS.changesetReject]: {
    request: changesetIdRequestSchema,
    response: changesetApplyResultSchema,
  },
  [CHANNELS.changesetAcceptBatch]: {
    request: changesetBatchRequestSchema,
    response: changesetBatchResultSchema,
  },
});
