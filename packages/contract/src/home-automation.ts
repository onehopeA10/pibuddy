/**
 * 智能家居自动化规则包的契约（home.automation / vertical tier，智能家居 Phase B）。
 *
 * ## 这个文件在回答什么
 *
 * 「一条自动化规则对外声明了什么」——触发器（实体状态 / 每日墙钟时间）、
 * 可选条件（实体状态比较 / 时间窗）、动作序列（service call / 通知 / Agent），
 * 以及面板用的四条窄通道与回路内工具 manage_rule 的入参形态。声明是纯数据：
 * 可校验、可 diff、可 grep。
 *
 * ## 规则 ≠ 特殊 task（两条执行路）
 *
 * 确定性动作（开关灯 / 通知）由主进程侧轻量 rule-engine 直接经 home.assistant
 * 基座的受控出站执行——**不为开一盏灯起 Agent run**。Agent 动作落成 tasks 域
 * `kind:"event"` 的真 task（schedule.ts 的现成语义位），由规则命中时投递，
 * misfire / 预算 / 审计全继承 tasks，不重造。
 *
 * ## 时间语义整体借自 tasks
 *
 * time 触发存的是墙钟 `HH:MM` + IANA 时区（WALL_TIME_RE 与 tasks 同一条正则），
 * 下一次绝对时刻由 tasks 的纯模块 `schedule.ts`（computeNextRun 的 daily 分支）
 * 解出——DST gap / overlap 的策略因此与定时任务逐字一致，不另立一套。
 */
import { z } from "zod";

import { defineContractShard } from "./channel-contract.js";
import { CHANNELS } from "./channels.js";
import { HA_SERVICE_IDENT_RE } from "./home-assistant.js";
import { WALL_TIME_RE } from "./tasks.js";

export const HOME_AUTOMATION_CAPABILITY_ID = "home.automation";

// ---------------------------------------------------------------- 回路内工具

/**
 * 唯一常驻工具（上下文预算：整个自动化面 = 1 个工具 schema）。名字带
 * capabilityId 前缀是 manifest 校验的硬性要求（D4 规则 6）；extension
 * （capability-assets/home.automation/extensions/automation-tools.ts）与
 * manifest.tools 的声明必须逐字一致，一致性由 home-automation-e2e.spec 对账。
 */
export const AUTOMATION_TOOL_MANAGE_RULE = "home.automation.manage_rule";

/** 单条规则的动作数上限（规则是轻量联动，不是工作流）。 */
export const AUTOMATION_MAX_ACTIONS = 10;

// ---------------------------------------------------------------- 触发 / 条件 / 动作

/**
 * 触发器：实体状态变化，或每日墙钟时间。
 *
 * state 触发的 from / to 都可省：都省 = 该实体任何一次状态变化都触发
 * （相同状态的重复事件由引擎去重，不算变化）。
 */
export const automationTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("state"),
      entityId: z.string().min(1).max(255),
      /** 旧状态须等于它（省略 = 不限） */
      from: z.string().max(255).optional(),
      /** 新状态须等于它（省略 = 不限） */
      to: z.string().max(255).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("time"),
      /** 每日墙钟时间 `HH:MM`（时区在规则上，DST 语义与 tasks 一致） */
      time: z.string().regex(WALL_TIME_RE),
    })
    .strict(),
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

/**
 * 条件（可选，恰一条）：实体状态比较，或墙钟时间窗。
 *
 * time_window 的 after > before 表示跨午夜窗口（22:00–06:00）；
 * after === before 表示空窗口（恒 false），不做「全天」的隐式解释。
 */
export const automationConditionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("state"),
      entityId: z.string().min(1).max(255),
      op: z.enum(["eq", "neq"]),
      value: z.string().max(255),
    })
    .strict(),
  z
    .object({
      kind: z.literal("time_window"),
      after: z.string().regex(WALL_TIME_RE),
      before: z.string().regex(WALL_TIME_RE),
    })
    .strict(),
]);
export type AutomationCondition = z.infer<typeof automationConditionSchema>;

/**
 * 动作。
 *
 * service / notify 是**确定性动作**：主进程 rule-engine 直接经基座
 * （home-service → safeLocalFetch 三道关，每次执行前重新过授权）执行；
 * notify 落成 HA 的 persistent_notification.create（同一条确定性出站路）。
 * agent 是 **Agent 动作**：落成 tasks 域 kind:"event" 的真 task，命中时投递。
 */
export const automationActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("service"),
      /** 与 call_service 工具同一条正则钉死形态（路径注入的结构性挡板） */
      domain: z.string().regex(HA_SERVICE_IDENT_RE),
      service: z.string().regex(HA_SERVICE_IDENT_RE),
      entityId: z.string().min(1).max(255).optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("notify"),
      message: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      /** 投递给后台 Agent run 的提示词（provider/model 用工作区默认） */
      prompt: z.string().min(1).max(4000),
    })
    .strict(),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

