/**
 * 家居自动化规则面板的渲染侧状态（home.automation / 智能家居 Phase B）。
 *
 * ## 这个 store 只做三件事
 *
 * 规则快照的读取缓存、启停、删除。**没有**编辑器状态：v1 的规则创建与修改
 * 走会话里的 manage_rule 工具（面板只给一句引导话术）。每个动作的返回都是
 * 主进程的权威快照，store 原样收下，不自己推断列表变成了什么样。
 */
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { AutomationRule } from "@contract";

export const useHomeAutomationStore = defineStore("homeAutomation", () => {
  const rules = shallowRef<AutomationRule[]>([]);
  const loading = ref(false);
  const busyRuleId = ref("");
  const lastError = ref("");

  async function refresh(workspaceId: string): Promise<void> {
    loading.value = true;
    try {
      const result = await window.piBuddy.homeAutomation.rulesList(workspaceId);
      rules.value = result.rules;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<void> {
    busyRuleId.value = id;
    try {
      const result = await window.piBuddy.homeAutomation.ruleSetEnabled(workspaceId, id, enabled);
      rules.value = result.rules;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      busyRuleId.value = "";
    }
  }

  async function remove(workspaceId: string, id: string): Promise<void> {
    busyRuleId.value = id;
    try {
      const result = await window.piBuddy.homeAutomation.ruleDelete(workspaceId, id);
      rules.value = result.rules;
      lastError.value = "";
    } catch (err) {
      lastError.value = (err as Error).message;
    } finally {
      busyRuleId.value = "";
    }
  }

  return { rules, loading, busyRuleId, lastError, refresh, setEnabled, remove };
});
