/**
 * 智能家居场景/联动建议包的契约（home.advisor，智能家居四包之四）。
 *
 * ## 这个能力包是什么
 *
 * 家居四包（assistant 基座 / automation / dashboard / advisor）里**最轻**的
 * 一个：纯 skill 内容包。载荷是两个 pi 技能目录（场景建议、能耗回顾），随
 * 应用经 capability-assets 分发、由 R4 装卸机制启用时物化到
 * `~/.pi/agent/skills/`、停用时收回。上下文成本是 skill 的渐进披露：仅
 * name + description 常驻，正文按需加载——它不带任何 extension tool schema，
 * 因此每轮请求的工具面零增量。
 *
 * ## 为什么 dependencies 是 home.assistant
 *
 * 两个技能的操作规程都以基座的三个工具（home_list_entities / home_get_state /
 * home_call_service）为前提：没有基座,技能文本就是一纸空谈。依赖走装配期
 * 不动点拒绝（capability-registry.resolve）：基座未启用/未注册时本包拒绝
 * 启用并给出可读原因,零运行期降级代码。
 *
 * ## 为什么还是要有一条真通道
 *
 * 「纯 UI / 纯资源空壳」是本仓的禁区（与 common.office-skills 同一条铁律）：
 * 面板上写着「已预置两个建议技能」,而 pi 那边一个都没物化成功时,没有通道的
 * 面板只能继续骗人。`advisor:skills-status` 把**声明**（包里带了哪些技能）与
 * **事实**（R4 归属账本里真的记了哪些文件）对到一起返回,面板显示的物化状态
 * 因此有一个可证伪的来源。
 *
 * ## 技能定义为什么钉在契约里
 *
 * 与 OFFICE_SKILLS 同一手法：name / 标题 / 摘要被 manifest（目录名派生）、
 * 状态通道（对账键）、面板（展示）三处使用,唯一定义点放契约,抄三遍必漂移。
 * `name` 同时是 SKILL.md frontmatter 的 name 与目录名,带 `home-` 前缀避免
 * 与用户已有技能撞名（pi 同名去重「先加载的赢」）。
 */
import { z } from "zod";

import { defineContractShard, voidRequestSchema } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";

export const HOME_ADVISOR_CAPABILITY_ID = "home.advisor";

/** 一个预置建议技能的静态定义（唯一定义点,三边共享）。 */
export interface HomeAdvisorSkillDefinition {
  /** pi 技能名 = SKILL.md frontmatter name = 目录名 */
  readonly name: string;
  /** 卡片标题 */
  readonly title: string;
  /** 一句话摘要（卡片副标题） */
  readonly summary: string;
  /** 面向家居用户的用法提示：对 agent 说什么就能用起来 */
  readonly usageHint: string;
}

/**
 * 两个预置建议技能。
 *
 * 顺序即面板展示顺序。manifest 的 `piResources.skills` 由它派生
 * （`skills/<name>`），资源目录树在
 * `packages/app/resources/capability-assets/home.advisor/skills/` 下。
 */
export const HOME_ADVISOR_SKILLS: readonly HomeAdvisorSkillDefinition[] = [
  {
    name: "home-scene-advisor",
    title: "场景与联动建议",
    summary:
      "盘点全屋设备 + 作息访谈，推理适合你家的场景与联动（离家/回家/睡前/观影等），" +
      "每条建议给出触发条件、动作序列与风险提示；经你确认后才落地成自动化规则。",
    usageHint: "对我说：「帮我看看家里的设备能配点什么自动化场景」",
  },
  {
    name: "home-energy-review",
    title: "能耗与使用习惯回顾",
    summary:
      "找出带功率/电量数据的设备，按房间与类型归纳，识别常开设备与待机耗电，" +
      "产出可读的节能建议清单（估算值明确标注为估算）。",
    usageHint: "对我说：「帮我看看家里哪些电器最耗电，有什么省电建议」",
  },
];

// ---------------------------------------------------------------- 状态通道

/**
 * 一个技能的运行时状态：静态定义 + 物化事实。
 *
 * `materialized` 的判据是**归属账本**（~/.pi/agent/pibuddy-assets.json）里
 * 本包名下是否记着该技能的 SKILL.md——账本是 R4 物化器唯一的归属真相源,
 * 面板不自己发明第二套判断。没有任何路径字段：渲染进程不需要、也不该知道
 * 技能落在磁盘哪里。
 */
export const advisorSkillStatusSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    summary: z.string(),
    usageHint: z.string(),
    /** 归属账本里记着该技能的 SKILL.md（= R4 已物化到 ~/.pi/agent/skills/） */
    materialized: z.boolean(),
    /** 账本里本技能名下的文件数（SKILL.md + 参考文件） */
    fileCount: z.number().int().nonnegative(),
  })
  .strict();
export type AdvisorSkillStatus = z.infer<typeof advisorSkillStatusSchema>;

export const homeAdvisorStateSchema = z
  .object({
    packId: z.string(),
    packVersion: z.string(),
    /**
     * 归属账本是否存在且可解析。false 时所有 materialized 一律 false——
     * 「账本还没建」与「物化失败」在面板上都表现为「待重启物化」,
     * 而不是假装已就绪。
     */
    ledgerFound: z.boolean(),
    skills: z.array(advisorSkillStatusSchema),
  })
  .strict();
export type HomeAdvisorState = z.infer<typeof homeAdvisorStateSchema>;

/**
 * 通道契约分片。分片 id 恒为 capabilityId 的第二段
 * （`home.advisor` → `advisor`），drift test 据它对账。
 */
export const homeAdvisorContractShard = defineContractShard("advisor", {
  [CHANNELS.advisorSkillsStatus]: {
    request: voidRequestSchema,
    response: homeAdvisorStateSchema,
  },
});
