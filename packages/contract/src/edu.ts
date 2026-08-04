/**
 * 儿童教育能力包的契约（REQ-0001 R3 / edu.kids，首个真内容垂直包）。
 *
 * ## 这个文件在回答什么
 *
 * `edu.kids` 对外声明的三条窄通道：读/写孩子档案、读工作区错题本。它是
 * 「装了货」的垂直包样板（prompts / skills / 回路内工具 / UI 四件齐），但
 * IPC 面刻意收得很小——出题在 pi 回路内（`edu.kids.math_worksheet`
 * extension，代码保证算术正确），讲解与复习卷生成归 prompts / skills
 * （模型侧）。**出题判分走代码保真，讲解归因走模型**是本包的核心设计原则，
 * IPC 面上因此没有任何「生成题目」「批改」通道。
 *
 * ## 为什么错题本入参没有路径字段
 *
 * 错题本文件的位置是一条**三方共同钉死的约定**（EDU_MISTAKE_FILE_RELATIVE）：
 * SKILL.md（agent 往里写）、主进程（面板从里读）、学习面板（展示）都指同
 * 一个工作区相对路径。渲染进程只发 workspaceId，表达不出「读任意文件」——
 * 与 terminal 无 cwd/argv、git 无 argv 是同一条结构性手法。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

export const EDU_CAPABILITY_ID = "edu.kids";

/**
 * 错题本的工作区相对路径（posix）。
 *
 * skills/edu-mistake-book/SKILL.md 的数据文件约定、主进程 edu-ipc 的读取、
 * 学习面板的展示，三方都以此为准。改这里必须同步改 SKILL.md 里的同名约定。
 */
export const EDU_MISTAKE_FILE_RELATIVE = "edu-kids/mistakes.jsonl";

// ---------------------------------------------------------------- 科目与档案

/** 四个科目（R3.1：英语 / 数学 / 语文 / 科学）。 */
export const EDU_SUBJECTS = ["english", "math", "chinese", "science"] as const;
export type EduSubjectId = (typeof EDU_SUBJECTS)[number];

/**
 * 孩子档案。按 workspaceId 分区落在能力自有数据目录（D4 规则 3），
 * 停用能力不动它（规则 5：卸载与删数据是两个动作）。
 */
export const eduProfileSchema = z
  .object({
    /** 称呼（可空，只用于生成提示词时的人称，不是账号） */
    childName: z.string().max(30),
    /** 年级 1-6（小学） */
    grade: z.number().int().min(1).max(6),
    /** 正在辅导的科目集合 */
    subjects: z.array(z.enum(EDU_SUBJECTS)).readonly(),
    /** 主进程写入时间戳（Unix ms），渲染进程只读 */
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type EduKidsProfile = z.infer<typeof eduProfileSchema>;

export const eduProfileGetRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();
export type EduProfileGetRequest = z.infer<typeof eduProfileGetRequestSchema>;

/** 整份替换语义；updatedAt 由主进程盖，入参写不出它。 */
export const eduProfileSetRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    childName: z.string().max(30),
    grade: z.number().int().min(1).max(6),
    subjects: z.array(z.enum(EDU_SUBJECTS)).max(EDU_SUBJECTS.length),
  })
  .strict();
export type EduProfileSetRequest = z.infer<typeof eduProfileSetRequestSchema>;

export const eduProfileResultSchema = z
  .object({ profile: eduProfileSchema.nullable() })
  .strict();
export type EduProfileResult = z.infer<typeof eduProfileResultSchema>;

// ---------------------------------------------------------------- 错题本

/**
 * 一条错题（读取侧的归一化视图）。
 *
 * 写入侧的字段约定在 skills/edu-mistake-book/SKILL.md；这里是**宽进严出**的
 * 另一半：主进程解析 JSONL 时坏行跳过、缺可选字段补 null，出 IPC 边界时
 * 恒为这个 strict 形状。
 */
export const eduMistakeEntrySchema = z
  .object({
    /** 记录日期（YYYY-MM-DD；原始数据非法时为空串） */
    date: z.string(),
    /** 科目（约定为 EDU_SUBJECTS 之一；历史数据的未知值原样保留） */
    subject: z.string(),
    /** 知识点（聚类键，如「三位数退位减法」） */
    topic: z.string(),
    /** 原题 */
    question: z.string(),
    /** 孩子的错误答案 */
    wrong: z.string().nullable(),
    /** 正确答案 */
    right: z.string().nullable(),
    /** 错因备注 */
    note: z.string().nullable(),
  })
  .strict();
export type EduMistakeEntry = z.infer<typeof eduMistakeEntrySchema>;

export const eduMistakeListRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** 返回条数上界（按日期取最近的）；错题本可能长年累积，响应必须有界 */
    limit: z.number().int().positive().max(500).default(200),
  })
  .strict();
export type EduMistakeListRequest = z.infer<typeof eduMistakeListRequestSchema>;

export const eduMistakeListResultSchema = z
  .object({
    /** 错题本文件是否存在（不存在不是错误：还没记过错题） */
    exists: z.boolean(),
    entries: z.array(eduMistakeEntrySchema),
    /** 被跳过的坏行数（JSON 解析失败或缺必填字段）。非零时面板提示、不报错 */
    skipped: z.number().int().nonnegative(),
    /** 文件里的有效错题总数（entries 只是其中最近的一段） */
    total: z.number().int().nonnegative(),
  })
  .strict();
export type EduMistakeListResult = z.infer<typeof eduMistakeListResultSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `edu.kids` 的全部三条通道。
 *
 * 分片 id 是 capabilityId 的第二段（`edu.kids` → `kids`），drift test 据此把
 * 「manifest 声明的通道」与「本分片的键集合」逐条对账。
 */
export const eduContractShard = defineContractShard("kids", {
  [CHANNELS.eduProfileGet]: {
    request: eduProfileGetRequestSchema,
    response: eduProfileResultSchema,
  },
  [CHANNELS.eduProfileSet]: {
    request: eduProfileSetRequestSchema,
    response: eduProfileResultSchema,
  },
  [CHANNELS.eduMistakeList]: {
    request: eduMistakeListRequestSchema,
    response: eduMistakeListResultSchema,
  },
});
