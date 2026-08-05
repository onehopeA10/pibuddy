/**
 * `window.piBuddy.homeAutomation`（home.automation / 智能家居 Phase B）。
 *
 * 四个方法、四条窄通道，全部返回权威快照（整表规则列表）。渲染进程能表达的
 * 极限是「读当前工作区的规则、整份替换一条 spec、启停、删除」——规则的
 * **执行**不在这里（确定性动作在主进程 rule-engine，Agent 动作在 tasks 域），
 * 规则的创建与修改主要走会话里的 manage_rule 工具（v1 面板不做编辑器）。
 *
 * CHANNELS 只能从 `@pibuddy/contract/channels` 引（不依赖 zod）。
 */
import { CHANNELS } from "@pibuddy/contract/channels";
import type { AutomationRuleSpec, AutomationRulesResult } from "@pibuddy/contract";
import { invoke } from "./bridge.js";

export const homeAutomation = {
  /** 读当前工作区的全部规则。 */
  rulesList: (workspaceId: string) =>
    invoke<AutomationRulesResult>(CHANNELS.autoRulesList, { workspaceId }),

  /** 建（不带 id）或整份替换（带 id）一条规则的 spec。 */
  ruleUpsert: (workspaceId: string, rule: AutomationRuleSpec, id?: string) =>
    invoke<AutomationRulesResult>(CHANNELS.autoRuleUpsert, {
      workspaceId,
      ...(id !== undefined ? { id } : {}),
      rule,
    }),

  /** 删除一条规则（连同它的 Agent 动作 backing task）。 */
  ruleDelete: (workspaceId: string, id: string) =>
    invoke<AutomationRulesResult>(CHANNELS.autoRuleDelete, { workspaceId, id }),

  /** 启用 / 停用一条规则。 */
  ruleSetEnabled: (workspaceId: string, id: string, enabled: boolean) =>
    invoke<AutomationRulesResult>(CHANNELS.autoRuleSetEnabled, { workspaceId, id, enabled }),
};
