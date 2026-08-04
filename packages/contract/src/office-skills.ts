/**
 * 预置办公技能包的契约（common.office-skills，REQ-0001 R2）。
 *
 * ## 这个能力包是什么
 *
 * 第一个**内容型**能力包：它不带新的主进程动作面，带的是三个 pi 原生格式的
 * 技能（含 SKILL.md 的目录），随应用经 capability-assets 分发、由 R4 装卸
 * 机制在启用时物化到 `~/.pi/agent/skills/`、停用时收回。技能的执行者是 pi
 * agent 本身（`/skill:<name>` 命令），不是本应用的任何一条 IPC 通道。
 *
 * ## 为什么还是要有一条真通道
 *
 * 「纯 UI 空壳」是本仓的禁区：面板上写着「已预置三个技能」，而 pi 那边一个
 * 都没物化成功时，没有通道的面板只能继续骗人。`office-skills:list` 把
 * **声明**（包里带了哪些技能）与**事实**（归属账本里真的记了哪些文件）对到
 * 一起返回，面板显示的物化状态因此有一个可证伪的来源。
 *
 * ## 技能定义为什么钉在契约里
 *
 * 三个技能的 name / 标题 / 摘要要被三处使用：manifest 的 piResources 声明
 * （目录名）、主进程的状态通道（对账键）、渲染进程的卡片（展示）。抄三遍
 * 必然漂移，因此唯一定义点放在契约包——它是纯数据，三边都能 import。
 * `name` 同时就是 SKILL.md frontmatter 的 name 与 `/skill:<name>` 命令名，
 * 带 `office-` 前缀避免与用户已有技能撞名（pi 同名去重「先加载的赢」）。
 */
import { z } from "zod";

import { defineContractShard, voidRequestSchema } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

export const OFFICE_SKILLS_CAPABILITY_ID = "common.office-skills";

/** 一个预置技能的静态定义（唯一定义点，三边共享）。 */
export interface OfficeSkillDefinition {
  /** pi 技能名 = SKILL.md frontmatter name = 目录名 = /skill:<name> 命令名 */
  readonly name: string;
  /** 卡片标题 */
  readonly title: string;
  /** 一句话摘要（卡片副标题） */
  readonly summary: string;
  /** 面向办公用户的用法提示：对 agent 说什么就能用起来 */
  readonly usageHint: string;
}

/**
 * 三个预置办公技能（REQ-0001 R2.1）。
 *
 * 顺序即面板展示顺序。manifest 的 `piResources.skills` 由它派生
 * （`skills/<name>`），资源目录树在
 * `packages/app/resources/capability-assets/common.office-skills/skills/` 下。
 */
export const OFFICE_SKILLS: readonly OfficeSkillDefinition[] = [
  {
    name: "office-file-organize",
    title: "文件批量整理",
    summary: "按日期 / 类型 / 关键词给一批文件归类、批量重命名，先预览清单再动手，绝不静默覆盖。",
    usageHint: "对我说：「用文件整理技能，把下载文件夹里的图片按月份归档」",
  },
  {
    name: "office-table-clean",
    title: "表格数据处理",
    summary: "CSV 表格去重、筛选、透视汇总与导出；Excel 文件先转成 CSV 再处理（附转换办法）。",
    usageHint: "对我说：「用表格处理技能，把 客户.csv 按手机号去重后汇总各城市人数」",
  },
  {
    name: "office-doc-convert",
    title: "文档格式转换",
    summary: "Markdown、Word、PDF 之间的格式转换：装了 pandoc 就全能，没装也有纯 Node 降级路线。",
    usageHint: "对我说：「用文档转换技能，把 会议纪要.md 转成 PDF」",
  },
];

// ---------------------------------------------------------------- 状态通道

/**
 * 一个技能的运行时状态：静态定义 + 物化事实。
 *
 * `materialized` 的判据是**归属账本**（~/.pi/agent/pibuddy-assets.json）里
 * 本包名下是否记着该技能的 SKILL.md——账本是 R4 物化器唯一的归属真相源，
 * 面板不自己发明第二套判断。没有任何路径字段：渲染进程不需要、也不该知道
 * 技能落在磁盘哪里。
 */
export const officeSkillStatusSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    summary: z.string(),
    usageHint: z.string(),
    /** 在会话里触发它的命令形态 */
    command: z.string(),
    /** 归属账本里记着该技能的 SKILL.md（= R4 已物化到 ~/.pi/agent/skills/） */
    materialized: z.boolean(),
    /** 账本里本技能名下的文件数（SKILL.md + 辅助脚本 / 参考文件） */
    fileCount: z.number().int().nonnegative(),
  })
  .strict();
export type OfficeSkillStatus = z.infer<typeof officeSkillStatusSchema>;

export const officeSkillsStateSchema = z
  .object({
    packId: z.string(),
    packVersion: z.string(),
    /**
     * 归属账本是否存在且可解析。false 时所有 materialized 一律 false——
     * 「账本还没建」（首次启动对账尚未跑）与「物化失败」在面板上都表现为
     * 「待重启物化」，而不是假装已就绪。
     */
    ledgerFound: z.boolean(),
    skills: z.array(officeSkillStatusSchema),
  })
  .strict();
export type OfficeSkillsState = z.infer<typeof officeSkillsStateSchema>;

/**
 * 通道契约分片。分片 id 恒为 capabilityId 的第二段
 * （`common.office-skills` → `office-skills`），drift test 据它对账。
 */
export const officeSkillsContractShard = defineContractShard("office-skills", {
  [CHANNELS.officeSkillsList]: {
    request: voidRequestSchema,
    response: officeSkillsStateSchema,
  },
});
