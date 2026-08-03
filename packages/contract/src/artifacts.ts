/**
 * Artifact 仓库的契约（ART-102）。
 *
 * ## 为什么消息里存的是 artifactId + version 而不是路径
 *
 * 路径是易失的：用户重命名一次、Agent 再生成一版、文件被拖到别的目录，
 * 历史消息里那条链接就指向了不存在的东西（或者更糟 —— 指向了同名的
 * **另一个**文件）。artifactId + version 是不变量：文件挪到哪里，
 * artifacts 表里的那一行都还在，链接照样解析得到当时那一版。
 *
 * ## 为什么 status 里有 conflicted
 *
 * 「Agent 写了个文件，用户在外面又用 Excel 改了一遍」是每天都会发生的
 * 事。没有 conflicted 的话，这种情况只能被记成 ready（于是我们对外
 * 宣称的 sha256 是假的）或者 failed（于是用户以为文件没了）。
 */
import { z } from "zod";

/** 产物的内容类别。与 PreviewKind 刻意分开：那个是「怎么渲染」，这个是「是什么」。 */
export const artifactKindSchema = z.enum([
  "document",
  "spreadsheet",
  "presentation",
  "pdf",
  "image",
  "media",
  "data",
  "code",
  "text",
  "other",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/**
 * 产物状态机。
 *
 *   generating  工具开始跑了，文件还没写完 —— UI 显示转圈而不是一个死链
 *   ready       写完了，sha256 与磁盘一致
 *   failed      工具失败了。**原始文件（如果有）保留**，仍可导出
 *   conflicted  磁盘上的内容与记录的 sha256 不符（被外部改过）
 *   trashed     软删除。只写 status 与 deleted_at，磁盘文件一个字节不动
 */
export const artifactStatusSchema = z.enum([
  "generating",
  "ready",
  "failed",
  "conflicted",
  "trashed",
]);
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;

/**
 * 一条产物记录的渲染侧视图。
 *
 * 不含任何绝对路径：`exportPath` 与 `previewPath` 是**相对工作区**的
 * 路径，与 FS-101 全域口径一致。真实位置只活在主进程。
 */
export const artifactRecordSchema = z.object({
  id: z.string().min(1),
  /** 同一逻辑产物跨版本恒定的键（通常是相对路径），版本链靠它串起来 */
  logicalKey: z.string(),
  name: z.string(),
  kind: artifactKindSchema,
  sourceSessionId: z.string().nullable(),
  sourceTurnId: z.string().nullable(),
  sourceToolCallId: z.string().nullable(),
  workspaceId: z.string(),
  /** 从 1 开始递增。二次生成是 +1 而不是覆盖 */
  version: z.number().int().positive(),
  sha256: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 转换缓存（相对工作区或临时目录内的名字）；没有则为 null */
  previewPath: z.string().nullable(),
  /** 原始文件相对工作区的路径 */
  exportPath: z.string(),
  status: artifactStatusSchema,
  deletedAt: z.number().nullable(),
  sizeBytes: z.number().nonnegative(),
});
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export const artifactQueryRequestSchema = z.object({
  workspaceId: z.string().min(1),
  /** 名字 / 相对路径的子串匹配，大小写不敏感 */
  query: z.string().optional(),
  kind: artifactKindSchema.optional(),
  status: artifactStatusSchema.optional(),
  sessionId: z.string().optional(),
  /** true = 只看回收站；false / 不传 = 只看未删除的 */
  trashed: z.boolean().optional(),
  /** 只取每个 logicalKey 的最新一版（产物库默认视图） */
  latestOnly: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

export const artifactQueryResultSchema = z.object({
  items: z.array(artifactRecordSchema),
  total: z.number().int().nonnegative(),
});
export type ArtifactQueryResult = z.infer<typeof artifactQueryResultSchema>;

/** 按 id 定位一条产物。rename 之外的全部单条动作共用它。 */
export const artifactIdRequestSchema = z.object({
  id: z.string().min(1),
});

export const artifactRenameRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(255),
});

/** 单条动作的统一返回：权威快照 + 失败原因。 */
export const artifactMutationResultSchema = z.object({
  ok: z.boolean(),
  record: artifactRecordSchema.nullable(),
  message: z.string().optional(),
});
export type ArtifactMutationResult = z.infer<typeof artifactMutationResultSchema>;

/** 导出结果：只回相对路径与字节数，落盘位置由主进程的保存对话框决定。 */
export const artifactExportResultSchema = z.object({
  ok: z.boolean(),
  /** 用户取消保存对话框时为 null */
  savedName: z.string().nullable(),
  sizeBytes: z.number().nonnegative(),
  message: z.string().optional(),
});
export type ArtifactExportResult = z.infer<typeof artifactExportResultSchema>;

export const artifactCompareRequestSchema = z.object({
  id: z.string().min(1),
  otherId: z.string().min(1),
});

/**
 * 两版之间的比较结果。
 *
 * `identical` 由 sha256 判定而不是由文本 diff 判定：二进制产物（xlsx、
 * 图片）根本没有可比的文本，但「这两版是不是同一个东西」仍然必须回答。
 */
export const artifactComparisonSchema = z.object({
  left: artifactRecordSchema,
  right: artifactRecordSchema,
  identical: z.boolean(),
  sizeDelta: z.number(),
  /** 两版都能抽出文本时给出的逐行差异摘要；否则为空数组 */
  textDiff: z.array(
    z.object({
      op: z.enum(["add", "remove"]),
      line: z.number().int().nonnegative(),
      text: z.string(),
    })
  ),
  /** 无法做文本比较时的原因（二进制 / 过大）；可比时为 null */
  degraded: z.string().nullable(),
});
export type ArtifactComparison = z.infer<typeof artifactComparisonSchema>;

/**
 * 消息里的一条产物链接（ART-102 的核心不变量）。
 *
 * 只有 id + version + 显示名。**没有路径字段** —— 于是「消息里存了个
 * 会失效的路径」在结构上表达不出来。
 */
export const artifactLinkSchema = z.object({
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string(),
});
export type ArtifactLink = z.infer<typeof artifactLinkSchema>;
