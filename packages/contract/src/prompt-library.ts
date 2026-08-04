/**
 * 预置办公提示词库的契约（common.prompt-library，REQ-0001 R1）。
 *
 * ## 数据形态在回答什么
 *
 * 库里的一条 = pi 用户级 prompts 目录（`~/.pi/agent/prompts/`）下的一个 .md
 * 文件（pi 原生 prompt template 格式：YAML frontmatter + Markdown 正文，
 * 文件名即 `/命令名`，见 pi docs/prompt-templates.md）。本契约不发明私有
 * 存储 —— PiBuddy 界面上看到的每一条，pi 在终端里 `/名字` 同样能展开。
 *
 * ## 预置与用户自建的边界
 *
 * 预置条目由应用随包分发、首启动物化，frontmatter 带 `pibuddy-preset`
 * 归属标记（版本号）。契约层用 `preset: boolean` 表达这条边界：预置项
 * 可隐藏（hidden）不可删不可改；用户项可增删改。收藏（favorite）与隐藏
 * 是 PiBuddy 自己的偏好，存在应用侧，不写进 .md 文件 —— 那个文件是 pi 的
 * 资源，往里塞界面状态等于让「收藏」污染 pi 的加载面。
 */
import { z } from "zod";

import { defineContractShard, voidRequestSchema } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

/**
 * 五个预置分类 + 用户自建的 `custom`。
 *
 * 是枚举而不是自由字符串：分类是界面上的分组骨架，自由字符串意味着一个
 * 拼错的分类表现为「这一条就是不出现在任何分组里」，没有任何报错。
 */
export const PROMPT_CATEGORIES = [
  "email",
  "data",
  "summary",
  "translate",
  "report",
  "custom",
] as const;
export const promptCategorySchema = z.enum(PROMPT_CATEGORIES);
export type PromptCategory = z.infer<typeof promptCategorySchema>;

/** 分类的中文显示名（渲染侧直接用，避免两处各写一份对照表）。 */
export const PROMPT_CATEGORY_LABELS: Record<PromptCategory, string> = {
  email: "公文 / 邮件写作",
  data: "表格与数据整理",
  summary: "长文总结",
  translate: "中英互译",
  report: "汇报大纲",
  custom: "我的提示词",
};

/**
 * 一条提示词。
 *
 * `id` 是不透明标识（主进程按文件路径散列），`name` 是 pi 的命令名
 * （文件名去 .md，`/name` 可展开）。`content` 是模板正文全文 —— 「一键填入
 * 输入框」在渲染侧就是把它写进 composer，不再发第二条通道。
 */
export const promptEntrySchema = z
  .object({
    id: z.string(),
    /** pi 命令名 = 文件名去 .md；`/名字` 在 pi 里展开本条 */
    name: z.string(),
    /** 界面显示的中文标题（frontmatter 的 pibuddy-title；缺失退回 name） */
    title: z.string(),
    /** frontmatter 的 description（pi 的 autocomplete 也读它） */
    description: z.string(),
    category: promptCategorySchema,
    /** 模板正文（不含 frontmatter） */
    content: z.string(),
    /** 是否预置条目（带 pibuddy-preset 归属标记）。预置可隐藏不可删不可改 */
    preset: z.boolean(),
    /** 预置版本号；用户条目为 null */
    presetVersion: z.number().int().nonnegative().nullable(),
    favorite: z.boolean(),
    /** 用户把预置条目从列表里藏起来（文件不动，pi 照常可用） */
    hidden: z.boolean(),
  })
  .strict();
export type PromptEntry = z.infer<typeof promptEntrySchema>;

/**
 * 整库快照。六条通道全部以它为返回：任何一次改动之后渲染进程立刻拿到
 * 权威列表，不必自己推断库变成了什么样（与 pi-resources 的 scan 同一口径）。
 */
export const promptLibraryListResultSchema = z
  .object({
    entries: z.array(promptEntrySchema),
    /** 扫描 / 物化过程中折进来的中文错误说明（不抛异常，见 resource-scanner 惯例） */
    errors: z.array(z.string()),
  })
  .strict();
export type PromptLibraryListResult = z.infer<typeof promptLibraryListResultSchema>;

/** 新建用户提示词。文件名由主进程生成（不收任何路径 / 文件名形参）。 */
export const promptCreateRequestSchema = z
  .object({
    title: z.string().min(1).max(80),
    description: z.string().max(200).default(""),
    category: promptCategorySchema,
    content: z.string().min(1).max(20_000),
  })
  .strict();
export type PromptCreateRequest = z.infer<typeof promptCreateRequestSchema>;

/** 编辑用户提示词（预置项主进程直接拒绝）。 */
export const promptUpdateRequestSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(80).optional(),
    description: z.string().max(200).optional(),
    category: promptCategorySchema.optional(),
    content: z.string().min(1).max(20_000).optional(),
  })
  .strict();
export type PromptUpdateRequest = z.infer<typeof promptUpdateRequestSchema>;

export const promptIdRequestSchema = z.object({ id: z.string().min(1) }).strict();
export type PromptIdRequest = z.infer<typeof promptIdRequestSchema>;

export const promptSetFavoriteRequestSchema = z
  .object({ id: z.string().min(1), favorite: z.boolean() })
  .strict();
export type PromptSetFavoriteRequest = z.infer<typeof promptSetFavoriteRequestSchema>;

export const promptSetHiddenRequestSchema = z
  .object({ id: z.string().min(1), hidden: z.boolean() })
  .strict();
export type PromptSetHiddenRequest = z.infer<typeof promptSetHiddenRequestSchema>;

/**
 * 通道契约分片。
 *
 * 分片 id 恒为 capabilityId 的第二段（`common.prompt-library` → `prompt-library`）：
 * drift test 据它把「manifest 声明的通道」与「分片声明的契约键」对账。
 */
export const promptLibraryContractShard = defineContractShard("prompt-library", {
  [CHANNELS.promptLibraryList]: {
    request: voidRequestSchema,
    response: promptLibraryListResultSchema,
  },
  [CHANNELS.promptLibraryCreate]: {
    request: promptCreateRequestSchema,
    response: promptLibraryListResultSchema,
  },
  [CHANNELS.promptLibraryUpdate]: {
    request: promptUpdateRequestSchema,
    response: promptLibraryListResultSchema,
  },
  [CHANNELS.promptLibraryDelete]: {
    request: promptIdRequestSchema,
    response: promptLibraryListResultSchema,
  },
  [CHANNELS.promptLibrarySetFavorite]: {
    request: promptSetFavoriteRequestSchema,
    response: promptLibraryListResultSchema,
  },
  [CHANNELS.promptLibrarySetHidden]: {
    request: promptSetHiddenRequestSchema,
    response: promptLibraryListResultSchema,
  },
});