// ---------------------------------------------------------------- 规则

/** 建 / 改规则时用户可写的部分（id 与派生字段由主进程管）。 */
export const automationRuleSpecSchema = z
  .object({
    name: z.string().min(1).max(100),
    trigger: automationTriggerSchema,
    condition: automationConditionSchema.optional(),
    actions: z.array(automationActionSchema).min(1).max(AUTOMATION_MAX_ACTIONS),
    /** IANA 时区（time 触发与时间窗用）；省略 = 主进程取系统时区 */
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();
export type AutomationRuleSpec = z.infer<typeof automationRuleSpecSchema>;

/** 一条规则的完整记录（下发给渲染进程 / LLM 的形态）。 */
export const automationRuleSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    trigger: automationTriggerSchema,
    condition: automationConditionSchema.nullable(),
    actions: z.array(automationActionSchema).readonly(),
    timezone: z.string().min(1),
    /** 最近一次命中执行的时刻；从未触发为 null */
    lastFiredAt: z.number().int().nonnegative().nullable(),
    /** 最近一次执行的失败原因；成功 / 未触发为 null */
    lastError: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type AutomationRule = z.infer<typeof automationRuleSchema>;

/** 每个动作的返回都是权威快照（整表列表），与 providers / tasks 同一口径。 */
export const automationRulesResultSchema = z
  .object({ rules: z.array(automationRuleSchema) })
  .strict();
export type AutomationRulesResult = z.infer<typeof automationRulesResultSchema>;

// ---------------------------------------------------------------- 通道入参

export const automationRulesListRequestSchema = z
  .object({ workspaceId: z.string().min(1) })
  .strict();
export type AutomationRulesListRequest = z.infer<typeof automationRulesListRequestSchema>;

/** upsert：带 id = 整份替换该规则的 spec；不带 = 新建（默认启用）。 */
export const automationRuleUpsertRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    id: z.string().min(1).optional(),
    rule: automationRuleSpecSchema,
  })
  .strict();
export type AutomationRuleUpsertRequest = z.infer<typeof automationRuleUpsertRequestSchema>;

export const automationRuleIdRequestSchema = z
  .object({ workspaceId: z.string().min(1), id: z.string().min(1) })
  .strict();
export type AutomationRuleIdRequest = z.infer<typeof automationRuleIdRequestSchema>;

export const automationRuleSetEnabledRequestSchema = z
  .object({ workspaceId: z.string().min(1), id: z.string().min(1), enabled: z.boolean() })
  .strict();
export type AutomationRuleSetEnabledRequest = z.infer<
  typeof automationRuleSetEnabledRequestSchema
>;

// ---------------------------------------------------------------- manage_rule

/**
 * `home.automation.manage_rule` 的入参（bridge 侧二次校验用——bridge 收到的
 * 是 pi 子进程发来的任意 JSON）。
 *
 *   - list：无附加字段；
 *   - create：rule 必填；
 *   - update：rule_id + rule（整份替换 spec，enabled 不动）；
 *   - delete / enable / disable：rule_id 必填。
 *
 * 字段级约束（哪个动作要哪些字段）在主进程 handler 里判——zod 的
 * discriminatedUnion 按动作拆会让 schema 与 extension 的 typebox 声明彼此
 * 漂移，一个平坦对象两边好对账。
 */
export const manageRuleArgsSchema = z
  .object({
    action: z.enum(["list", "create", "update", "delete", "enable", "disable"]),
    rule_id: z.string().min(1).optional(),
    rule: automationRuleSpecSchema.optional(),
  })
  .strict();
export type ManageRuleArgs = z.infer<typeof manageRuleArgsSchema>;

// ---------------------------------------------------------------- 契约分片

/**
 * `home.automation` 的全部四条通道。
 *
 * 分片 id 是 capabilityId 的第二段（`home.automation` → `automation`），
 * drift test 据此把「manifest 声明的通道」与「本分片的键集合」逐条对账。
 * 面板只有列表 / 启停 / 删除（v1 不做复杂编辑器）；创建与修改走会话里的
 * manage_rule 工具，upsert 通道留给将来的表单编辑，与工具共用同一份 spec。
 */
export const homeAutomationContractShard = defineContractShard("automation", {
  [CHANNELS.autoRulesList]: {
    request: automationRulesListRequestSchema,
    response: automationRulesResultSchema,
  },
  [CHANNELS.autoRuleUpsert]: {
    request: automationRuleUpsertRequestSchema,
    response: automationRulesResultSchema,
  },
  [CHANNELS.autoRuleDelete]: {
    request: automationRuleIdRequestSchema,
    response: automationRulesResultSchema,
  },
  [CHANNELS.autoRuleSetEnabled]: {
    request: automationRuleSetEnabledRequestSchema,
    response: automationRulesResultSchema,
  },
});
