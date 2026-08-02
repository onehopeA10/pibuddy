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
