/**
 * 会话元信息的唯一定义。
 *
 * 收敛前此形状同时存在于 packages/app/src/main/sessions-store.ts:5-12 与
 * packages/app/src/preload/index.d.ts:19-26。
 */
import { z } from "zod";

export const sessionMetaSchema = z.object({
  /** 会话 jsonl 文件绝对路径 */
  path: z.string(),
  id: z.string(),
  name: z.string().optional(),
  firstMessage: z.string(),
  messageCount: z.number().int().nonnegative(),
  /** Unix ms */
  modified: z.number(),

  // ---- 以下字段为 M1 SessionRepository 预留，M0 阶段不填 ----
  /** 会话归属的工作目录（M1 起由 SessionRepository 反解） */
  cwd: z.string().optional(),
  /** 写入该会话的 pi 版本，用于跨版本兼容提示 */
  runtimeVersion: z.string().optional(),
  /** jsonl 解析失败时的原因；非空表示这是一条降级条目 */
  parseError: z.string().optional(),
});

export type SessionMeta = z.infer<typeof sessionMetaSchema>;

/** SessionRepository 对外的语义名；与 SessionMeta 同构。 */
export type SessionSummary = SessionMeta;

// ---------------------------------------------------------------- 会话中心

/** 会话在索引里的三种状态。回收站是「状态」而不是「删文件」。 */
export const sessionStatusSchema = z.enum(["active", "archived", "trashed"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * 会话列表行的**渲染侧视图**（SES-101）。
 *
 * 这里刻意**没有** sourcePath / workspaceRoot 两个字段：JSONL 文件的绝对
 * 路径与工作目录的真实路径都是主进程内部标识，跨进程一律换成不透明的
 * `sessionId`，由主进程经索引表反查回文件路径（CT-15 / 裁定3）。
 */
export const sessionRowSchema = z.object({
  /** 不透明会话标识（pi 写在 jsonl 头部 session 记录里的 id） */
  sessionId: z.string(),
  name: z.string().optional(),
  /** 首条用户消息的截断预览 */
  preview: z.string(),
  messageCount: z.number().int().nonnegative(),
  tokenTotal: z.number().int().nonnegative(),
  costTotal: z.number().nonnegative(),
  modelId: z.string().optional(),
  status: sessionStatusSchema,
  pinned: z.boolean(),
  unread: z.boolean(),
  /** 该会话当前是否有后台运行中的任务 */
  running: z.boolean(),
  /** 会话文件的最后修改时间（Unix ms），列表按它倒序 */
  modified: z.number(),
  /** 会话文件字节数；同时是「向前翻页」的初始 beforeOffset */
  sizeBytes: z.number().int().nonnegative(),
  /** 移入回收站的时间（Unix ms）；未在回收站时为空 */
  deletedAt: z.number().optional(),
});
export type SessionRow = z.infer<typeof sessionRowSchema>;

/**
 * sessions:query 的入参。
 *
 * 全部条件都是可选的：不带条件即「这个工作区的全部活动会话，置顶在前、
 * 按修改时间倒序」。
 */
export const sessionQuerySchema = z.object({
  workspaceId: z.string().min(1),
  /** 关键字：同时匹配 name / preview / 全文 blob */
  search: z.string().optional(),
  status: sessionStatusSchema.optional(),
  modelId: z.string().optional(),
  /** 修改时间下界（Unix ms，含） */
  from: z.number().optional(),
  /** 修改时间上界（Unix ms，含） */
  to: z.number().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type SessionQuery = z.infer<typeof sessionQuerySchema>;

/**
 * 输入区草稿（B02 消费）。
 *
 * 与会话一对一。`attachments` 为兼容既有存储形状保留，但新版本恒写空数组：
 * 附件 token 是短期 capability，不能作为 durable draft 恢复。`queue` 保留
 * 插话 / 追问两条队列的未发送文本。
 */
export const draftRecordSchema = z.object({
  text: z.string(),
  attachments: z.array(z.unknown()),
  queue: z.object({
    steering: z.array(z.string()),
    followUp: z.array(z.string()),
  }),
  updatedAt: z.number(),
});
export type DraftRecord = z.infer<typeof draftRecordSchema>;

/**
 * sessions:read-history 的入参（CT-15：四个键，一个都不能多 —— 而且**没有一个
 * 是路径**）。
 *
 * `beforeOffset` 是 JSONL 文件的**字节**上界，由上一页的 `nextBeforeOffset`
 * 递推；首屏用 `SessionRow.sizeBytes`。
 *
 * `workspaceId` 与 sessionId 成对出现：sessionId 不是全局唯一的（见
 * ipc-contract.ts 里 workspaceScoped 的注释），少了它就可能读到另一个工作区
 * 里同 id 的那份会话文件。
 */
export const readHistoryRequestSchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  beforeOffset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(500),
});
export type ReadHistoryRequest = z.infer<typeof readHistoryRequestSchema>;

/** 一条 JSONL 记录。pi 的 entry 类型是开放集合，未知 type 原样透传。 */
const sessionEntrySchema = z.object({ type: z.string() }).loose();

/**
 * 向前（更早历史）翻一页的结果。
 *
 * `stale` 为 true 表示索引记录的 mtime/size 与磁盘实际不符（会话在两次
 * 调用之间被追加了内容），调用方应先 syncWorkspace 再原样重试一次。
 */
export const sessionHistoryPageSchema = z.object({
  entries: z.array(sessionEntrySchema),
  /** 下一页的字节上界；为 null 表示已经到文件头 */
  nextBeforeOffset: z.number().int().nonnegative().nullable(),
  stale: z.boolean(),
  /** 被 beforeOffset 从中间截断、因而丢弃的半行数（0 或 1） */
  skippedPartial: z.number().int().nonnegative(),
});
export type SessionHistoryPage = z.infer<typeof sessionHistoryPageSchema>;

/** sessions:import-scan 只返回摘要，不带源文件路径。 */
export const sessionImportCandidateSchema = z.object({
  source: z.literal("pi"),
  externalId: z.string().min(1),
  title: z.string(),
  projectPath: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  updatedAt: z.number(),
  alreadyHere: z.boolean(),
});
export type SessionImportCandidate = z.infer<typeof sessionImportCandidateSchema>;

export const sessionImportScanRequestSchema = z.object({
  workspaceId: z.string().min(1),
});

export const sessionImportScanResultSchema = z.object({
  items: z.array(sessionImportCandidateSchema),
});
export type SessionImportScanResult = z.infer<typeof sessionImportScanResultSchema>;

export const sessionImportRunRequestSchema = z.object({
  workspaceId: z.string().min(1),
  externalIds: z.array(z.string().min(1)).max(100),
});

export const sessionImportRunResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type SessionImportRunResult = z.infer<typeof sessionImportRunResultSchema>;
